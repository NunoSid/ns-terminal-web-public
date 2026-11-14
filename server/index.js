// NS Terminal web server (Bun)
// Serves the SvelteKit frontend, proxies authenticated calls to the local sidecar,
// and implements the Tauri IPC surface the frontend expects (web bridge).
import { serve } from "bun";

const PORT = Number(process.env.PORT || 8787);
const SIDECAR_DIR = process.env.SIDECAR_DIR || "/app/sidecar";
const APP_DATA = process.env.FROGLABS_APP_DATA_DIR || "/data";
const BRIDGE_TOKEN = process.env.FROGLABS_BRIDGE_TOKEN || crypto.randomUUID();
const TRIPLIT_SECRET = process.env.FROGLABS_TRIPLIT_JWT_SECRET || "ns-terminal-triplit-secret";
const APP_VERSION = process.env.NS_APP_VERSION || "1.25.0";
const WEB_ROOT = process.env.WEB_ROOT || "/app/web";

const BRIDGES = { db: 9500, stream: 9501, tasks: 9502, "api-mcp": 9503 };
const TRIPLIT_PORT = 6543;

const COOKIE = "ns_session";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const USER = process.env.NS_USER || "admin";
const PASS = process.env.NS_PASS || "change-me";

/* ---------------- auth ---------------- */
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
  } catch {
    return false;
  }
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

/* ---------------- sidecar supervision ---------------- */
const children = new Map();
const states = new Map();
let shuttingDown = false;

function sidecarEnv() {
  return {
    ...process.env,
    FROGLABS_BRIDGE_TOKEN: BRIDGE_TOKEN,
    FROGLABS_TRIPLIT_JWT_SECRET: TRIPLIT_SECRET,
    FROGLABS_APP_DATA_DIR: APP_DATA,
    FROGLABS_APP_ENVIRONMENT: "prod",
    NODE_ENV: "production",
  };
}

function spawnCar(name) {
  const entry = `${SIDECAR_DIR}/main.js`;
  states.set(name, "starting");
  const proc = Bun.spawn({
    cmd: ["bun", "run", entry, `--car=${name}`],
    cwd: SIDECAR_DIR,
    env: sidecarEnv(),
    stdout: "inherit",
    stderr: "inherit",
    onExit(_p, code, signal) {
      states.set(name, `exited:${code ?? signal}`);
      children.delete(name);
      if (!shuttingDown) {
        console.error(`[sidecar:${name}] exited (${code ?? signal}), restarting in 2s`);
        setTimeout(() => spawnCar(name), 2000);
      }
    },
  });
  children.set(name, proc);
  states.set(name, "running");
  console.log(`[sidecar:${name}] pid=${proc.pid}`);
}

async function waitForPort(port, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      s.end();
      return true;
    } catch {
      await Bun.sleep(400);
    }
  }
  return false;
}

async function startSidecars() {
  if (!(await Bun.file(`${SIDECAR_DIR}/main.js`).exists())) {
    console.warn(`[sidecar] ${SIDECAR_DIR}/main.js not found — running UI only`);
    return;
  }
  spawnCar("db");
  if (!(await waitForPort(TRIPLIT_PORT))) console.warn("[sidecar:db] triplit port did not open");
  spawnCar("stream");
  spawnCar("tasks");
  spawnCar("api-mcp");
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    for (const p of children.values()) {
      try { p.kill(); } catch {}
    }
    process.exit(0);
  });
}

