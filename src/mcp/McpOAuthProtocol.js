const MESSAGES = {
  unsupported: "OAuth 2 requires Obsidian desktop 1.11.5 or newer with secure storage and Node support.",
  metadata: "OAuth metadata is invalid or incompatible. Review the server configuration.",
  network: "OAuth connection failed. Check the server and retry in Settings.",
  redirect: "OAuth redirects are not supported for this request.",
  cancelled: "OAuth operation was cancelled.",
  stale: "MCP connection changed. Review its settings and connect again.",
  registration: "Automatic OAuth registration failed. Configure an existing client in Settings.",
  callback: "OAuth callback validation failed. Connect again in Settings.",
  port: "OAuth callback port is unavailable. Close the conflicting application or change the port.",
  tokens: "OAuth token response is invalid or incompatible. Connect again in Settings.",
  reconnect: "OAuth authorization is required. Connect this MCP server in Settings.",
  storage: "Unable to verify OAuth secret storage. Retry in Settings; credentials were not saved elsewhere.",
  cleanup: "OAuth tokens are blocked. Local credential cleanup requires a retry in Settings.",
  client: "OAuth client configuration is invalid or unsupported. Review Client ID and Client Secret."
};

function registrationSummary(response, redirectUri, metadata) {
  const data = response?.json;
  const clientIdValid = typeof data?.client_id === "string" && Boolean(data.client_id) && data.client_id.length <= 2048 && !/[\x00-\x20\x7f]/.test(data.client_id);
  const registeredMethod = data?.token_endpoint_auth_method === undefined ? "client_secret_basic" : data.token_endpoint_auth_method;
  const tokenAuthMethod = ["none", "client_secret_basic", "client_secret_post"].includes(registeredMethod) ? registeredMethod : "other";
  const hasClientSecret = Boolean(data?.client_secret);
  const validClientSecret = typeof data?.client_secret === "string" && data.client_secret.length > 0 && data.client_secret.length <= 16384 && !/[\x00-\x1f\x7f]/.test(data.client_secret);
  const redirectUrisPresent = Array.isArray(data?.redirect_uris);
  const redirectUriMatches = redirectUrisPresent && data.redirect_uris.includes(redirectUri);
  const reasons = [];
  if (![200, 201].includes(response?.status)) reasons.push("http-status");
  if (!clientIdValid) reasons.push("invalid-client-id");
  const methods = metadata?.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (tokenAuthMethod === "other" || !Array.isArray(methods) || !methods.includes(tokenAuthMethod)) reasons.push("unsupported-token-auth-method");
  if (tokenAuthMethod === "none" ? data?.client_secret !== undefined : !validClientSecret) reasons.push("invalid-client-secret");
  if (!redirectUriMatches) reasons.push("redirect-uri-mismatch");
  return { clientIdValid, tokenAuthMethod, hasClientSecret, redirectUrisPresent, redirectUriMatches, reasons };
}

class McpOAuthError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.network); this.name = "McpOAuthError"; this.code = code; }
}

function secureUrl(value) {
  if (typeof value !== "string" || value.length > 8192) throw new McpOAuthError("metadata");
  let url;
  try { url = new URL(value); } catch { throw new McpOAuthError("metadata"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /^(localhost|.*\.localhost)$/i.test(url.hostname)) {
    throw new McpOAuthError("metadata");
  }
  if ([...url.searchParams.keys()].some((key) => /^(?:token|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|secret|code|code_verifier)$/i.test(key))) throw new McpOAuthError("metadata");
  return url;
}

function oauthConfig(server) {
  secureUrl(server.endpoint);
  const registration = server.oauthRegistration ?? "automatic";
  const clientId = server.oauthClientId ?? "";
  const port = server.oauthCallbackPort ?? "";
  if (!["automatic", "existing"].includes(registration) || typeof clientId !== "string" || clientId.length > 2048 || /[\x00-\x20\x7f]/.test(clientId)) throw new McpOAuthError("client");
  if (registration === "existing" && !clientId) throw new McpOAuthError("client");
  if (port !== "" && (!Number.isInteger(Number(port)) || !/^[1-9][0-9]*$/.test(String(port)) || Number(port) > 65535)) throw new McpOAuthError("port");
  return { registration, clientId: registration === "existing" ? clientId : "", port: registration === "existing" && port !== "" ? Number(port) : 0 };
}

function bindingKey(server) {
  return JSON.stringify([server.id, server.transport, server.endpoint, server.authMode, server.authSecretName, server.enabled, oauthConfig(server), server.oauthSession]);
}

function scopes(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some((s) => typeof s !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(s))) throw new McpOAuthError("metadata");
  return [...new Set(value)].join(" ");
}

