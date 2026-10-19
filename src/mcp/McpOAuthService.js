const { SecretStorageAccess } = require("../settings/SecretStorageAccess");
const { McpOAuthError, bindingKey, discoverOAuth, oauthConfig, readTokens, registrationSummary, secureUrl, tokenAuth, validateResourceMapping } = require("./McpOAuthProtocol");
const { desktopRequest, loadDesktop, loopbackCallback } = require("./McpOAuthDesktop");

const MAX_SECRET_BYTES = 65536;
const SAFE_ERROR_CODES = new Set(["unsupported", "metadata", "network", "redirect", "cancelled", "stale", "registration", "callback", "port", "tokens", "reconnect", "storage", "cleanup", "client"]);
const OAUTH_ERROR_CODES = new Set(["invalid_request", "invalid_client", "invalid_client_metadata", "invalid_redirect_uri", "unauthorized_client", "access_denied", "invalid_grant", "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable"]);
const REGISTRATION_REASONS = new Set(["endpoint-missing", "http-status", "invalid-client-id", "unsupported-token-auth-method", "invalid-client-secret", "redirect-uri-mismatch"]);
function safeSecret(value) {
  if (typeof value !== "string" || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new McpOAuthError("client");
  return value;
}

class McpOAuthService {
  constructor(options) {
    this.options = options;
    this.request = options.request || desktopRequest;
    this.callback = options.callback || loopbackCallback;
    this.access = new SecretStorageAccess(options.storage, () => new McpOAuthError("storage"), "codriver-mcp-oauth-", options.createId);
    this.states = new Map(); this.drafts = new WeakMap(); this.disposed = false;
  }

  async log(server, event, detail = {}) {
    // Project the event onto typed operational fields. Never pass request/response objects to the logger.
    const safe = {};
    if (typeof server?.id === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(server.id)) safe.serverId = server.id;
    for (const key of ["httpStatus", "scopeCount", "callbackPort", "responseBytes"]) {
      if (Number.isInteger(detail[key]) && detail[key] >= 0 && detail[key] <= 8388608) safe[key] = detail[key];
    }
    for (const key of ["clientIdValid", "hasClientSecret", "redirectUrisPresent", "redirectUriMatches", "registrationAvailable", "pkceS256", "issuerParameterRequired", "resourceMapped"]) {
      if (typeof detail[key] === "boolean") safe[key] = detail[key];
    }
    if (["none", "client_secret_post", "client_secret_basic", "missing", "other"].includes(detail.tokenAuthMethod)) safe.tokenAuthMethod = detail.tokenAuthMethod;
    if (["GET", "POST"].includes(detail.method)) safe.method = detail.method;
    if (["resource-probe", "protected-resource-metadata", "authorization-server-metadata"].includes(detail.requestKind)) safe.requestKind = detail.requestKind;
    if (SAFE_ERROR_CODES.has(detail.errorCode)) safe.errorCode = detail.errorCode;
    if (["invalid-request", "duplicate-parameters", "state-mismatch", "issuer-mismatch", "authorization-error", "timeout"].includes(detail.callbackFailure)) safe.callbackFailure = detail.callbackFailure;
    if (detail.oauthError !== undefined) safe.oauthError = OAUTH_ERROR_CODES.has(detail.oauthError) ? detail.oauthError : "other";
    if (Array.isArray(detail.reasons)) safe.reasons = detail.reasons.filter((reason) => REGISTRATION_REASONS.has(reason));
    try {
      const logger = typeof this.options.diagnostics === "function" ? this.options.diagnostics() : this.options.diagnostics;
      await logger?.debug?.(`mcp.oauth.${event}`, safe);
    } catch { /* Diagnostics must not affect authorization or cleanup. */ }
  }

  async loggedRequest(server, phase, options) {
    const requestKind = phase === "discovery"
      ? options.url.includes("/.well-known/oauth-protected-resource") ? "protected-resource-metadata"
        : options.url.includes("/.well-known/") ? "authorization-server-metadata" : "resource-probe"
      : undefined;
    const method = options.method || "GET";
    await this.log(server, `${phase}.request.started`, { method, requestKind });
    try {
      if (options.signal?.aborted) throw new McpOAuthError("cancelled");
      this.assertCurrent(server, this.state(server.id).generation, options.signal);
      const response = await this.request(options);
      await this.log(server, `${phase}.response.received`, {
        method, requestKind, httpStatus: response.status,
        responseBytes: typeof response.text === "string" ? Buffer.byteLength(response.text, "utf8") : undefined,
        ...(response.json?.error !== undefined ? { oauthError: response.json.error } : {})
      });
      return response;
    } catch (error) {
      await this.log(server, `${phase}.request.failed`, { method, requestKind, errorCode: error instanceof McpOAuthError ? error.code : "network" });
      throw error;
    }
  }

  supported() {
    try {
      if (this.disposed || !this.options.isSupported()) return false;
      this.access.assertStorage();
      if (!this.options.request) loadDesktop();
      return true;
    } catch { return false; }
  }

  assertSupported() { if (!this.supported()) throw new McpOAuthError("unsupported"); }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { generation: 0, status: "", controller: null, pending: null, refresh: null, blocked: false });
    return this.states.get(id);
  }
  invalidate(id) {
    const state = this.state(id);
    state.generation += 1; state.controller?.abort(); state.pending?.listener?.close(); state.pending = null;
    state.controller = null; state.status = "";
    state.refresh = null;
  }
  dispose() { for (const id of this.states.keys()) this.invalidate(id); this.disposed = true; }
  assertCurrent(server, generation, signal) {
    if (signal?.aborted) throw new McpOAuthError("cancelled");
    const live = this.options.getServer(server.id);
    if (this.disposed || this.state(server.id).generation !== generation || !live || live.enabled === false || bindingKey(live) !== bindingKey(server)) throw new McpOAuthError("stale");
  }
  read(server) {
    this.assertSupported();
    if (!server.authSecretName) return null;
    if (this.shared(server.authSecretName, server.id)) throw new McpOAuthError("storage");
    let value;
    try {
      const raw = this.access.read(server.authSecretName);
      if (!raw) return null;
      if (Buffer.byteLength(raw, "utf8") > MAX_SECRET_BYTES) throw new Error();
      value = JSON.parse(raw);
      if (!value || value.version !== 2 || typeof value.clientSecret !== "string" || Object.keys(value).some((key) => !["version", "clientSecret", "accessToken", "refreshToken", "expiresAt"].includes(key))) throw new Error();
      safeSecret(value.clientSecret);
      if (value.accessToken && (typeof value.accessToken !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(value.accessToken))) throw new Error();
      if (value.refreshToken && (typeof value.refreshToken !== "string" || !/^[\x21-\x7e]{1,32768}$/.test(value.refreshToken))) throw new Error();
      if (value.expiresAt !== null && value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= 0)) throw new Error();
      return value;
    } catch (error) { if (error instanceof McpOAuthError) throw error; throw new McpOAuthError("storage"); }
  }
  encode(value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_SECRET_BYTES) throw new McpOAuthError("storage");
    return text;
  }
  shared(name, id) { return this.options.isShared?.(name, id) === true; }
  registration(server) {
    const session = server.oauthSession, config = oauthConfig(server);
    const clientId = config.registration === "existing" ? config.clientId : session?.clientId;
    if (!session || typeof clientId !== "string" || !clientId || clientId.length > 2048 || /[\x00-\x20\x7f]/.test(clientId)
      || !["none", "client_secret_basic", "client_secret_post"].includes(session.tokenAuthMethod)) throw new McpOAuthError("reconnect");
    secureUrl(session.issuer);
    const resource = validateResourceMapping(server.endpoint, session.resource ?? secureUrl(server.endpoint).href);
    return { clientId, issuer: session.issuer, tokenAuthMethod: session.tokenAuthMethod, resource };
  }
  locked(server) {
    const value = this.read(server);
    return server.oauthSession?.connected === true || Boolean(value?.accessToken || value?.refreshToken);
  }
  async write(server, value, generation, signal, session) {
    const text = this.encode(value);
    await this.options.queue(async () => {
      this.assertCurrent(server, generation, signal);
      if (!server.authSecretName || this.shared(server.authSecretName, server.id)) throw new McpOAuthError("storage");
      if (session !== undefined) {
        try {
          await this.options.saveSession(server, session, () => this.assertCurrent(server, generation, signal));
          server.oauthSession = session;
          this.assertCurrent(server, generation, signal);
        } catch (error) {
          if (this.state(server.id).generation === generation) this.state(server.id).blocked = true;
          throw error instanceof McpOAuthError ? error : new McpOAuthError("storage");
        }
      }
      try {
        this.options.storage.setSecret(server.authSecretName, text);
        if (this.access.read(server.authSecretName) !== text) throw new Error();
      } catch { this.state(server.id).blocked = true; await this.log(server, "storage.failed", { errorCode: "storage" }); throw new McpOAuthError("storage"); }
      this.assertCurrent(server, generation, signal);
      await this.log(server, "storage.verified");
      this.assertCurrent(server, generation, signal);
    });
  }
  async prepareDraft(draft, existing) {
    this.assertSupported();
    oauthConfig(draft);
    if (draft.transport !== "http") throw new McpOAuthError("client");
    const value = safeSecret(draft.credentialInput ?? "");
    const keep = existing?.authMode === "oauth" && draft.credentialAction !== "replace";
    const old = keep ? this.read(existing) : null;
    const same = keep && existing.endpoint === draft.endpoint && JSON.stringify(oauthConfig(existing)) === JSON.stringify(oauthConfig(draft));
    if (same && old) return { ...draft, oauthSession: existing.oauthSession, authSecretName: existing.authSecretName, credentialInput: undefined, credentialAction: undefined };
    const sameClient = keep && existing.endpoint === draft.endpoint && oauthConfig(existing).clientId === oauthConfig(draft).clientId;
    const bundle = { version: 2, clientSecret: oauthConfig(draft).registration === "existing" ? (keep ? (sameClient ? old?.clientSecret || "" : "") : value) : "" };
    let staged = this.drafts.get(draft);
    const encoded = this.encode(bundle);
    if (!staged || staged.encoded !== encoded || this.access.read(staged.name) !== encoded) {
      staged = { name: this.access.allocate(), encoded }; this.access.writeVerified(staged.name, encoded); this.drafts.set(draft, staged);
    }
    const candidate = { ...draft, credentialSchemaVersion: 1, authSecretName: staged.name };
    delete candidate.oauthSession;
    for (const key of ["credentialInput", "credentialAction", "headers", "migrationSecretName", "authHeaderPolicy"]) delete candidate[key];
    return candidate;
  }
  verifyDraft(draft, candidate) {
    const staged = this.drafts.get(draft);
    if (staged && candidate.authSecretName === staged.name && this.access.read(staged.name) !== staged.encoded) throw new McpOAuthError("storage");
    this.read(candidate);
  }
  status(server) {
    if (!this.supported()) return "Unsupported";
    const state = this.state(server.id);
    if (state.blocked) return "Cleanup required";
    if (state.status) return state.status;
    try {
      const value = this.read(server);
      return value?.accessToken ? (value.expiresAt && value.expiresAt <= Date.now() && !value.refreshToken ? "Reconnect required" : "Connected") : "Not connected";
    } catch { return "Cleanup required"; }
  }
  async prepare(server) {
    this.assertSupported(); this.invalidate(server.id);
    const state = this.state(server.id); state.controller = new AbortController();
    const generation = state.generation, signal = state.controller.signal;
    this.assertCurrent(server, generation, signal);
    state.status = "Preparing authorization";
    try {
      await this.log(server, "connection.started");
      this.assertCurrent(server, generation, signal);
      const discovered = await discoverOAuth(server.endpoint, (options) => this.loggedRequest(server, "discovery", options), signal);
      await this.log(server, "discovery.completed", { pkceS256: true, registrationAvailable: Boolean(discovered.metadata.registration_endpoint),
        scopeCount: discovered.scope ? discovered.scope.split(" ").length : 0, resourceMapped: discovered.resource !== secureUrl(server.endpoint).href });
      this.assertCurrent(server, generation, signal);
      const { crypto } = loadDesktop();
      const random = crypto.randomBytes(32).toString("base64url");
      const verifier = crypto.randomBytes(32).toString("base64url");
      const listener = await this.callback({ port: oauthConfig(server).port, state: random, issuer: discovered.issuer,
        requireIssuer: discovered.metadata.authorization_response_iss_parameter_supported === true, signal,
        onRejected: (callbackFailure) => { void this.log(server, "callback.rejected", { callbackFailure }); } });
      await this.log(server, "callback.listening", { callbackPort: Number(new URL(listener.redirectUri).port), issuerParameterRequired: discovered.metadata.authorization_response_iss_parameter_supported === true });
      try { this.assertCurrent(server, generation, signal); } catch (error) { listener.close(); throw error; }
      state.pending = { discovered, listener, random, verifier, generation, server: { ...server }, createdAt: Date.now() };
      void listener.code.catch(() => { if (state.generation === generation && state.status === "Ready to authorize") this.cancel(server.id); });
      state.status = "Ready to authorize";
      return { issuer: discovered.issuer, scope: discovered.scope, redirectUri: listener.redirectUri, endpoint: secureUrl(server.endpoint).href, resource: discovered.resource };
    } catch (error) { await this.log(server, "connection.failed", { errorCode: error instanceof McpOAuthError ? error.code : "network" }); this.cancel(server.id); throw error instanceof McpOAuthError ? error : new McpOAuthError("network"); }
  }
  cancel(id) { this.invalidate(id); void this.log({ id }, "connection.cancelled"); }
  async authorize(server, openBrowser) {
    const state = this.state(server.id), pending = state.pending;
    if (!pending || Date.now() - pending.createdAt > 600000 || state.status !== "Ready to authorize") throw new McpOAuthError("stale");
    const { generation, discovered, listener, verifier, random } = pending;
    const signal = state.controller.signal;
    state.status = "Connecting";
    try {
      this.assertCurrent(server, generation, signal);
      const config = oauthConfig(server), saved = this.read(server);
      let clientId = config.clientId, method, clientSecret = saved?.clientSecret || "";
      if (config.registration === "automatic") {
        if (!discovered.metadata.registration_endpoint) { await this.log(server, "registration.failed", { reasons: ["endpoint-missing"] }); throw new McpOAuthError("registration"); }
        const registration = await this.loggedRequest(server, "registration", { url: discovered.metadata.registration_endpoint, method: "POST", signal,
          headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ client_name: "CoDriver", application_type: "native",
            redirect_uris: [listener.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
        const data = registration.json;
        const summary = registrationSummary(registration, listener.redirectUri, discovered.metadata);
        if (summary.reasons.length) {
          await this.log(server, "registration.failed", { ...summary, httpStatus: registration.status,
            ...(data?.error !== undefined ? { oauthError: data.error } : {}) });
          throw new McpOAuthError("registration");
        }
        await this.log(server, "registration.completed", summary);
        clientId = data.client_id; method = summary.tokenAuthMethod;
        clientSecret = method === "none" ? "" : safeSecret(data.client_secret);
      }
      const authentication = tokenAuth(discovered.metadata, clientId, clientSecret, method);
      // Persist secrets and nonsecret registration separately before browser launch.
      await this.write(server, { version: 2, clientSecret }, generation, signal, {
        issuer: discovered.issuer, tokenAuthMethod: authentication.method, connected: false, resource: discovered.resource,
        ...(config.registration === "automatic" ? { clientId } : {})
      });
      this.assertCurrent(server, generation, signal);
      const { crypto } = loadDesktop();
      const url = secureUrl(discovered.metadata.authorization_endpoint);
      const params = { response_type: "code", client_id: clientId, redirect_uri: listener.redirectUri, state: random,
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: discovered.resource };
      if (discovered.scope) params.scope = discovered.scope;
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      state.status = "Waiting for browser";
      await openBrowser(url.href);
      await this.log(server, "browser.opened");
      const code = await listener.code;
      await this.log(server, "callback.received");
      this.assertCurrent(server, generation, signal);
      state.status = "Connecting";
      const response = await this.loggedRequest(server, "token.exchange", { url: discovered.metadata.token_endpoint, method: "POST", signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...authentication.headers },
        body: new URLSearchParams({ ...authentication.body, grant_type: "authorization_code", code, code_verifier: verifier,
          redirect_uri: listener.redirectUri, resource: discovered.resource }).toString() });
      const tokens = readTokens(response);
      await this.write(server, { version: 2, clientSecret, ...tokens }, generation, signal, { ...server.oauthSession, connected: true });
      state.blocked = false; state.status = "Connected";
      await this.log(server, "connection.completed");
    } catch (error) {
      await this.log(server, "connection.failed", { errorCode: error instanceof McpOAuthError ? error.code : "network" });
      if (state.generation === generation) state.status = state.blocked ? "Cleanup required" : "Reconnect required";
      throw error instanceof McpOAuthError ? error : new McpOAuthError("network");
    } finally {
      listener.close();
      await this.log(server, "callback.closed");
      if (state.generation === generation) { state.pending = null; state.controller = null; }
    }
  }
  async disconnect(server) {
    this.assertSupported(); this.invalidate(server.id);
    const state = this.state(server.id), generation = state.generation;
    state.blocked = true; state.status = "Cleanup required";
    await this.log(server, "disconnect.started");
    const old = this.read(server);
    await this.write(server, { version: 2, clientSecret: old?.clientSecret || "" }, generation, undefined,
      server.oauthSession ? { ...server.oauthSession, connected: false } : undefined);
    state.blocked = false; state.status = "Not connected";
    await this.log(server, "disconnect.completed");
  }
  async headers(server, signal) {
    this.assertSupported();
    const state = this.state(server.id), generation = state.generation;
    this.assertCurrent(server, generation, signal);
    if (state.blocked) throw new McpOAuthError("cleanup");
    let saved = this.read(server);
    if (!saved?.accessToken) throw new McpOAuthError("reconnect");
    this.registration(server);
    if (saved.expiresAt && saved.expiresAt <= Date.now() + 30000) {
      if (!saved.refreshToken) { state.status = "Reconnect required"; throw new McpOAuthError("reconnect"); }
      if (!state.refresh) {
        const operation = this.refresh(server, saved, generation, signal).finally(() => { if (state.refresh === operation) state.refresh = null; });
        state.refresh = operation;
      }
      await state.refresh;
      this.assertCurrent(server, generation, signal); saved = this.read(server);
    }
    this.assertCurrent(server, generation, signal);
    return { Authorization: `Bearer ${saved.accessToken}` };
  }
  async refresh(server, saved, generation, signal) {
    this.assertCurrent(server, generation, signal);
    const state = this.state(server.id), controller = new AbortController();
    state.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.log(server, "refresh.started");
      this.assertCurrent(server, generation, controller.signal);
      const registration = this.registration(server);
      const discovery = await discoverOAuth(server.endpoint, (options) => this.loggedRequest(server, "discovery", options), controller.signal, registration.resource);
      if (discovery.issuer !== registration.issuer || discovery.resource !== registration.resource) throw new McpOAuthError("stale");
      const auth = tokenAuth(discovery.metadata, registration.clientId, saved.clientSecret, registration.tokenAuthMethod);
      this.assertCurrent(server, generation, controller.signal);
      const response = await this.loggedRequest(server, "refresh", { url: discovery.metadata.token_endpoint, method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...auth.headers },
        body: new URLSearchParams({ ...auth.body, grant_type: "refresh_token", refresh_token: saved.refreshToken, resource: discovery.resource }).toString() });
      if (response.json?.error === "invalid_grant") {
        await this.write(server, { version: 2, clientSecret: saved.clientSecret }, generation, controller.signal);
        throw new McpOAuthError("reconnect");
      }
      await this.write(server, { ...saved, ...readTokens(response) }, generation, controller.signal);
      state.status = "Connected";
      await this.log(server, "refresh.completed");
    } catch (error) {
      await this.log(server, "refresh.failed", { errorCode: error instanceof McpOAuthError ? error.code : "network" });
      if (state.generation === generation) { state.blocked = true; state.status = "Reconnect required"; }
      throw error instanceof McpOAuthError ? error : new McpOAuthError("network");
    } finally { signal?.removeEventListener("abort", abort); if (state.controller === controller) state.controller = null; }
  }
  async requestMcp(server, options) {
    const state = this.state(server.id), generation = state.generation;
    const authorization = await this.headers(server, options.signal);
    this.assertCurrent(server, generation, options.signal);
    const response = await this.request({ ...options, url: server.endpoint, headers: { ...options.headers, ...authorization }, maxBytes: 8388608 });
    if ([401, 403].includes(response.status)) { state.blocked = true; state.status = "Reconnect required"; await this.log(server, "authorization.failed", { httpStatus: response.status, errorCode: "reconnect" }); throw new McpOAuthError("reconnect"); }
    this.assertCurrent(server, generation, options.signal);
    return response;
  }
}

module.exports = { MAX_SECRET_BYTES, McpOAuthService, safeSecret };