/* ---------------- tauri command surface ---------------- */
async function tauriCommand(cmd, args, req) {
  switch (cmd) {
    case "get_bridge_token":
      return BRIDGE_TOKEN;
    case "get_triplit_jwt_secret":
      return TRIPLIT_SECRET;
    case "get_app_version":
      return APP_VERSION;
    case "get_session_uuid": {
      const tok = getCookie(req, COOKIE);
      return tok ? tok.split(".")[0] : crypto.randomUUID();
    }
    case "get_mac_address": {
      const h = new Bun.CryptoHasher("sha256");
      h.update((getCookie(req, COOKIE) || "anon") + ":ns-terminal");
      return h.digest("hex").slice(0, 17).toUpperCase();
    }
    case "detect_browser_extensions":
      return [];
    case "open_bubblemap_window":
      return null;
    case "download_browser_extension":
      return null;
    case "webview_http_get":
    case "webview_http_post": {
      const url = args.url || args.request?.url;
      if (!url) throw new Error("missing url");
      const method = cmd === "webview_http_post" ? "POST" : "GET";
      const res = await fetch(url, {
        method,
        headers: args.headers || {},
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
    }
    case "webview_http_deliver_response":
    case "webview_http_close":
      return null;
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

/* ---------------- http proxy for plugin:http ---------------- */
async function proxyHttp(req) {
  const payload = await req.json();
  if (!payload || !payload.url) return new Response("missing url", { status: 400 });
  const init = { method: payload.method || "GET", headers: payload.headers || {}, redirect: "follow" };
  if (payload.bodyBase64) {
    const bin = atob(payload.bodyBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    init.body = bytes;
  }
  let upstream;
  try {
    upstream = await fetch(payload.url, init);
  } catch (e) {
    return new Response("upstream error: " + e.message, { status: 502 });
  }
  const headers = new Headers(upstream.headers);
  headers.set("x-ns-final-url", upstream.url);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/* ---------------- static proxy ---------------- */
const PROXY = {
  "/api/db": BRIDGES.db,
  "/api/stream": BRIDGES.stream,
  "/api/tasks": BRIDGES.tasks,
  "/api/mcp": BRIDGES["api-mcp"],
  "/api/triplit": TRIPLIT_PORT,
};

async function httpProxy(req, port, stripPrefix) {
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${port}${url.pathname.replace(stripPrefix, "") || "/"}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("cookie");
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
  try {
    const res = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("transfer-encoding");
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    return new Response("bridge unavailable: " + e.message, { status: 502 });
  }
}

const SHIM_FILE = new URL("./shim.js", import.meta.url);
let SHIM_TEXT = "";
try {
  SHIM_TEXT = await Bun.file(SHIM_FILE).text();
} catch {
  console.warn("[bridge] shim.js not found");
}

function injectShim(html) {
  if (!SHIM_TEXT) return html;
  const tag = `<script>${SHIM_TEXT.replace(/<\/script>/gi, "<\\/script>")}</script>`;
  return html.replace(/<head>/i, `<head>${tag}`);
}

/* ---------------- virtual filesystem for plugin:fs ---------------- */
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const FS_ROOT = process.env.NS_FS_ROOT || join(APP_DATA, "fs");
mkdirSync(FS_ROOT, { recursive: true });

function vpath(p) {
  const clean = normalize(String(p || "/")).replace(/\\/g, "/").replace(/^([A-Za-z]:)?\//, "").replace(/^(\.\.\/)+/, "");
  const abs = join(FS_ROOT, clean);
  if (!abs.startsWith(FS_ROOT)) throw new Error("path escapes root");
  return abs;
}

const fileHandles = new Map();
let nextHandle = 1;

async function fsCommand(req) {
  const body = await req.json();
  const op = body.op;
  const a = body.args || {};
  try {
    switch (op) {
      case "exists":
        return Response.json(existsSync(vpath(a.path)));
      case "mkdir":
        mkdirSync(vpath(a.path), { recursive: !!a.recursive });
        return Response.json(null);
      case "read_dir": {
        const dir = vpath(a.path);
        if (!existsSync(dir)) return Response.json([]);
        const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        }));
        return Response.json(entries);
      }
      case "read_text_file":
        return Response.json(readFileSync(vpath(a.path), "utf8"));
      case "read_file":
        return Response.json(Array.from(readFileSync(vpath(a.path))));
      case "write_text_file":
      case "write_file": {
        const p = vpath(a.path);
        mkdirSync(dirname(p), { recursive: true });
        const data = typeof a.data === "string" ? a.data : Buffer.from(a.data || []);
        writeFileSync(p, data);
        return Response.json(null);
      }
      case "remove":
        rmSync(vpath(a.path), { recursive: !!a.recursive, force: true });
        return Response.json(null);
      case "rename":
        renameSync(vpath(a.oldPath ?? a.from), vpath(a.newPath ?? a.to));
        return Response.json(null);
      case "copy_file":
        copyFileSync(vpath(a.from), vpath(a.to));
        return Response.json(null);
      case "stat":
      case "lstat": {
        const p = vpath(a.path);
        if (!existsSync(p)) throw new Error("ENOENT");
        const s = statSync(p);
        return Response.json({
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymlink: s.isSymbolicLink(),
          size: s.size,
          mtime: s.mtimeMs,
          atime: s.atimeMs,
          birthtime: s.birthtimeMs,
          readonly: false,
          fileAttributes: 0,
          dev: 0,
          ino: 0,
          mode: s.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          blksize: 4096,
          blocks: Math.ceil(s.size / 512),
        });
      }
      case "size": {
        const p = vpath(a.path);
        return Response.json(existsSync(p) ? statSync(p).size : 0);
      }
      case "open": {
        const p = vpath(a.path);
        const rid = nextHandle++;
        fileHandles.set(rid, { path: p, pos: 0, buf: existsSync(p) ? readFileSync(p) : Buffer.alloc(0) });
        return Response.json(rid);
      }
      case "create": {
        const p = vpath(a.path);
        mkdirSync(dirname(p), { recursive: true });
        const rid = nextHandle++;
        fileHandles.set(rid, { path: p, pos: 0, buf: Buffer.alloc(0), writable: true });
        return Response.json(rid);
      }
      case "write": {
        const h = fileHandles.get(a.rid);
        if (!h) throw new Error("invalid rid");
        const bytes = Buffer.from(a.data || []);
        const end = h.pos + bytes.length;
        if (h.buf.length < end) {
          const nb = Buffer.alloc(end);
          h.buf.copy(nb);
          h.buf = nb;
        }
        bytes.copy(h.buf, h.pos);
        h.pos = end;
        writeFileSync(h.path, h.buf);
        return Response.json(bytes.length);
      }
      case "read": {
        const h = fileHandles.get(a.rid);
        if (!h) throw new Error("invalid rid");
        const n = Math.min(a.length || 0, Math.max(0, h.buf.length - h.pos));
        const out = h.buf.subarray(h.pos, h.pos + n);
        h.pos += n;
        return new Response(out, { headers: { "content-type": "application/octet-stream" } });
      }
      case "seek": {
        const h = fileHandles.get(a.rid);
        if (!h) throw new Error("invalid rid");
        h.pos = Number(a.offset) + (Number(a.whence) === 1 ? h.pos : 0);
        return Response.json(h.pos);
      }
      case "fstat": {
        const h = fileHandles.get(a.rid);
        if (!h) throw new Error("invalid rid");
        return Response.json({ size: h.buf.length, isFile: true, isDirectory: false, isSymlink: false, mtime: Date.now(), atime: Date.now(), birthtime: Date.now(), readonly: false, fileAttributes: 0, dev: 0, ino: 0, mode: 0o644, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 4096, blocks: 0 });
      }
      case "ftruncate": {
        const h = fileHandles.get(a.rid);
        if (!h) throw new Error("invalid rid");
        h.buf = h.buf.subarray(0, a.length);
        writeFileSync(h.path, h.buf);
        return Response.json(null);
      }
      case "close":
        fileHandles.delete(a.rid);
        return Response.json(null);
      default:
        return new Response("unsupported fs op: " + op, { status: 400 });
    }
  } catch (e) {
    return new Response(e.message, { status: 400 });
  }
}

/* ---------------- login page ---------------- */
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

/* ---------------- server ---------------- */
const server = serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
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
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, sidecars: Object.fromEntries(states) });
    }

    if (!authed(req)) {
      if (url.pathname.startsWith("/api/")) return new Response("unauthorized", { status: 401 });
      return loginPage(false);
    }

    // WebSocket bridge upgrade
    if (req.headers.get("upgrade") === "websocket") {
      for (const [prefix, port] of Object.entries(PROXY)) {
        if (url.pathname === prefix) {
          const okUpgrade = srv.upgrade(req, { data: { port, path: url.pathname, search: url.search } });
          return okUpgrade ? undefined : new Response("upgrade failed", { status: 500 });
        }
      }
      return new Response("unknown bridge", { status: 404 });
    }

    if (url.pathname === "/api/http" && req.method === "POST") return proxyHttp(req);
    if (url.pathname === "/api/fs" && req.method === "POST") return fsCommand(req);

    if (url.pathname.startsWith("/api/tauri/") && req.method === "POST") {
      const cmd = decodeURIComponent(url.pathname.slice("/api/tauri/".length));
      console.log("[tauri]", cmd);
      try {
        const args = await req.json().catch(() => ({}));
        console.log("[tauri:args]", JSON.stringify(args).slice(0, 300));
        const result = await tauriCommand(cmd, args, req);
        return Response.json(result === undefined ? null : result);
      } catch (e) {
        return new Response(e.message, { status: 400 });
      }
    }

    if (url.pathname === "/tauri-shim.js") {
      return new Response(Bun.file(new URL("./shim.js", import.meta.url)), {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    }

    for (const [prefix, port] of Object.entries(PROXY)) {
      if (url.pathname.startsWith(prefix)) return httpProxy(req, port, prefix);
    }

    // static SvelteKit files
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(WEB_ROOT + p);
    if (await file.exists()) {
      if (p === "/index.html") {
        const html = await file.text();
        const injected = injectShim(html);
        return new Response(injected, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }
      return new Response(file);
    }
    const idx = Bun.file(WEB_ROOT + "/index.html");
    if (await idx.exists()) {
      const html = await idx.text();
      return new Response(injectShim(html), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const { port, path, search } = ws.data;
      const upstream = new WebSocket(`ws://127.0.0.1:${port}${search || ""}`);
      ws.data.upstream = upstream;
      ws.data.queue = [];
      upstream.addEventListener("open", () => {
        for (const msg of ws.data.queue) {
          try { upstream.send(msg); } catch {}
        }
        ws.data.queue = [];
      });
      upstream.addEventListener("message", (ev) => {
        try { ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data)); } catch {}
      });
      upstream.addEventListener("close", () => { try { ws.close(); } catch {} });
      upstream.addEventListener("error", () => { try { ws.close(); } catch {} });
    },
    message(ws, msg) {
      const up = ws.data.upstream;
      if (up && up.readyState === WebSocket.OPEN) up.send(msg);
      else ws.data.queue.push(msg);
    },
    close(ws) {
      try { ws.data.upstream?.close(); } catch {}
    },
  },
});

console.log(`NS Terminal web on :${server.port}`);
startSidecars();