function wellKnown(base, kind, append = false) {
  const url = secureUrl(base);
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}${append ? path + "/.well-known/" + kind : "/.well-known/" + kind + path}${kind === "oauth-protected-resource" ? url.search : ""}`;
}

function validateResourceMapping(endpoint, resource) {
  const target = secureUrl(endpoint), candidate = secureUrl(resource);
  const parent = candidate.pathname.endsWith("/") ? candidate.pathname : candidate.pathname + "/";
  if (candidate.origin !== target.origin || (candidate.pathname !== target.pathname && !target.pathname.startsWith(parent))
    || (candidate.search && candidate.search !== target.search)) throw new McpOAuthError("metadata");
  return candidate.href;
}

function bearerParameters(header) {
  if (typeof header !== "string" || header.length > 8192) return [];
  const masked = header.replace(/"(?:[^"\\]|\\.)*"/g, (value) => " ".repeat(value.length));
  const starts = [...masked.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9_-]*)\s+(?=[A-Za-z])/g)];
  const records = [];
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index][1].toLowerCase() !== "bearer") continue;
    const part = header.slice(starts[index].index, starts[index + 1]?.index ?? header.length);
    const values = {};
    for (const match of part.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]+)/g)) {
      const key = match[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(values, key)) throw new McpOAuthError("metadata");
      values[key] = match[2].startsWith('"') ? match[2].slice(1, -1).replace(/\\(.)/g, "$1") : match[2];
    }
    records.push(values);
  }
  return records;
}

function resourceMetadataUrl(header) {
  const urls = bearerParameters(header).map((record) => record.resource_metadata).filter(Boolean);
  if (urls.length > 1) throw new McpOAuthError("metadata");
  return urls.length ? secureUrl(urls[0]).href : "";
}

async function discoverOAuth(endpoint, request, signal, verifiedResource) {
  const target = secureUrl(endpoint).href;
  const resource = verifiedResource === undefined ? target : validateResourceMapping(target, verifiedResource);
  const challenge = await request({ url: resource, method: "GET", signal });
  const hint = resourceMetadataUrl(challenge.headers?.["www-authenticate"] || "");
  const prmUrls = hint ? [hint] : [...new Set([wellKnown(resource, "oauth-protected-resource"), wellKnown(new URL(resource).origin, "oauth-protected-resource")])];
  let prm;
  for (const url of prmUrls) {
    const response = await request({ url, signal });
    if ([404, 405].includes(response.status) && !hint) continue;
    if (response.status !== 200) throw new McpOAuthError("metadata");
    prm = response.json; break;
  }
  if (!prm) throw new McpOAuthError("metadata");
  if (prm.resource !== resource) {
    // A mismatched document supplies only a candidate. Independently rediscover it once; never use its issuer/scopes.
    if (verifiedResource !== undefined) throw new McpOAuthError("metadata");
    const candidate = validateResourceMapping(target, prm.resource);
    const discovered = await discoverOAuth(target, request, signal, candidate);
    const requestedScope = bearerParameters(challenge.headers?.["www-authenticate"] || "").find((record) => record.scope !== undefined)?.scope;
    if (requestedScope !== undefined) discovered.scope = scopes(requestedScope.split(" ").filter(Boolean));
    return discovered;
  }
  if (!Array.isArray(prm.authorization_servers) || prm.authorization_servers.length !== 1) throw new McpOAuthError("metadata");
  const issuer = prm.authorization_servers[0];
  secureUrl(issuer);
  const candidates = [...new Set([wellKnown(issuer, "oauth-authorization-server"), wellKnown(issuer, "openid-configuration"), wellKnown(issuer, "openid-configuration", true)])];
  let metadata;
  for (const url of candidates) {
    const response = await request({ url, signal });
    if ([404, 405].includes(response.status)) continue;
    if (response.status !== 200) throw new McpOAuthError("metadata");
    metadata = response.json; break;
  }
  if (!metadata || metadata.issuer !== issuer || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) throw new McpOAuthError("metadata");
  secureUrl(metadata.authorization_endpoint); secureUrl(metadata.token_endpoint);
  if (metadata.registration_endpoint) secureUrl(metadata.registration_endpoint);
  const challengeScope = bearerParameters(challenge.headers?.["www-authenticate"] || "").find((record) => record.scope !== undefined)?.scope;
  const scope = challengeScope !== undefined ? scopes(challengeScope.split(" ").filter(Boolean)) : prm.scopes_supported ? scopes(prm.scopes_supported) : "";
  return { issuer, resource, scope, metadata };
}

function tokenAuth(metadata, clientId, clientSecret = "", registeredMethod = null) {
  const methods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (!Array.isArray(methods) || methods.some((m) => typeof m !== "string")) throw new McpOAuthError("metadata");
  const method = registeredMethod || (!clientSecret ? "none" : methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic");
  if (!methods.includes(method) || !["none", "client_secret_post", "client_secret_basic"].includes(method) || (method !== "none" && !clientSecret) || (method === "none" && clientSecret)) throw new McpOAuthError("client");
  const headers = {}, body = { client_id: clientId };
  if (method === "client_secret_post") body.client_secret = clientSecret;
  if (method === "client_secret_basic") {
    const form = (value) => new URLSearchParams({ x: value }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${form(clientId)}:${form(clientSecret)}`).toString("base64")}`;
    delete body.client_id;
  }
  return { method, headers, body };
}

function readTokens(response, now = Date.now()) {
  const json = response.json;
  if (response.status !== 200 || !json || typeof json.access_token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(json.access_token) || String(json.token_type).toLowerCase() !== "bearer") throw new McpOAuthError("tokens");
  if (json.refresh_token !== undefined && (typeof json.refresh_token !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(json.refresh_token))) throw new McpOAuthError("tokens");
  if (json.expires_in !== undefined && (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in) || json.expires_in <= 0 || json.expires_in > 31536000)) throw new McpOAuthError("tokens");
  return { accessToken: json.access_token, ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}), expiresAt: json.expires_in ? now + json.expires_in * 1000 : null };
}

module.exports = { McpOAuthError, bindingKey, discoverOAuth, oauthConfig, readTokens, registrationSummary, secureUrl, tokenAuth, validateResourceMapping };
