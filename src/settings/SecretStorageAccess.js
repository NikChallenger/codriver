const SECRET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Shared mechanics only: callers own payload validation and safe error messages.
class SecretStorageAccess {
  constructor(storage, error, prefix, createId = null) {
    this.storage = storage;
    this.error = error;
    this.prefix = prefix;
    this.createId = createId || (() => {
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return `${prefix}${id.toLowerCase()}`;
    });
  }

  assertStorage() {
    if (!["getSecret", "setSecret", "listSecrets"].every((method) => typeof this.storage?.[method] === "function")) {
      throw this.error("storage-unavailable");
    }
  }

  read(name) {
    this.assertStorage();
    if (!SECRET_ID_PATTERN.test(name || "")) throw this.error("invalid-credential");
    try {
      const value = this.storage.getSecret(name);
      if (value !== null && typeof value !== "string") throw this.error("storage-error");
      return value;
    } catch { throw this.error("storage-error"); }
  }

  list() {
    this.assertStorage();
    try {
      const names = this.storage.listSecrets();
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw this.error("storage-error");
      return names;
    } catch { throw this.error("storage-error"); }
  }

  allocate() {
    const occupied = this.list();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = this.createId();
      if (SECRET_ID_PATTERN.test(name) && !occupied.includes(name) && this.read(name) === null) return name;
    }
    throw this.error("storage-error");
  }

  writeVerified(name, value) {
    const previous = this.read(name);
    if (previous !== null && previous !== value) throw this.error("verification-failed");
    try { if (previous === null) this.storage.setSecret(name, value); } catch { throw this.error("storage-error"); }
    if (this.read(name) !== value) throw this.error("verification-failed");
  }
}

module.exports = { SecretStorageAccess };
