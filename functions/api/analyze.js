/* AuditBeacon — free SEO / AEO / GEO page auditor (Pages Function)
   POST /api/analyze  { "url": "https://example.com/page" }
   Fetches the page + robots.txt + llms.txt server-side, runs ~50 checks
   across 13 categories, returns pillar scores (0-100) + per-check fixes.
   No dependencies. Scoring: pass=100, warning=60, fail=0 (info excluded).
   Pillars: SEO, AEO, GEO. Combined = mean of pillars. Grades: A>=90 B>=80 C>=70 D>=60 F<60. */

const AI_AGENTS = [
  "GPTBot", "ChatGPT-User", "OAI-SearchBot",
  "ClaudeBot", "Claude-SearchBot", "CCBot",
  "PerplexityBot", "Google-Extended", "Bytespider", "FacebookBot",
];
const SEARCH_CRAWLERS = ["OAI-SearchBot", "PerplexityBot", "Claude-SearchBot"];

/* ---------------- helpers ---------------- */
function decodeEnt(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return ""; } });
}
function cleanText(s) {
  return decodeEnt(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function words(s) { const t = String(s || "").trim(); return t ? t.split(/\s+/) : []; }
function allMatches(re, s) { const out = []; let m; re = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"); while ((m = re.exec(s))) out.push(m); return out; }
function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
}
function countSyllables(w) {
  w = String(w).toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0; if (w.length <= 3) return 1;
  const v = w.replace(/[^aeiouy]+/g, " ").trim().split(/\s+/).length;
  let n = Math.max(1, v - (/e$/.test(w) ? 1 : 0));
  return n;
}
function readingGrade(text) {
  const ws = words(text); if (ws.length < 30) return null;
  const sentences = text.split(/[.!?…]+/).filter(s => words(s).length > 2);
  const sCount = Math.max(1, sentences.length);
  const syl = ws.reduce((a, w) => a + countSyllables(w), 0);
  return 0.39 * (ws.length / sCount) + 11.8 * (syl / ws.length) - 15.59;
}
function isInternal(href, base) {
  try {
    const u = new URL(href, base);
    const b = new URL(base);
    return u.hostname === b.hostname || !/^[a-z]+:/i.test(href) && href.startsWith("/");
  } catch { return href.startsWith("/") || (!/^[a-z]+:/i.test(href) && !href.startsWith("#")); }
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ""; } }

/* ---------------- robots.txt ---------------- */
function parseRobots(txt, agents) {
  const out = {};
  if (txt == null) { agents.forEach(a => out[a] = "unknown"); return out; }
  const groups = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim(); if (!line) continue;
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || cur.sealed) { cur = { agents: [], rules: [], sealed: false }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if (k === "disallow" || k === "allow") {
      if (!cur) continue; cur.rules.push({ k, v }); cur.sealed = true;
    }
  }
  for (const a of agents) {
    const al = a.toLowerCase();
    let g = groups.find(g => g.agents.includes(al)) || groups.find(g => g.agents.includes("*"));
    if (!g) { out[a] = "allowed"; continue; }
    const dis = g.rules.filter(r => r.k === "disallow" && r.v !== "");
    const rootBlock = dis.some(r => r.v === "/");
    out[a] = rootBlock ? "blocked" : (dis.length ? "partial" : "allowed");
  }
  return out;
}

