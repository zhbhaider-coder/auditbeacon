/* AuditBeacon frontend */
let LAST = null;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

const LOAD_MSGS = ["Fetching page…","Reading robots.txt…","Checking schema markup…","Scoring 13 categories…","Polishing results…"];
let loadTimer = null;

$("auditForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("urlInput").value.trim();
  if (!url) return;
  $("err").hidden = true; $("results").hidden = true; $("loading").hidden = false;
  $("auditBtn").disabled = true;
  let i = 0; $("loadMsg").textContent = LOAD_MSGS[0];
  loadTimer = setInterval(() => { i = (i + 1) % LOAD_MSGS.length; $("loadMsg").textContent = LOAD_MSGS[i]; }, 1400);
  try {
    const r = await fetch("/api/analyze", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ url }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Analysis failed.");
    LAST = data; render(data);
  } catch (err) {
    const el = $("err"); el.textContent = err.message || "Something went wrong."; el.hidden = false;
  } finally {
    clearInterval(loadTimer); $("loading").hidden = true; $("auditBtn").disabled = false;
  }
});
document.querySelectorAll(".samples button").forEach(b => b.addEventListener("click", () => {
  $("urlInput").value = b.dataset.url; $("auditForm").requestSubmit();
}));
document.querySelectorAll(".pf").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".pf").forEach(x => x.classList.remove("active")); b.classList.add("active");
  const f = b.dataset.pf;
  document.querySelectorAll("#cats .cat").forEach(c => { c.style.display = (f === "all" || c.dataset.pillar === f) ? "" : "none"; });
}));

function ringColor(v){ return v >= 80 ? "#34d399" : v >= 60 ? "#fbbf24" : "#f87171"; }

