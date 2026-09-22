function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `change-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function currentTimeLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function createPendingChangeProposal(notePath, before, after, changes = null) {
  const normalizedChanges = Array.isArray(changes)
    ? changes.map(normalizeTextChange).filter(Boolean)
    : null;

  return {
    id: createId(),
    kind: "text",
    notePath,
    before,
    after,
    changes: normalizedChanges && normalizedChanges.length > 0 ? normalizedChanges : undefined,
    status: "pending",
    time: currentTimeLabel(),
    createdAt: Date.now()
  };
}

function normalizeTextChange(change) {
  if (!change || typeof change !== "object") {
    return null;
  }

  if (typeof change.before !== "string" || typeof change.after !== "string") {
    return null;
  }

  return {
    before: change.before,
    after: change.after,
    contextBefore: typeof change.contextBefore === "string" ? change.contextBefore : "",
    contextAfter: typeof change.contextAfter === "string" ? change.contextAfter : ""
  };
}

function createPendingFrontmatterProposal(notePath, before, after) {
  return {
    id: createId(),
    kind: "frontmatter",
    notePath,
    before,
    after,
    status: "pending",
    time: currentTimeLabel(),
    createdAt: Date.now()
  };
}

function createPendingPatchProposal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Set patch arguments before preparing a note patch.");
  }

  const notePath = normalizePatchNotePath(input.path);
  if (input.kind === "text") {
    if (Object.hasOwn(input, "before") || Object.hasOwn(input, "after")) {
      throw new Error("Text note patches must use changes instead of top-level before and after objects.");
    }

    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      throw new Error("Set at least one text change before preparing a note patch.");
    }

    const changes = input.changes.map((change) => normalizePatchTextChange(change));
    return createPendingChangeProposal(
      notePath,
      changes.map((change) => change.before).join("\n\n"),
      changes.map((change) => change.after).join("\n\n"),
      changes
    );
  }

  if (input.kind === "frontmatter") {
    if (Object.hasOwn(input, "changes")) {
      throw new Error("Frontmatter note patches must use before and after objects instead of text changes.");
    }

    if (!isPlainObject(input.before) || !isPlainObject(input.after)) {
      throw new Error("Frontmatter note patches require before and after objects.");
    }

    return createPendingFrontmatterProposal(
      notePath,
      cloneJsonValue(input.before),
      cloneJsonValue(input.after)
    );
  }

  throw new Error("Note patch kind must be text or frontmatter.");
}

function normalizePatchNotePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Set an existing Markdown note path before preparing a note patch.");
  }

  const path = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !path.toLowerCase().endsWith(".md") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Note patch path must be a vault-relative Markdown path.");
  }

  return path;
}

function normalizePatchTextChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new Error("Each text patch change must be an object.");
  }

  if (typeof change.before !== "string" || change.before.length === 0) {
    throw new Error("Each text patch change requires exact current text in before.");
  }

  if (typeof change.after !== "string") {
    throw new Error("Each text patch change requires replacement text in after.");
  }

  for (const key of ["contextBefore", "contextAfter"]) {
    if (Object.hasOwn(change, key) && typeof change[key] !== "string") {
      throw new Error(`Text patch ${key} must be a string when provided.`);
    }
  }

  return {
    before: change.before,
    after: change.after,
    contextBefore: change.contextBefore ?? "",
    contextAfter: change.contextAfter ?? ""
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createPendingPatchProposal
};
