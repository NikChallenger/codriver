class ConnectionRemovalError extends Error {
  constructor(code) {
    super({
      stale: "Connection changed. Close this confirmation and review it again.",
      "stale-save": "Settings changed while saving. The saved connection may have been removed; the secret was preserved. Refresh Settings.",
      shared: "This secret is used by another CoDriver connection.",
      storage: "Unable to remove the secret. Retry or keep the secret.",
      save: "Unable to delete the connection. The secret was preserved."
    }[code]);
    this.code = code;
  }
}

// Reviews and retries live only for the lifetime of their confirmation.
class ConnectionRemoval {
  constructor(plugin, persist) {
    this.plugin = plugin;
    this.persist = persist;
    this.reviews = new WeakMap();
  }

  entries(kind) {
    return this.plugin.settings[kind === "provider" ? "providers" : "mcpServers"];
  }

  shared(name, kind = null, id = null) {
    if (!name) return false;
    return this.plugin.settings.providers.some((item) =>
      !(kind === "provider" && item.id === id) && item.apiKeySecretName === name)
      || this.plugin.settings.mcpServers.some((item) =>
        !(kind === "MCP server" && item.id === id)
        && (item.authSecretName === name || item.migrationSecretName === name));
  }

  prepare(kind, id) {
    if (!["provider", "MCP server"].includes(kind)) throw new ConnectionRemovalError("stale");
    const matches = this.entries(kind).filter((item) => item.id === id);
    if (matches.length !== 1) throw new ConnectionRemovalError("stale");
    const entry = matches[0];
    const secretName = (kind === "provider" ? entry.apiKeySecretName : entry.authSecretName) || "";
    const review = Object.freeze({ kind, id, secretName, shared: this.shared(secretName, kind, id) });
    this.reviews.set(review, { kind, id, expected: JSON.stringify(entry), phase: "initial" });
    return review;
  }

  queue(action) {
    const pending = (this.plugin.settingsWritePromise || Promise.resolve()).then(action);
    this.plugin.settingsWritePromise = pending.catch(() => {});
    return pending;
  }

  forget(review) {
    const state = this.reviews.get(review);
    if (state) delete state.secretValue;
    this.reviews.delete(review);
  }

  clear(name, expected) {
    try {
      const storage = this.plugin.app?.secretStorage;
      if (typeof storage?.getSecret !== "function" || typeof storage?.listSecrets !== "function") throw new Error();
      const current = storage.getSecret(name);
      if (current !== null && typeof current !== "string") throw new Error();
      if (current !== expected && current !== "" && current !== null) throw new Error();
      const names = storage.listSecrets();
      if (!Array.isArray(names) || names.some((entry) => typeof entry !== "string")) throw new Error();
      if (current === null && !names.includes(name)) return "missing";
      if (typeof storage.deleteSecret === "function") {
        storage.deleteSecret(name);
        if (storage.getSecret(name) !== null || storage.listSecrets().includes(name)) throw new Error();
        return "deleted";
      }
      if (typeof storage.setSecret !== "function") throw new Error();
      storage.setSecret(name, "");
      const value = storage.getSecret(name);
      if (value !== "" && !(value === null && !storage.listSecrets().includes(name))) throw new Error();
      return "cleared";
    } catch { throw new ConnectionRemovalError("storage"); }
  }

  execute(review, removeSecret, retry = false, signal = null) {
    return this.queue(async () => {
      const state = this.reviews.get(review);
      if (signal?.aborted) throw new ConnectionRemovalError("stale");
      if (!state || state.phase !== (retry ? "removed" : "initial")) throw new ConnectionRemovalError("stale");
      if (!retry) {
        const matches = this.entries(state.kind).filter((item) => item.id === state.id);
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== state.expected) throw new ConnectionRemovalError("stale");
        if (removeSecret && review.secretName && this.shared(review.secretName, state.kind, state.id)) throw new ConnectionRemovalError("shared");
        if (removeSecret && review.secretName) {
          try {
            state.secretValue = this.plugin.app.secretStorage.getSecret(review.secretName);
            if (state.secretValue !== null && typeof state.secretValue !== "string") throw new Error();
          } catch { throw new ConnectionRemovalError("storage"); }
        }
        this.plugin.assertProviderMigrationComplete();
        const key = state.kind === "provider" ? "providers" : "mcpServers";
        const expectedSettings = JSON.stringify(this.plugin.settings);
        const snapshot = { ...this.plugin.settings, [key]: this.entries(state.kind).filter((item) => item.id !== state.id) };
        if (state.kind === "provider" && snapshot.selectedProviderId === state.id) {
          const next = snapshot.providers.find((item) => item.enabled !== false);
          snapshot.selectedProviderId = next?.id ?? null;
          snapshot.selectedModelId = next?.model || null;
        }
        let saved;
        try { saved = await this.persist(snapshot); }
        catch { throw new ConnectionRemovalError("save"); }
        // Do not clean a credential after an unqueued edit during persistence.
        const live = this.entries(state.kind).filter((item) => item.id === state.id);
        state.phase = "removed";
        if (live.length !== 1 || JSON.stringify(live[0]) !== state.expected || JSON.stringify(this.plugin.settings) !== expectedSettings) {
          state.phase = "done";
          delete state.secretValue;
          throw new ConnectionRemovalError("stale-save");
        }
        this.plugin.settings = saved;
        if (!removeSecret || !review.secretName) {
          state.phase = "done";
          return { removed: true };
        }
      }
      try {
        if (signal?.aborted) throw new ConnectionRemovalError("stale");
        if (this.entries(state.kind).some((item) => item.id === state.id)) throw new ConnectionRemovalError("stale");
        if (this.shared(review.secretName)) throw new ConnectionRemovalError("shared");
        const outcome = this.clear(review.secretName, state.secretValue);
        state.phase = "done";
        delete state.secretValue;
        return { removed: true, outcome };
      } catch {
        return { removed: true, cleanupPending: true };
      }
    });
  }
}

module.exports = { ConnectionRemoval, ConnectionRemovalError };