/* ---------------- extraction ---------------- */
function extractAll(html, pageUrl) {
  const d = {};
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  d.title = titleM ? cleanText(titleM[1]) : "";
  d.metas = {};
  for (const m of allMatches(/<meta\s+([^>]*?)>/gi, html)) {
    const tag = m[0];
    const key = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (key) d.metas[key] = attr(tag, "content");
  }
  const canonM = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i);
  d.canonical = canonM ? attr(canonM[0], "href") : "";
  const iconM = html.match(/<link[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i);
  d.favicon = !!iconM;
  const htmlTag = html.match(/<html[^>]*>/i);
  d.lang = htmlTag ? attr(htmlTag[0], "lang") : "";

  d.headings = {};
  for (const t of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    d.headings[t] = allMatches(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">", "gi"), html)
      .map(m => cleanText(m[1])).filter(Boolean);
  }
  const semTags = ["header", "main", "nav", "article", "section", "footer", "aside"];
  d.semanticCount = semTags.reduce((a, t) => a + allMatches(new RegExp("<" + t + "[\\s>]", "gi"), html).length, 0);

  d.jsonld = []; d.jsonldInvalid = 0;
  for (const m of allMatches(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, html)) {
    try {
      const j = JSON.parse(m[1].trim());
      (Array.isArray(j) ? j : [j]).forEach(x => d.jsonld.push(x));
    } catch { d.jsonldInvalid++; /* a block that failed to parse — count it directly */ }
  }

  const types = new Set(); let maxDepth = 0;
  (function walk(node, depth) {
    maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(node)) return node.forEach(n => walk(n, depth));
    if (node && typeof node === "object") {
      const t = node["@type"];
      (Array.isArray(t) ? t : [t]).forEach(x => { if (x) types.add(String(x)); });
      for (const k of Object.keys(node)) { if (k !== "@context") walk(node[k], depth + 1); }
    }
  })(d.jsonld, 0);
  d.schemaTypes = [...types]; d.schemaDepth = maxDepth;
  d.sameAsCount = (JSON.stringify(d.jsonld).match(/"sameAs"/g) || []).length;

  d.images = allMatches(/<img[^>]*>/gi, html).map(m => m[0]);
  d.imgsMissingAlt = d.images.filter(t => !attr(t, "alt").trim()).length;

  d.links = [];
  for (const m of allMatches(/<a\s[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, html)) {
    d.links.push({ href: m[2], text: cleanText(m[3]).slice(0, 80), internal: isInternal(m[2], pageUrl) });
  }
  const genericRe = /^(click here|read more|learn more|more|here|link|this page)+$/i;
  d.genericAnchors = d.links.filter(l => genericRe.test(l.text)).length;
  d.externalLinks = d.links.filter(l => !l.internal && l.href && !l.href.startsWith("#")).length;
  d.internalLinks = d.links.filter(l => l.internal && l.href && !l.href.startsWith("#")).length;

  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  d.text = cleanText(noScript.replace(/<[^>]+>/g, " "));
  d.wordCount = words(d.text).length;
  d.paragraphs = allMatches(/<p[^>]*>([\s\S]*?)<\/p>/gi, html).map(m => cleanText(m[1])).filter(p => p.length > 10);
  d.firstPara = d.paragraphs[0] || "";
  d.listCount = allMatches(/<(ul|ol)[\s>]/gi, html).length;
  d.tableCount = allMatches(/<table[\s>]/gi, html).length;
  d.quoteCount = allMatches(/<blockquote[\s>]/gi, html).length;
  d.hasStats = /(\d+(\.\d+)?\s*%|\b\d{3,}\b|study|studies|research|survey|data shows|according to)/i.test(d.text);
  d.hasQuotes = d.quoteCount > 0 || /"[^"]{15,120}"/.test(d.text);
  const qRe = /^(who|what|when|where|why|how|is|are|can|does|do|should|which)\b/i;
  d.questionHeadings = [...d.headings.h2, ...d.headings.h3].filter(h => qRe.test(h)).length;
  const byline = /rel=["']author["']|class=["'][^"']*byline|class=["'][^"']*author[^"']*["']|>by\s+[A-Z][a-z]+/i.test(html);
  d.hasByline = byline || d.schemaTypes.includes("Person");
  d.hasAboutContact = /href=["'][^"']*(about|contact)[^"']*["']/i.test(html);
  d.faqSection = /faq|frequently asked/i.test(html);
  d.forms = allMatches(/<form[\s\S]*?<\/form>/gi, html).length;
  d.inputs = allMatches(/<input[^>]*>/gi, html).length;
  d.labels = allMatches(/<label[\s>]/gi, html).length;
  return d;
}

/* ---------------- checks (13 categories) ---------------- */
function C(id, name, status, detail, fix) { return { id, name, status, detail, fix: fix || "" }; }

function runChecks(d, page, robotsTxt, llmsTxt) {
  const cats = [];
  const add = (id, name, pillar, checks) => cats.push({ id, name, pillar, checks });

  /* 1 — Meta & Discoverability [SEO] */
  {
    const t = d.title, tl = t.length, md = d.metas["description"] || "", mdl = md.length;
    const ck = [
      C("title-present", "Title tag present", t ? "pass" : "fail", t ? `“${t.slice(0, 70)}” (${tl} chars)` : "No <title> found.",
        "Add a unique, descriptive <title> to every page."),
      C("title-length", "Title length 30–60 chars", !t ? "fail" : tl >= 30 && tl <= 60 ? "pass" : tl <= 70 ? "warning" : "fail",
        t ? `${tl} characters` : "—", "Keep titles 30–60 characters so they don't truncate in Google results."),
      C("meta-description", "Meta description present", md ? "pass" : "fail", md ? `${mdl} chars: “${md.slice(0, 90)}…”` : "No meta description.",
        "Write a 120–160 character meta description that sells the click."),
      C("meta-description-length", "Meta description 120–160 chars", !md ? "fail" : mdl >= 120 && mdl <= 160 ? "pass" : "warning",
        md ? `${mdl} characters` : "—", "Descriptions outside 120–160 chars get truncated or rewritten by Google."),
      C("canonical", "Canonical URL set", d.canonical ? "pass" : "warning", d.canonical ? d.canonical : "No canonical link tag.",
        "Add <link rel=\"canonical\"> to prevent duplicate-content issues."),
      C("meta-robots", "Robots meta not blocking", /noindex/i.test(d.metas["robots"] || "") ? "fail" : "pass",
        d.metas["robots"] ? `robots="${d.metas["robots"]}"` : "No robots meta (defaults to index, follow).",
        "Remove noindex unless you truly want this page out of search results."),
      C("viewport", "Mobile viewport tag", d.metas["viewport"] ? "pass" : "fail", d.metas["viewport"] || "Missing.",
        "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."),
      C("charset", "Charset declared", /charset/i.test(page.htmlHead) ? "pass" : "warning", "—", "Declare <meta charset=\"utf-8\"> first in <head>."),
      C("favicon", "Favicon present", d.favicon ? "pass" : "warning", d.favicon ? "Found." : "No favicon link.",
        "Add a favicon — it shows in search results and tabs."),
      C("og-tags", "Open Graph tags", ["og:title", "og:description", "og:image"].every(k => d.metas[k]) ? "pass" : (d.metas["og:title"] ? "warning" : "fail"),
        `og:title ${d.metas["og:title"] ? "✓" : "✗"}, og:description ${d.metas["og:description"] ? "✓" : "✗"}, og:image ${d.metas["og:image"] ? "✓" : "✗"}`,
        "Add og:title, og:description and og:image so shares on social/AI platforms look right."),
      C("twitter-card", "Twitter card tag", d.metas["twitter:card"] ? "pass" : "warning", d.metas["twitter:card"] || "Missing.",
        "Add <meta name=\"twitter:card\" content=\"summary_large_image\">."),
    ];
    add("meta", "Meta & Discoverability", "SEO", ck);
  }

  /* 2 — Semantic HTML [SEO] */
  {
    const h1n = d.headings.h1.length;
    const levels = ["h1", "h2", "h3", "h4", "h5", "h6"].filter(h => d.headings[h].length);
    let skipped = false;
    for (let i = 1; i < levels.length; i++) {
      if (+levels[i][1] - +levels[i - 1][1] > 1) skipped = true;
    }
    add("semantic", "Semantic HTML", "SEO", [
      C("html-lang", "Language declared", d.lang ? "pass" : "fail", d.lang ? `lang="${d.lang}"` : "No lang attribute on <html>.",
        "Add lang=\"en\" (or your language) to <html> for screen readers and engines."),
      C("h1-single", "Exactly one H1", h1n === 1 ? "pass" : h1n === 0 ? "fail" : "warning",
        h1n === 1 ? `“${d.headings.h1[0].slice(0, 60)}”` : `${h1n} H1 tags found.`,
        "Use exactly one H1 per page — it tells engines what the page is about."),
      C("heading-hierarchy", "Heading hierarchy intact", skipped ? "warning" : "pass",
        skipped ? "Skipped heading levels detected (e.g. H2 → H4)." : "No skipped levels.",
        "Don't skip levels: H1 → H2 → H3 in order."),
      C("semantic-tags", "Semantic layout tags", d.semanticCount >= 3 ? "pass" : d.semanticCount >= 1 ? "warning" : "fail",
        `${d.semanticCount} semantic tags (header/main/nav/article/section/footer).`,
        "Use <header>, <main>, <nav>, <article> instead of div soup — machines parse meaning from them."),
    ]);
  }

  /* 3 — Internal Linking [SEO] */
  {
    const ratio = d.links.length ? d.genericAnchors / d.links.length : 0;
    add("links", "Internal Linking", "SEO", [
      C("internal-links", "Internal links present", d.internalLinks >= 3 ? "pass" : d.internalLinks >= 1 ? "warning" : "fail",
        `${d.internalLinks} internal links.`, "Link to 3+ relevant internal pages to spread authority."),
      C("anchor-text", "Descriptive anchor text", ratio < 0.2 ? "pass" : ratio < 0.4 ? "warning" : "fail",
        d.genericAnchors ? `${d.genericAnchors} generic anchors (“click here”, “read more”).` : "Anchors look descriptive.",
        "Replace “click here / read more” with anchors that describe the destination."),
      C("external-links", "Outbound references", d.externalLinks >= 1 ? "pass" : "info",
        `${d.externalLinks} external links.`, "Linking out to authoritative sources supports E-E-A-T."),
    ]);
  }

  /* 4 — Machine Readability [SEO] */
  {
    const textChars = d.text.length, ratio = page.sizeKb > 0 ? (textChars / 1024) / page.sizeKb : 0;
    add("machine", "Machine Readability", "SEO", [
      C("https", "Served over HTTPS", page.url.startsWith("https://") ? "pass" : "fail", page.url,
        "Serve the page over HTTPS — it's a ranking signal and AI crawlers distrust HTTP."),
      C("word-count", "Substantial text content", d.wordCount >= 300 ? "pass" : d.wordCount >= 150 ? "warning" : "fail",
        `${d.wordCount} words.`, "Thin pages rarely rank or get cited — aim for 300+ words of real content."),
      C("text-html-ratio", "Text-to-HTML ratio", ratio >= 0.1 ? "pass" : ratio >= 0.03 ? "warning" : "fail",
        `${Math.round(ratio * 100)}% text.`, "More real text per kilobyte of code = easier for crawlers to parse."),
      C("response-time", "Server response time", page.ms < 1500 ? "pass" : page.ms < 3000 ? "warning" : "fail",
        `${page.ms} ms.`, "Slow responses hurt crawling and rankings — aim under 1.5s."),
      C("page-weight", "Page weight", page.sizeKb < 500 ? "pass" : page.sizeKb < 1500 ? "warning" : "fail",
        `${Math.round(page.sizeKb)} KB HTML.`, "Heavy pages crawl slower — trim unused scripts and markup."),
    ]);
  }

  /* 5 — Structured Data & Schema [SEO] */
  {
    const types = d.schemaTypes;
    add("schema", "Structured Data & Schema", "SEO", [
      C("jsonld-present", "JSON-LD structured data", d.jsonld.length ? "pass" : "fail",
        d.jsonld.length ? `${d.jsonld.length} block(s): ${types.slice(0, 6).join(", ")}` : "No JSON-LD found.",
        "Add JSON-LD structured data — it's how machines understand your content type."),
      C("schema-valid", "JSON-LD parses cleanly", d.jsonldInvalid ? "fail" : "pass",
        d.jsonldInvalid ? `${d.jsonldInvalid} broken block(s).` : "All blocks parse.",
        "Fix JSON syntax errors — broken schema is ignored by every engine."),
      C("schema-depth", "Schema nesting depth ≤ 3", d.schemaDepth <= 3 ? "pass" : "warning",
        `Max nesting depth ${d.schemaDepth}.`, "Keep schema nesting shallow (≤3) for reliable parsing."),
      C("speakable", "Speakable schema", types.includes("SpeakableSpecification") ? "pass" : "warning",
        types.includes("SpeakableSpecification") ? "Present." : "Missing.",
        "Add SpeakableSpecification so voice assistants can quote your key sections."),
      C("breadcrumb", "Breadcrumb schema", types.includes("BreadcrumbList") ? "pass" : "info",
        types.includes("BreadcrumbList") ? "Present." : "Missing.", "BreadcrumbList helps engines show rich navigation trails."),
    ]);
  }

  /* 6 — Accessibility for Agents [GEO] */
  {
    const total = d.images.length, missing = d.imgsMissingAlt;
    const cov = total ? (total - missing) / total : 1;
    const matrix = parseRobots(robotsTxt, AI_AGENTS);
    const searchBlocked = SEARCH_CRAWLERS.filter(a => matrix[a] === "blocked");
    add("agents", "Accessibility for Agents", "GEO", [
      C("alt-coverage", "Image alt coverage", !total ? "info" : cov >= 0.9 ? "pass" : cov >= 0.5 ? "warning" : "fail",
        total ? `${total - missing}/${total} images have alt text.` : "No images.",
        "Give every meaningful image descriptive alt text — AI engines can't see pixels."),
      C("ai-search-access", "AI search crawlers allowed", searchBlocked.length ? "fail" : "pass",
        searchBlocked.length ? `BLOCKED: ${searchBlocked.join(", ")}` : "OAI-SearchBot, PerplexityBot, Claude-SearchBot not blocked.",
        "Don't block AI search crawlers in robots.txt unless you want to be invisible in AI answers."),
      C("training-bots", "AI training bots (GPTBot/ClaudeBot/CCBot)", (() => {
        const b = ["GPTBot", "ClaudeBot", "CCBot"].filter(a => matrix[a] === "blocked");
        return { b };
      })().b.length ? "info" : "info",
        `GPTBot: ${matrix["GPTBot"]}, ClaudeBot: ${matrix["ClaudeBot"]}, CCBot: ${matrix["CCBot"]}.`,
        "Training-bot blocking is a business decision — it doesn't affect AI search citations either way."),
      C("llms-txt", "llms.txt present", llmsTxt == null ? "info" : llmsTxt ? "pass" : "info",
        llmsTxt ? "Found /llms.txt." : "No /llms.txt (emerging convention, not yet a standard).",
        "Consider adding /llms.txt — a proposed standard giving LLMs a clean markdown version of your site."),
      C("x-robots", "No X-Robots-Tag block", /noindex/i.test(page.xRobots) ? "fail" : "pass",
        page.xRobots ? `X-Robots-Tag: ${page.xRobots}` : "No blocking header.",
        "Remove noindex from X-Robots-Tag unless intentional."),
    ]);
    // stash matrix for the response payload
    d._robotMatrix = matrix;
  }

  /* 7 — Entity & Authority [GEO] */
  {
    add("entity", "Entity & Authority", "GEO", [
      C("org-schema", "Organization schema", d.schemaTypes.includes("Organization") ? "pass" : "warning",
        d.schemaTypes.includes("Organization") ? "Present." : "Missing.",
        "Add Organization schema with name, logo and sameAs links — engines build entity graphs from it."),
      C("author-signal", "Author attribution", d.hasByline ? "pass" : "warning",
        d.hasByline ? "Byline or Person schema found." : "No author signal.",
        "Show who wrote it (byline + Person schema) — E-E-A-T and citation-worthiness depend on it."),
      C("sameas", "sameAs identity links", d.sameAsCount >= 2 ? "pass" : d.sameAsCount === 1 ? "warning" : "info",
        `${d.sameAsCount} sameAs reference(s).`, "Link your social/profiles via sameAs so engines connect your entity."),
      C("about-contact", "About / Contact pages linked", d.hasAboutContact ? "pass" : "warning",
        d.hasAboutContact ? "Found." : "Not found.", "Link About and Contact pages — trust signals for humans and machines."),
    ]);
  }

  /* 8 — Agent Interactivity [GEO] */
  {
    add("interactivity", "Agent Interactivity", "GEO", [
      C("form-labels", "Form inputs labeled", !d.forms ? "info" : d.labels >= d.inputs && d.inputs > 0 ? "pass" : "warning",
        d.forms ? `${d.forms} form(s), ${d.inputs} input(s), ${d.labels} label(s).` : "No forms on page.",
        "Label every input — AI agents filling forms rely on labels, not placeholders."),
      C("contact-path", "Clear contact path", d.hasAboutContact ? "pass" : "info",
        d.hasAboutContact ? "Contact/about reachable." : "—",
        "AI agents acting for users need an obvious contact or action path."),
    ]);
  }

  /* 9 — Citability & Answer-Readiness [GEO] */
  {
    add("citability", "Citability & Answer-Readiness", "GEO", [
      C("statistics", "Statistics & data points", d.hasStats ? "pass" : "warning",
        d.hasStats ? "Numbers, % figures or research references found." : "No statistics detected.",
        "AI engines cite pages with concrete numbers — add stats, studies, data (+30–40% citation lift in research)."),
      C("quotable", "Quotable passages", d.hasQuotes ? "pass" : "warning",
        d.hasQuotes ? "Quotes or blockquotes found." : "None detected.",
        "Quotable lines get lifted verbatim into AI answers (+40% in GEO studies)."),
      C("sources", "External sources cited", d.externalLinks >= 2 ? "pass" : d.externalLinks === 1 ? "warning" : "fail",
        `${d.externalLinks} outbound source link(s).`, "Cite external sources — cited pages look citation-worthy themselves."),
    ]);
  }

  /* 10 — Answer Targeting & Snippets [AEO] */
  {
    const fpw = words(d.firstPara).length;
    add("answers", "Answer Targeting & Snippets", "AEO", [
      C("first-para-answer", "Direct answer up top", !d.firstPara ? "fail" : fpw >= 20 && fpw <= 90 ? "pass" : "warning",
        d.firstPara ? `First paragraph: ${fpw} words.` : "No paragraphs.",
        "Put a direct 40–60 word answer in the first paragraph — that's what gets quoted."),
      C("question-headings", "Question-based headings", d.questionHeadings >= 1 ? "pass" : "warning",
        `${d.questionHeadings} question-style H2/H3.`, "Phrase subheads as questions users actually ask."),
      C("snippet-format", "Snippet-friendly formatting", d.listCount + d.tableCount >= 1 ? "pass" : "warning",
        `${d.listCount} list(s), ${d.tableCount} table(s).`, "Lists and tables are the #1 featured-snippet formats."),
    ]);
  }

  /* 11 — FAQ & How-To Structures [AEO] */
  {
    const faqSchema = d.schemaTypes.includes("FAQPage"), howtoSchema = d.schemaTypes.includes("HowTo");
    add("faq", "FAQ & How-To Structures", "AEO", [
      C("faq-present", "FAQ content or schema", faqSchema || d.faqSection ? "pass" : "warning",
        faqSchema ? "FAQPage schema present." : d.faqSection ? "FAQ-like content found (no schema)." : "No FAQ detected.",
        "Add an FAQ section with FAQPage schema — it feeds People-Also-Ask and AI answers directly."),
      C("howto-present", "How-To steps or schema", howtoSchema || (d.listCount >= 1 && /step|how to|guide/i.test(d.text)) ? "pass" : "info",
        howtoSchema ? "HowTo schema present." : "No HowTo structure.",
        "For instructional content, use HowTo schema or clear numbered steps."),
    ]);
  }

  /* 12 — Concise Direct Formatting [AEO] */
  {
    const avgP = d.paragraphs.length ? d.paragraphs.reduce((a, p) => a + words(p).length, 0) / d.paragraphs.length : 0;
    add("concise", "Concise Direct Formatting", "AEO", [
      C("paragraph-length", "Short paragraphs", !d.paragraphs.length ? "info" : avgP <= 60 ? "pass" : avgP <= 100 ? "warning" : "fail",
        d.paragraphs.length ? `Average ${Math.round(avgP)} words/paragraph.` : "—",
        "Keep paragraphs under ~60 words — AI engines extract short, self-contained chunks."),
      C("lists-tables", "Lists & tables used", d.listCount + d.tableCount >= 2 ? "pass" : d.listCount + d.tableCount === 1 ? "warning" : "fail",
        `${d.listCount} list(s), ${d.tableCount} table(s).`, "Break content into lists and tables — machines parse structure, not prose walls."),
    ]);
  }

  /* 13 — Voice & Conversational Readiness [AEO] */
  {
    const grade = readingGrade(d.text);
    const sentences = d.text.split(/[.!?…]+/).filter(s => words(s).length > 2);
    const avgS = sentences.length ? words(d.text).length / sentences.length : 0;
    const conversational = /(you|your|we'll|don't|can't|it's|here's)\b/i.test(d.text);
    add("voice", "Voice & Conversational Readiness", "AEO", [
      C("reading-grade", "Reading ease (grade 6–10)", grade == null ? "info" : grade >= 6 && grade <= 10 ? "pass" : grade < 6 ? "warning" : "warning",
        grade == null ? "Too little text." : `Flesch-Kincaid grade ${grade.toFixed(1)}.`,
        "Aim for grade 8 reading level — voice assistants quote plain language."),
      C("sentence-length", "Short sentences", !sentences.length ? "info" : avgS <= 20 ? "pass" : avgS <= 28 ? "warning" : "fail",
        sentences.length ? `Average ${avgS.toFixed(1)} words/sentence.` : "—",
        "Short sentences get quoted whole by voice assistants; long ones get skipped."),
      C("conversational-tone", "Conversational tone", conversational ? "pass" : "info",
        conversational ? "Direct address / contractions detected." : "Formal tone.",
        "Write like you speak — voice search is conversational."),
    ]);
  }

  return cats;
}

/* ---------------- scoring ---------------- */
const SCORE = { pass: 100, warning: 60, fail: 0 };
function scoreCats(cats) {
  for (const c of cats) {
    const scored = c.checks.filter(k => k.status !== "info");
    c.score = scored.length ? Math.round(scored.reduce((a, k) => a + SCORE[k.status], 0) / scored.length) : null;
    c.counts = {
      pass: c.checks.filter(k => k.status === "pass").length,
      warning: c.checks.filter(k => k.status === "warning").length,
      fail: c.checks.filter(k => k.status === "fail").length,
    };
  }
  const pillarScore = p => {
    const cs = cats.filter(c => c.pillar === p && c.score != null);
    return cs.length ? Math.round(cs.reduce((a, c) => a + c.score, 0) / cs.length) : null;
  };
  const pillars = { SEO: pillarScore("SEO"), AEO: pillarScore("AEO"), GEO: pillarScore("GEO") };
  const vals = Object.values(pillars).filter(v => v != null);
  const combined = vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : 0;
  const grade = combined >= 90 ? "A" : combined >= 80 ? "B" : combined >= 70 ? "C" : combined >= 60 ? "D" : "F";
  return { pillars, combined, grade };
}

/* ---------------- handler ---------------- */
async function fetchText(url, ms = 12000, maxBytes = 40000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "AuditBeacon/1.0 (free SEO-AEO-GEO auditor)" } });
    const txt = await r.text();
    return { ok: true, status: r.status, text: txt.slice(0, 2000000), url: r.url, xRobots: r.headers.get("x-robots-tag") || "" };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    let raw = String(body.url || "").trim();
    if (!raw) return json({ error: "No URL provided." }, 400);
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    let pageUrl;
    try { pageUrl = new URL(raw); } catch { return json({ error: "That doesn't look like a valid URL." }, 400); }
    if (!/^https?:$/.test(pageUrl.protocol)) return json({ error: "Only http(s) URLs can be audited." }, 400);

    const t0 = Date.now();
    const pageRes = await fetchText(pageUrl.href);
    if (!pageRes.ok) return json({ error: "Could not fetch the page: " + pageRes.error }, 502);
    if (pageRes.status >= 400) return json({ error: `The page returned HTTP ${pageRes.status}.` }, 502);
    const ms = Date.now() - t0;
    const html = pageRes.text;
    const sizeKb = new Blob([html]).size / 1024;
    const headM = html.match(/<head[\s\S]*?<\/head>/i);
    const page = {
      url: pageRes.url, status: pageRes.status, ms, sizeKb,
      xRobots: pageRes.xRobots, htmlHead: headM ? headM[0] : html.slice(0, 60000),
    };

    const origin = pageUrl.origin;
    const [robotsRes, llmsRes] = await Promise.all([
      fetchText(origin + "/robots.txt", 8000).then(r => (r.ok && r.status < 400 ? r.text : null)).catch(() => null),
      fetchText(origin + "/llms.txt", 8000).then(r => (r.ok && r.status < 400 && r.text.length > 20 ? true : false)).catch(() => false),
    ]);

    const d = extractAll(html, page.url);
    const cats = runChecks(d, page, robotsRes, llmsRes);
    const { pillars, combined, grade } = scoreCats(cats);

    // top fixes: failed checks first, then warnings, category-weighted
    const fixes = [];
    for (const c of cats) for (const k of c.checks) {
      if ((k.status === "fail" || k.status === "warning") && k.fix) fixes.push({ category: c.name, check: k.name, status: k.status, fix: k.fix });
    }
    fixes.sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1));

    return json({
      url: raw, finalUrl: page.url, status: page.status, ms, sizeKb: Math.round(sizeKb),
      title: d.title, wordCount: d.wordCount,
      pillars, combined, grade,
      categories: cats.map(c => ({ id: c.id, name: c.name, pillar: c.pillar, score: c.score, counts: c.counts, checks: c.checks })),
      robotMatrix: d._robotMatrix || {},
      llmsTxt: !!llmsRes,
      schemaTypes: d.schemaTypes,
      topFixes: fixes.slice(0, 12),
    });
  } catch (e) {
    return json({ error: "Analysis failed: " + String(e && e.message || e).slice(0, 200) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

export async function onRequestOptions() {
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
