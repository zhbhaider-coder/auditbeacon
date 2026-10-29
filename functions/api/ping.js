export async function onRequestGet() {
  return new Response(JSON.stringify({ pong: 1 }), { headers: { "Content-Type": "application/json" } });
}
