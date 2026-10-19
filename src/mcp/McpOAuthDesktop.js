const { McpOAuthError, secureUrl } = require("./McpOAuthProtocol");

function publicAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) return /^(2|3)[0-9a-f]{3}:/.test(value) && !/^2001:(db8|0|10|20):/.test(value);
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

function loadDesktop() {
  try {
    return { https: require("https"), http: require("http"), dns: require("dns"), crypto: require("crypto") };
  } catch { throw new McpOAuthError("unsupported"); }
}

async function desktopRequest(options) {
  const deadline = Date.now() + 30000;
  const { https, dns } = loadDesktop();
  const url = secureUrl(options.url);
  if (options.signal?.aborted) throw new McpOAuthError("cancelled");
  let addresses;
  try {
    addresses = await new Promise((resolve, reject) => {
      const abort = () => finish(new McpOAuthError("cancelled"));
      const timer = setTimeout(() => finish(new McpOAuthError("network")), 30000);
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(result);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }).then((result) => finish(null, result), () => finish(new McpOAuthError("network")));
    });
  }
  catch (error) { throw error instanceof McpOAuthError ? error : new McpOAuthError("network"); }
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new McpOAuthError("metadata");
  if (options.signal?.aborted) throw new McpOAuthError("cancelled");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const req = https.request(url, {
      method: options.method || "GET", headers: options.headers || { Accept: "application/json" },
      lookup: (_host, config, callback) => config?.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, addresses[0].family)
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); req.destroy(); finish(new McpOAuthError("redirect")); return; }
      const chunks = []; let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > (options.maxBytes || 262144)) { req.destroy(); finish(new McpOAuthError("network")); }
        else chunks.push(chunk);
      });
      response.on("error", () => finish(new McpOAuthError("network")));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* MCP SSE is parsed by the HTTP client. */ }
        finish(null, { status: response.statusCode, headers: response.headers, text, json });
      });
    });
    const abort = () => { req.destroy(); finish(new McpOAuthError("cancelled")); };
    const timer = setTimeout(() => { req.destroy(); finish(new McpOAuthError("network")); }, Math.max(1, deadline - Date.now()));
    req.on("error", () => finish(new McpOAuthError("network")));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    req.end(options.body);
  });
}

async function loopbackCallback({ port = 0, state, issuer, requireIssuer, signal, onRejected }) {
  const { http, crypto } = loadDesktop();
  let used = false, completed = false, resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  code.catch(() => {});
  let redirectUri = "";
  let rejectedCount = 0;
  const rejected = (reason) => {
    if (++rejectedCount > 10) return;
    try { onRejected?.(reason); } catch { /* Callback diagnostics are best effort. */ }
  };
  const close = () => { if (server.listening) server.close(); server.closeAllConnections?.(); };
  const complete = (error, value) => {
    if (completed) return;
    completed = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
    error ? rejectCode(error) : resolveCode(value);
    close();
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    const reply = (status, text) => { res.statusCode = status; res.end(text); };
    let url, reason = "invalid-request";
    try {
      if (used || req.method !== "GET" || req.url.length > 8192 || req.headers.host !== new URL(redirectUri).host) throw new Error();
      url = new URL(req.url, redirectUri);
      if (url.pathname !== "/codriver/oauth/callback" || url.origin !== new URL(redirectUri).origin) throw new Error();
      reason = "duplicate-parameters";
      if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new Error();
      const supplied = url.searchParams.get("state") || "";
      reason = "state-mismatch";
      if (supplied.length !== state.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) throw new Error();
      const returnedIssuer = url.searchParams.get("iss");
      reason = "issuer-mismatch";
      if ((requireIssuer && !returnedIssuer) || (returnedIssuer !== null && returnedIssuer !== issuer)) throw new Error();
      const value = url.searchParams.get("code");
      if (url.searchParams.has("error") || !value || value.length > 4096) {
        rejected("authorization-error");
        used = true; reply(400, "Authorization did not complete. Return to Obsidian."); complete(new McpOAuthError("callback")); return;
      }
      used = true; reply(200, "Authorization received. Return to Obsidian."); complete(null, value);
    } catch { rejected(reason); reply(400, "Invalid OAuth callback."); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  const abort = () => complete(new McpOAuthError("cancelled"));
  const timer = setTimeout(() => { rejected("timeout"); abort(); }, 600000);
  let host = "127.0.0.1";
  const listen = (address) => new Promise((resolve, reject) => {
    const failed = (error) => { server.removeListener("listening", ready); reject(error); };
    const ready = () => { server.removeListener("error", failed); resolve(); };
    server.once("error", failed); server.once("listening", ready); server.listen(port, address);
  });
  try {
    try { await listen(host); }
    catch (error) {
      if (!["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)) throw error;
      host = "[::1]"; await listen("::1");
    }
  } catch { complete(new McpOAuthError("port")); throw new McpOAuthError("port"); }
  redirectUri = `http://${host}:${server.address().port}/codriver/oauth/callback`;
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { redirectUri, code, close: abort };
}

module.exports = { desktopRequest, loadDesktop, loopbackCallback, publicAddress };
