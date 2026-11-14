/*
 * NS Terminal — web bridge shim
 * Loaded as a classic script BEFORE the SvelteKit modules.
 * Provides the Tauri IPC surface the frontend expects, backed by HTTP + WebSocket.
 */
(function () {
  "use strict";
  window.__SHIM_RAN__ = (window.__SHIM_RAN__ || 0) + 1;
  if (window.__NS_BRIDGE__) return;

  // Expose the IPC surface first: any later failure must not leave the app blind.
  window.__TAURI_INTERNALS__ = {
    invoke: invoke,
    transformCallback: function (cb, once) {
      var id = nextCallbackId++;
      callbacks.set(id, { cb: cb, once: !!once });
      return id;
    },
    unregisterCallback: function (id) { callbacks.delete(id); },
    convertFileSrc: function (p) { return p; },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
      windows: ["main"],
      webviews: ["main"],
    },
  };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: "linux",
    version: "",
    family: "unix",
    arch: "x86_64",
    exeExtension: "",
    eol: "\n",
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () { return null; },
    emit: function () { return null; },
  };

  var APP_VERSION = "1.25.0";
  var callbacks = new Map();
  var nextCallbackId = 1;
  var eventListeners = new Map(); // event -> Set<callbackId>
  var wsUrl = location.origin.replace(/^http/, "ws");

  /* ---------------- helpers ---------------- */
  function ok(v) { return v; }
  function notFound(cmd) {
    var e = new Error("command not found: " + cmd);
    e.name = "CommandNotFound";
    return e;
  }
  function sessionId() {
    try {
      var k = "ns_session_id";
      var v = localStorage.getItem(k);
      if (!v) {
        v = crypto.randomUUID();
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return "anonymous";
    }
  }

  /* ---------------- event bus ---------------- */
  function emitLocal(event, payload) {
    var set = eventListeners.get(event);
    if (!set) return;
    set.forEach(function (id) {
      var entry = callbacks.get(id);
      if (entry) entry.cb({ event: event, id: id, payload: payload });
    });
  }
  var bus = null;
  try { bus = new BroadcastChannel("ns-terminal"); } catch (e) { bus = null; }
  if (bus) bus.onmessage = function (m) {
    if (m && m.data && m.data.event) emitLocal(m.data.event, m.data.payload);
  };

  /* ---------------- HTTP transport to the server ---------------- */
  async function rpc(cmd, args) {
    var res = await fetch("/api/tauri/" + encodeURIComponent(cmd), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args || {}),
      credentials: "same-origin",
    });
    if (!res.ok) {
      var text = await res.text();
      throw new Error(text || res.statusText);
    }
    var ct = res.headers.get("content-type") || "";
    return ct.indexOf("application/json") >= 0 ? res.json() : res.text();
  }

  /* ---------------- plugin:http ---------------- */
  // Mirrors the tauri-plugin-http 4-step protocol using our server proxy so that
  // third-party endpoints without CORS headers keep working.
  var httpRids = new Map();
  var nextRid = 1;

  async function httpFetch(args) {
    var cfg = (args && args.clientConfig) || {};
    var rid = nextRid++;
    var controller = new AbortController();
    httpRids.set(rid, { controller: controller, response: null, used: false });
    var headers = {};
    (cfg.headers || []).forEach(function (pair) { headers[pair[0]] = pair[1]; });
    var body;
    if (cfg.data) {
      try { body = new Uint8Array(cfg.data); } catch (e) { body = null; }
    }
    var res = await fetch("/api/http", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        url: cfg.url,
        method: cfg.method || "GET",
        headers: headers,
        bodyBase64: body ? btoa(String.fromCharCode.apply(null, body)) : null,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("proxy error " + res.status);
    httpRids.get(rid).response = res;
    return rid;
  }

  async function httpSend(rid) {
    var entry = httpRids.get(rid);
    if (!entry || !entry.response) throw new Error("invalid rid");
    var res = entry.response;
    entry.used = true;
    var headers = [];
    res.headers.forEach(function (v, k) { headers.push([k, v]); });
    httpRids.set(res.headers.get("x-ns-rid") || rid, entry);
    return {
      status: res.status,
      statusText: res.statusText,
      url: res.headers.get("x-ns-final-url") || "",
      headers: headers,
      rid: rid,
    };
  }

  async function httpReadBody(args) {
    var rid = args.rid;
    var channel = callbacks.get(args.streamChannel);
    var entry = httpRids.get(rid);
    if (!entry || !entry.response) throw new Error("invalid rid");
    var reader = entry.response.body.getReader();
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        var chunk = step.value;
        var out = new Uint8Array(chunk.length + 1);
        out.set(chunk, 0);
        out[chunk.length] = 0;
        if (channel) channel.cb(out);
      }
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
    var end = new Uint8Array(1);
    end[0] = 1;
    if (channel) channel.cb(end);
    httpRids.delete(rid);
    if (channel && channel.once) callbacks.delete(args.streamChannel);
  }

  /* ---------------- local plugin implementations ---------------- */
  var pathApi = {
    "plugin:path|basename": function (a) { var p = String(a.path || ""); return p.split("/").filter(Boolean).pop() || ""; },
    "plugin:path|dirname": function (a) { var p = String(a.path || ""); var i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); },
    "plugin:path|extname": function (a) { var p = String(a.path || ""); var b = p.split("/").pop() || ""; var i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); },
    "plugin:path|is_absolute": function (a) { return String(a.path || "").charAt(0) === "/"; },
    "plugin:path|join": function (a) { return (a.paths || []).join("/").replace(/\/+/g, "/"); },
    "plugin:path|normalize": function (a) {
      var parts = String(a.path || "").split("/"); var out = [];
      parts.forEach(function (s) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); });
      return "/" + out.join("/");
    },
    "plugin:path|resolve": function (a) { return pathApi["plugin:path|normalize"]({ path: (a.paths || []).join("/") }); },
    "plugin:path|resolve_directory": function () { return "/"; },
  };

  var winApi = {
    "plugin:window|is_maximized": function () { return false; },
    "plugin:window|is_minimized": function () { return false; },
    "plugin:window|is_fullscreen": function () { return false; },
    "plugin:window|is_focused": function () { return true; },
    "plugin:window|is_visible": function () { return true; },
    "plugin:window|is_decorated": function () { return false; },
    "plugin:window|is_resizable": function () { return true; },
    "plugin:window|is_closable": function () { return false; },
    "plugin:window|is_minimizable": function () { return false; },
    "plugin:window|is_maximizable": function () { return false; },
    "plugin:window|is_always_on_top": function () { return false; },
    "plugin:window|theme": function () { return "dark"; },
    "plugin:window|title": function () { return "NS Terminal"; },
    "plugin:window|scale_factor": function () { return window.devicePixelRatio || 1; },
    "plugin:window|inner_size": function () { return { width: window.innerWidth, height: window.innerHeight }; },
    "plugin:window|outer_size": function () { return { width: window.innerWidth, height: window.innerHeight }; },
    "plugin:window|inner_position": function () { return { x: 0, y: 0 }; },
    "plugin:window|outer_position": function () { return { x: 0, y: 0 }; },
    "plugin:window|get_all_windows": function () { return ["main"]; },
  };

  var noopPrefixes = [
    "plugin:window|set_", "plugin:window|show", "plugin:window|hide", "plugin:window|close",
    "plugin:window|destroy", "plugin:window|maximize", "plugin:window|unmaximize",
    "plugin:window|minimize", "plugin:window|unminimize", "plugin:window|center",
    "plugin:window|toggle_maximize", "plugin:window|start_dragging",
    "plugin:window|start_resize_dragging", "plugin:window|request_user_attention",
    "plugin:window|create", "plugin:webview|", "plugin:resources|close",
  ];

  /* ---------------- invoke ---------------- */
  async function invoke(cmd, args) {
    args = args || {};

    if (cmd === "plugin:http|fetch") return httpFetch(args);
    if (cmd === "plugin:http|fetch_send") return httpSend(args.rid);
    if (cmd === "plugin:http|fetch_read_body") return httpReadBody(args);
    if (cmd === "plugin:http|fetch_cancel") {
      var e = httpRids.get(args.rid);
      if (e) { e.controller.abort(); httpRids.delete(args.rid); }
      return null;
    }

    if (cmd === "plugin:event|listen") {
      var ev = args.event;
      if (!eventListeners.has(ev)) eventListeners.set(ev, new Set());
      eventListeners.get(ev).add(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") {
      var set = eventListeners.get(args.event);
      if (set) set.delete(args.eventId);
      return null;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      emitLocal(args.event, args.payload);
      if (bus) bus.postMessage({ event: args.event, payload: args.payload });
      return null;
    }

    if (cmd === "plugin:app|version" || cmd === "get_app_version") return APP_VERSION;

    if (cmd === "plugin:os|hostname") return "nsterminal";
    if (cmd === "plugin:machine-uid|get_machine_uid") return sessionId();
    if (cmd === "plugin:shell|open") { window.open(args.path || args.url, "_blank", "noopener"); return null; }

    if (cmd === "plugin:dialog|open") {
      return new Promise(function (resolve) {
        var input = document.createElement("input");
        input.type = "file";
        input.multiple = !!(args && args.options && args.options.multiple);
        if (args && args.options && args.options.filters && args.options.filters[0] && args.options.filters[0].extensions) {
          input.accept = args.options.filters[0].extensions.map(function (x) { return "." + x; }).join(",");
        }
        input.onchange = function () {
          var f = input.files && input.files[0];
          var dir = args && args.options && args.options.directory;
          if (!f) return resolve(null);
          if (dir) return resolve("/uploads");
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result)); };
          reader.readAsText(f);
        };
        input.click();
      });
    }
    if (cmd === "plugin:dialog|save") return "download.bin";
    if (cmd.indexOf("plugin:dialog|") === 0) return null;

    if (pathApi[cmd]) return pathApi[cmd](args);
    if (winApi[cmd]) return winApi[cmd](args);
    for (var i = 0; i < noopPrefixes.length; i++) {
      if (cmd.indexOf(noopPrefixes[i]) === 0) return null;
    }
    if (cmd.indexOf("plugin:fs|") === 0) {
      var op = cmd.slice("plugin:fs|".length);
      var res = await fetch("/api/fs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ op: op, args: args }),
      });
      if (!res.ok) throw new Error(await res.text());
      var ct = res.headers.get("content-type") || "";
      if (ct.indexOf("json") >= 0) return res.json();
      return new Uint8Array(await res.arrayBuffer());
    }
    if (cmd.indexOf("plugin:log|") === 0) return null;
    if (cmd.indexOf("plugin:image|") === 0) throw notFound(cmd);

    // application commands -> server
    return rpc(cmd, args);
  }

  /* ---------------- public surface ---------------- */
  window.__TAURI__ = window.__TAURI__ || {};
  window.__TAURI__.core = { invoke: invoke };
  window.__TAURI__.app = { getVersion: function () { return Promise.resolve(APP_VERSION); } };
  window.__TAURI__.window = window.__TAURI__.window || {};

  /* ---------------- transport rewrites ---------------- */
  var PORT_MAP = { 9500: "/api/db", 9501: "/api/stream", 9502: "/api/tasks", 9503: "/api/mcp", 6543: "/api/triplit" };

  function remapHttp(url) {
    try {
      var u = new URL(url, location.origin);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        var p = PORT_MAP[u.port];
        if (p) return p + u.pathname + u.search;
      }
    } catch (e) {}
    return null;
  }

  var NativeWebSocket = window.WebSocket;
  function BridgedWebSocket(url, protocols) {
    var target = url;
    try {
      var u = new URL(url, location.origin);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        var p = PORT_MAP[u.port];
        if (p) {
          u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
          u.host = location.host;
          u.port = "";
          u.pathname = p;
          target = u.toString();
        }
      }
    } catch (e) {}
    return protocols === undefined ? new NativeWebSocket(target) : new NativeWebSocket(target, protocols);
  }
  BridgedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { BridgedWebSocket[k] = NativeWebSocket[k]; });
  window.WebSocket = BridgedWebSocket;

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === "string") {
      var mapped = remapHttp(input);
      if (mapped) input = mapped;
    } else if (input && input.url) {
      var mapped2 = remapHttp(input.url);
      if (mapped2) input = new Request(mapped2, input);
    }
    return nativeFetch(input, init);
  };

  window.__NS_BRIDGE__ = { version: 1 };
})();
