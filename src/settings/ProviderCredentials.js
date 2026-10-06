const { SecretStorageAccess } = require("./SecretStorageAccess");

class ProviderCredentialError extends Error {
  constructor(code) {
    const messages = {
      "storage-unavailable": "Provider secret storage is unavailable. Update Obsidian and retry.",
      "storage-error": "Unable to access provider secret storage. Retry or replace the API key.",
      "verification-failed": "Provider key verification failed. Existing credentials were preserved.",
      "secret-missing": "The saved provider API key is missing. Replace or clear it explicitly.",
      "invalid-credential": "Provider API key configuration is invalid. Review provider settings.",
      "needs-review": "Legacy provider credentials need review. Replace or clear the API key explicitly.",
      "migration-pending": "Provider key migration is pending. Retry migration in provider settings.",
      "save-failed": "Unable to save provider settings. Existing credentials were preserved. Retry.",
      "other-pending": "Other legacy provider keys need attention. This change is prepared; resolve the remaining keys and retry migration."
    };
    super(messages[code] || messages["invalid-credential"]);
    this.name = "ProviderCredentialError";
    this.code = code;
  }
}

function validateKey(value) {
  if (typeof value !== "string" || !value || /[\x00-\x20\x7f]/.test(value)) {
    throw new ProviderCredentialError("invalid-credential");
  }
  return value;
}

class ProviderCredentialService {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.access = new SecretStorageAccess(storage, (code) => new ProviderCredentialError(code), "codriver-provider-", options.createId);
    this.stagedDrafts = new WeakMap();
    this.migrationNames = new Map();
  }

  // Existing user-created names are opaque references; only new IDs use our pattern.
  readReference(name) {
    if (typeof name !== "string" || !name) throw new ProviderCredentialError("invalid-credential");
    if (typeof this.storage?.getSecret !== "function") throw new ProviderCredentialError("storage-unavailable");
    let value;
    try { value = this.storage.getSecret(name); } catch { throw new ProviderCredentialError("storage-error"); }
    if (value === null || value === "") throw new ProviderCredentialError("secret-missing");
    return validateKey(value);
  }

  resolve(provider) {
    return provider.apiKeySecretName ? this.readReference(provider.apiKeySecretName) : "";
  }

  prepareDraft(draft, existing) {
    const candidate = { ...draft };
    delete candidate.credentialInput;
    delete candidate.credentialAction;
    const action = draft.credentialAction || "keep";
    if (action === "keep") candidate.apiKeySecretName = existing?.apiKeySecretName ?? draft.apiKeySecretName ?? "";
    else if (action === "clear") candidate.apiKeySecretName = "";
    else if (action === "replace") {
      const value = validateKey(draft.credentialInput);
      const staged = this.stagedDrafts.get(draft);
      let name = staged?.value === value ? staged.name : null;
      if (name && this.access.read(name) !== null && this.access.read(name) !== value) name = null;
      name ||= this.access.allocate();
      // Retain intent before verification so retries do not overwrite another secret.
      this.stagedDrafts.set(draft, { name, value });
      this.access.writeVerified(name, value);
      candidate.apiKeySecretName = name;
    } else throw new ProviderCredentialError("invalid-credential");
    delete candidate.apiKey;
    return candidate;
  }

  migrate(provider, raw) {
    if (raw === "") return { ...provider };
    const key = validateKey(raw);
    if (provider.apiKeySecretName) {
      try {
        const current = this.readReference(provider.apiKeySecretName);
        if (current !== key) throw new ProviderCredentialError("needs-review");
        return { ...provider };
      } catch (error) {
        if (error.code !== "secret-missing") throw error;
      }
    }
    let name = this.migrationNames.get(provider);
    if (name && this.access.read(name) !== null && this.access.read(name) !== key) name = null;
    if (!name) {
      // Reuse a verified orphan from a failed settings commit after restart.
      name = this.access.list().find((entry) => /^codriver-provider-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry) && this.access.read(entry) === key)
        || this.access.allocate();
      this.migrationNames.set(provider, name);
    }
    this.access.writeVerified(name, key);
    return { ...provider, apiKeySecretName: name };
  }
}

module.exports = { ProviderCredentialError, ProviderCredentialService, validateKey };
