// NS Terminal web server (Bun)
// Serves the SvelteKit frontend and proxies authenticated calls to the local sidecar.
import { serve } from "bun";

const PORT = Number(process.env.PORT || 8787);
const SIDECAR_DB = process.env.SIDECAR_DB || "http://127.0.0.1:9500";
const SIDECAR_STREAM = process.env.SIDECAR_STREAM || "http://127.0.0.1:9501";
const SIDECAR_TASKS = process.env.SIDECAR_TASKS || "http://127.0.0.1:9502";
const SIDECAR_API = process.env.SIDECAR_API || "http://127.0.0.1:9503";
const TRIPLIT = process.env.TRIPLIT_URL || "http://127.0.0.1:6543";
const WEB_ROOT = process.env.WEB_ROOT || "/app/web";

const COOKIE = "ns_session";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const USER = process.env.NS_USER || "admin";
const PASS = process.env.NS_PASS || "change-me";

function sign(value) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(SESSION_SECRET + ":" + value);
  return h.digest("hex");
}
function makeToken() {
  const payload = JSON.stringify({ u: USER, t: Date.now() });
  const b = Buffer.from(payload).toString("base64url");
  return b + "." + sign(b);
}
function verifyToken(tok) {
  if (!tok || !tok.includes(".")) return false;
  const [b, s] = tok.split(".");
  if (sign(b) !== s) return false;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.u === USER && Date.now() - p.t < 1000 * 60 * 60 * 24 * 7;
  } catch { return false; }
}
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
const authed = (req) => verifyToken(getCookie(req, COOKIE));

const PROXY = {
  "/api/db": SIDECAR_DB,
  "/api/stream": SIDECAR_STREAM,
  "/api/tasks": SIDECAR_TASKS,
  "/api/mcp": SIDECAR_API,
  "/api/triplit": TRIPLIT,
};

async function proxy(req, base) {
  const url = new URL(req.url);
  const target = base + url.pathname.replace(/^\/api\/(db|stream|tasks|mcp|triplit)/, "") + url.search;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("cookie");
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
  const res = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("transfer-encoding");
  return new Response(res.body, { status: res.status, headers: out });
}

function loginPage(error) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>NS Terminal</title>
<style>body{background:#0b0b0b;color:#f5d67b;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{background:#141414;padding:2rem;border-radius:12px;border:1px solid #2a2a2a;min-width:320px}
input{width:100%;padding:.6rem;margin:.4rem 0;background:#0f0f0f;border:1px solid #333;color:#eee;border-radius:6px}
button{width:100%;padding:.7rem;margin-top:.8rem;background:#f5d67b;color:#111;border:0;border-radius:6px;font-weight:700;cursor:pointer}
.err{color:#ff6b6b;font-size:.85rem}</style></head>
<body><form method="POST" action="/login"><h2>NS Terminal</h2>
${error ? '<p class="err">Credenciais inválidas</p>' : ""}
<input name="user" placeholder="Utilizador" autocomplete="username" required>
<input name="pass" type="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Entrar</button></form></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/login" && req.method === "POST") {
      const form = await req.formData();
      if (form.get("user") === USER && form.get("pass") === PASS) {
        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "set-cookie": `${COOKIE}=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
          },
        });
      }
      return loginPage(true);
    }
    if (url.pathname === "/logout") {
      return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` } });
    }
    if (url.pathname === "/api/health") return Response.json({ ok: true });

    if (!authed(req)) {
      if (url.pathname.startsWith("/api/")) return new Response("unauthorized", { status: 401 });
      return loginPage(false);
    }

    for (const [prefix, base] of Object.entries(PROXY)) {
      if (url.pathname.startsWith(prefix)) return proxy(req, base);
    }

    // static SvelteKit files
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(WEB_ROOT + p);
    if (await file.exists()) return new Response(file);
    const idx = Bun.file(WEB_ROOT + "/index.html");
    if (await idx.exists()) return new Response(idx);
    return new Response("not found", { status: 404 });
  },
});
console.log(`NS Terminal web on :${PORT}`);
