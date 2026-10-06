const { SecretStorageAccess } = require("../settings/SecretStorageAccess");
const CREDENTIAL_SCHEMA_VERSION = 1;
const RESERVED_HEADERS = new Set(["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "host", "content-length"]);

class McpCredentialError extends Error {
  constructor(code) {
    const messages = {
      "storage-unavailable": "MCP secret storage is unavailable. Update Obsidian and retry.",
      "storage-error": "Unable to read or write MCP secret storage. Retry migration or replace the credential.",
      "verification-failed": "MCP secret verification failed. Existing settings were preserved.",
      "secret-missing": "MCP credential is missing. Replace it in MCP settings.",
      "invalid-credential": "MCP credential configuration is invalid. Review MCP settings.",
      "needs-review": "MCP headers or endpoint need review before migration.",
      "migration-pending": "MCP credentials need migration. Retry in MCP settings.",
      "save-failed": "Unable to save MCP settings. Existing credentials were preserved. Retry."
    };
    super(messages[code] || messages["invalid-credential"]);
    this.name = "McpCredentialError";
    this.code = code;
  }
}

function parseHeaderLines(value) {
  const headers = {};
  for (const raw of String(value ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (key && headerValue) Object.defineProperty(headers, key, {
      value: headerValue, enumerable: true, configurable: true, writable: true
    });
  }
  return headers;
}

function validateHeaders(text, legacy = false) {
  if (typeof text !== "string" || !text.trim()) throw new McpCredentialError("invalid-credential");
  const names = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const separator = raw.indexOf(":");
    const name = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    const folded = name.toLowerCase();
    if (separator <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value || /[\x00-\x1f\x7f]/.test(value) || RESERVED_HEADERS.has(folded)) {
      throw new McpCredentialError(legacy ? "needs-review" : "invalid-credential");
    }
    if (names.has(folded) && (!legacy || names.get(folded) !== name)) {
      throw new McpCredentialError(legacy ? "needs-review" : "invalid-credential");
    }
    names.set(folded, name);
  }
  return parseHeaderLines(text);
}

function validateCredential(value, mode, headerPolicy) {
  if (mode === "bearer" && headerPolicy == null && typeof value === "string" && /^[\x21-\x7e]+$/.test(value)) {
    return { Authorization: `Bearer ${value}` };
  }
  if (mode === "custom-headers" && (headerPolicy == null || ["strict", "legacy"].includes(headerPolicy))) {
    return validateHeaders(value, headerPolicy === "legacy");
  }
  throw new McpCredentialError("invalid-credential");
}

function endpointNeedsReview(endpoint) {
  try {
    const url = new URL(endpoint);
    return Boolean(url.username || url.password) || [...url.searchParams.keys()].some((key) => /^(?:access[_-]?token|token|api[_-]?key|password|secret)$/i.test(key));
  } catch {
    return false;
  }
}

function legacyHeaderText(server) {
  if (server?.headers != null && typeof server.headers !== "string") throw new McpCredentialError("needs-review");
  return server?.headers || "";
}

class McpCredentialService {
  constructor(secretStorage, options = {}) {
    this.storage = secretStorage;
    this.stagedDrafts = new WeakMap();
    this.access = new SecretStorageAccess(secretStorage, (code) => new McpCredentialError(code), "codriver-mcp-", options.createId);
  }

  assertStorage() {
    this.access.assertStorage();
  }

  read(name) {
    return this.access.read(name);
  }

  allocate() {
    return this.access.allocate();
  }

  writeVerified(name, value) {
    this.access.writeVerified(name, value);
  }

  resolveHeaders(server) {
    return this.resolveCredential(server).headers;
  }

  readInputValue(server) {
    return this.resolveCredential(server).value;
  }

  resolveCredential(server) {
    const legacy = legacyHeaderText(server);
    if (endpointNeedsReview(server?.endpoint)) throw new McpCredentialError("needs-review");
    if (server?.credentialSchemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
      if (server?.credentialSchemaVersion != null) throw new McpCredentialError("invalid-credential");
      if (legacy.trim() || server?.migrationSecretName) throw new McpCredentialError("migration-pending");
      if (server?.authSecretName || (server?.authMode && server.authMode !== "none") || server?.authHeaderPolicy != null) throw new McpCredentialError("invalid-credential");
      return { value: "", headers: {} };
    }
    if (legacy.trim()) throw new McpCredentialError("migration-pending");
    if (server.authMode === "none" && !server.authSecretName && server.authHeaderPolicy == null) return { value: "", headers: {} };
    if (!["bearer", "custom-headers"].includes(server.authMode)) throw new McpCredentialError("invalid-credential");
    const value = this.read(server.authSecretName);
    if (typeof value !== "string" || !value) throw new McpCredentialError("secret-missing");
    return { value, headers: validateCredential(value, server.authMode, server.authHeaderPolicy) };
  }

  getStatus(server) {
    if (server.transport !== "http") {
      try { return legacyHeaderText(server).trim() ? "Inactive HTTP credentials need migration. Retry in MCP settings." : ""; }
      catch { return "Inactive HTTP configuration needs review in MCP settings."; }
    }
    try { this.resolveHeaders(server); return ""; } catch (error) {
      return error instanceof McpCredentialError ? error.message : "MCP credentials are unavailable.";
    }
  }

  async migrateServer(server, persist) {
    const legacy = legacyHeaderText(server);
    if (server.credentialSchemaVersion != null) {
      if (server.credentialSchemaVersion !== 1) throw new McpCredentialError("invalid-credential");
      if (legacy.trim()) throw new McpCredentialError("needs-review");
      return server;
    }
    if (server.transport === "http" && endpointNeedsReview(server.endpoint)) throw new McpCredentialError("needs-review");
    if (server.authSecretName || server.authHeaderPolicy != null || (server.authMode && server.authMode !== "none" && !(server.authMode === "custom-headers" && legacy.trim()))) throw new McpCredentialError("needs-review");
    const candidate = { ...server, credentialSchemaVersion: 1, authMode: "none", authSecretName: "" };
    let verify = null;
    if (legacy.trim()) {
      validateHeaders(legacy, true);
      const value = legacy;
      let name = server.migrationSecretName;
      if (!name || (this.read(name) !== null && this.read(name) !== value)) name = this.allocate();
      const intent = { ...server, migrationSecretName: name };
      await persist(intent);
      this.writeVerified(name, value);
      candidate.authMode = "custom-headers";
      candidate.authSecretName = name;
      candidate.authHeaderPolicy = "legacy";
      verify = () => this.assertVerifiedValue(name, value);
    }
    delete candidate.headers;
    delete candidate.migrationSecretName;
    delete candidate.migrationState;
    await persist(candidate, verify);
    return candidate;
  }

  assertVerifiedValue(name, value) {
    if (this.read(name) !== value) throw new McpCredentialError("verification-failed");
  }

  verifyDraft(draft, candidate) {
    const staged = this.stagedDrafts.get(draft);
    if (draft.credentialAction === "replace" && candidate.authSecretName === staged?.name) {
      this.assertVerifiedValue(staged.name, staged.value);
    }
    if (candidate.transport === "http") this.resolveHeaders(candidate);
  }

  async prepareDraft(draft, existing) {
    const candidate = { ...draft };
    const input = candidate.credentialInput;
    const action = candidate.credentialAction || "keep";
    delete candidate.credentialInput;
    delete candidate.credentialAction;
    if (candidate.transport !== "http") return candidate;
    if (endpointNeedsReview(candidate.endpoint)) throw new McpCredentialError("needs-review");
    if (action === "replace") {
      delete candidate.authHeaderPolicy;
      validateCredential(input, candidate.authMode);
      const value = input;
      const staged = this.stagedDrafts.get(draft);
      let name = staged?.value === value ? staged.name : null;
      if (name && this.read(name) !== null && this.read(name) !== value) name = null;
      name ||= this.allocate();
      this.stagedDrafts.set(draft, { name, value });
      this.writeVerified(name, value);
      candidate.authSecretName = name;
    } else if (action === "clear" || candidate.authMode === "none") {
      candidate.authMode = "none";
      candidate.authSecretName = "";
      delete candidate.authHeaderPolicy;
    } else {
      if (!existing || existing.credentialSchemaVersion !== 1 || existing.authMode !== candidate.authMode) throw new McpCredentialError("invalid-credential");
      candidate.authSecretName = existing.authSecretName;
      if (existing.authHeaderPolicy != null) candidate.authHeaderPolicy = existing.authHeaderPolicy;
      else delete candidate.authHeaderPolicy;
    }
    candidate.credentialSchemaVersion = 1;
    delete candidate.headers;
    delete candidate.migrationSecretName;
    delete candidate.migrationState;
    this.resolveHeaders(candidate);
    return candidate;
  }
}

module.exports = { CREDENTIAL_SCHEMA_VERSION, McpCredentialError, McpCredentialService, endpointNeedsReview, parseHeaderLines, validateHeaders, validateCredential };