function render(d) {
  $("results").hidden = false;
  const C = 2 * Math.PI * 52;
  const fg = $("ringFg");
  fg.style.stroke = ringColor(d.combined);
  requestAnimationFrame(() => { fg.style.strokeDashoffset = C * (1 - d.combined / 100); });
  $("scoreNum").textContent = d.combined; $("grade").textContent = d.grade;
  $("grade").style.color = ringColor(d.combined);
  const P = d.pillars;
  [["Seo","SEO","#38bdf8"],["Aeo","AEO","#a78bfa"],["Geo","GEO","#34d399"]].forEach(([k, name, col]) => {
    const v = P[name]; $("p" + k).textContent = v == null ? "–" : v;
    const bar = $("b" + k); bar.style.width = "0"; bar.style.background = col;
    requestAnimationFrame(() => { bar.style.width = (v == null ? 0 : v) + "%"; });
  });
  $("rTitle").textContent = d.title || "(no title)";
  $("rUrl").textContent = d.finalUrl;
  $("rStats").textContent = `${d.status} · ${d.ms} ms · ${d.sizeKb} KB · ${d.wordCount} words · ${d.schemaTypes.length ? d.schemaTypes.join(", ") : "no schema"}`;

  const fx = $("topFixes"); fx.innerHTML = "";
  $("fixCount").textContent = d.topFixes.length ? `— fix these first` : "";
  d.topFixes.forEach(f => {
    const li = document.createElement("li"); if (f.status === "fail") li.className = "fail";
    li.innerHTML = `<b>${esc(f.check)}</b> <span class="fc">${esc(f.category)} · ${f.status}</span><p>${esc(f.fix)}</p>`;
    fx.appendChild(li);
  });

  const cats = $("cats"); cats.innerHTML = "";
  d.categories.forEach(c => {
    const div = document.createElement("div");
    div.className = "cat"; div.dataset.pillar = c.pillar;
    const score = c.score == null ? "–" : c.score;
    const col = c.score == null ? "#9aa7c7" : ringColor(c.score);
    div.innerHTML = `<button class="cathead"><span class="cpill ${c.pillar}">${c.pillar}</span><span class="cname">${esc(c.name)}</span><span class="cscore" style="color:${col}">${score}</span><span class="caret">▾</span></button><div class="catbody">${
      c.checks.map(k => `<div class="check"><span class="dot ${k.status}"></span><div><b>${esc(k.name)}</b><div class="cd">${esc(k.detail)}</div>${k.fix && (k.status === "fail" || k.status === "warning") ? `<div class="cf">Fix: ${esc(k.fix)}</div>` : ""}</div></div>`).join("")
    }</div>`;
    div.querySelector(".cathead").addEventListener("click", () => div.classList.toggle("open"));
    cats.appendChild(div);
  });

  const mx = $("matrix"); mx.innerHTML = "";
  Object.entries(d.robotMatrix).forEach(([agent, st]) => {
    const cell = document.createElement("div"); cell.className = "mcell";
    cell.innerHTML = `<span>${esc(agent)}</span><span class="st ${st}">${st}</span>`;
    mx.appendChild(cell);
  });
  const ll = document.createElement("div"); ll.className = "mcell";
  ll.innerHTML = `<span>llms.txt</span><span class="st ${d.llmsTxt ? "allowed" : "unknown"}">${d.llmsTxt ? "found" : "missing"}</span>`;
  mx.appendChild(ll);

  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- exports ---------- */
document.querySelectorAll("[data-exp]").forEach(b => b.addEventListener("click", () => {
  if (!LAST) return;
  const d = LAST, kind = b.dataset.exp;
  let out = "", mime = "text/plain", ext = "txt";
  if (kind === "md") { out = toMD(d); mime = "text/markdown"; ext = "md"; }
  else if (kind === "csv") { out = toCSV(d); mime = "text/csv"; ext = "csv"; }
  else if (kind === "html") { out = toHTML(d); mime = "text/html"; ext = "html"; }
  else out = toTXT(d);
  const blob = new Blob([out], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "auditbeacon-report." + ext; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}));

function toMD(d) {
  let s = `# AuditBeacon Report\n\n**URL:** ${d.finalUrl}\n**Score:** ${d.combined}/100 (Grade ${d.grade}) · SEO ${d.pillars.SEO} · AEO ${d.pillars.AEO} · GEO ${d.pillars.GEO}\n**Scanned:** ${new Date().toISOString()}\n\n## Top fixes\n`;
  d.topFixes.forEach((f, i) => { s += `${i + 1}. **${f.check}** (${f.category}, ${f.status}) — ${f.fix}\n`; });
  s += `\n## All checks\n`;
  d.categories.forEach(c => {
    s += `\n### ${c.name} [${c.pillar}] — ${c.score ?? "–"}/100\n`;
    c.checks.forEach(k => { s += `- [${k.status.toUpperCase()}] **${k.name}** — ${k.detail}${k.fix ? ` → ${k.fix}` : ""}\n`; });
  });
  s += `\n## AI crawler access (robots.txt)\n`;
  Object.entries(d.robotMatrix).forEach(([a, st]) => { s += `- ${a}: ${st}\n`; });
  s += `- llms.txt: ${d.llmsTxt ? "found" : "missing"}\n\n---\nGenerated by AuditBeacon — free SEO/AEO/GEO auditor.`;
  return s;
}
function toTXT(d) {
  let s = `AUDITBEACON REPORT\nURL: ${d.finalUrl}\nScore: ${d.combined}/100 (Grade ${d.grade}) | SEO ${d.pillars.SEO} | AEO ${d.pillars.AEO} | GEO ${d.pillars.GEO}\n\nTOP FIXES\n`;
  d.topFixes.forEach((f, i) => { s += `${i + 1}. ${f.check} [${f.status}] — ${f.fix}\n`; });
  d.categories.forEach(c => {
    s += `\n== ${c.name} [${c.pillar}] ${c.score ?? "–"}/100 ==\n`;
    c.checks.forEach(k => { s += `[${k.status.toUpperCase()}] ${k.name} — ${k.detail}\n`; });
  });
  return s;
}
function toCSV(d) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  let s = "category,pillar,check,status,detail,fix\n";
  d.categories.forEach(c => c.checks.forEach(k => {
    s += [q(c.name), q(c.pillar), q(k.name), q(k.status), q(k.detail), q(k.fix)].join(",") + "\n";
  }));
  return s;
}
function toHTML(d) {
  const rows = d.categories.map(c =>
    `<h2>${esc(c.name)} <small>[${c.pillar}] ${c.score ?? "–"}/100</small></h2><ul>` +
    c.checks.map(k => `<li><b>[${k.status.toUpperCase()}] ${esc(k.name)}</b> — ${esc(k.detail)}${k.fix ? `<br><i>Fix: ${esc(k.fix)}</i>` : ""}</li>`).join("") + `</ul>`
  ).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AuditBeacon Report</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.6}h1{font-size:28px}small{color:#666}li{margin:6px 0}</style></head><body><h1>AuditBeacon Report — ${d.combined}/100 (Grade ${d.grade})</h1><p><b>URL:</b> ${esc(d.finalUrl)}<br><b>SEO</b> ${d.pillars.SEO} · <b>AEO</b> ${d.pillars.AEO} · <b>GEO</b> ${d.pillars.GEO}</p><h2>Top fixes</h2><ol>${d.topFixes.map(f => `<li><b>${esc(f.check)}</b> — ${esc(f.fix)}</li>`).join("")}</ol>${rows}<hr><p><small>Generated by AuditBeacon — free SEO/AEO/GEO auditor.</small></p></body></html>`;
}
