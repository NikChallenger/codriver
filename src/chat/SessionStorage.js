const SESSION_STORAGE_VERSION = 7;
const DEFAULT_MAX_SESSION_HISTORY = 5;
const MAX_SESSION_TITLE_CODE_POINTS = 57;
const UNTITLED_SESSION_TITLE = "Untitled session";
const GENERATED_ATTACHMENT_FALLBACK = "Review the attached file(s).";

class SessionStorage {
  constructor(app, pluginId, options = {}) {
    this.adapter = app.vault.adapter;
    this.directory = `.obsidian/plugins/${sanitizePathSegment(pluginId || "codriver")}/sessions`;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
  }

  async saveSession(snapshot, options = {}) {
    await this.ensureDirectory();

    const sessionPath = this.isSessionPath(options.path)
      ? options.path
      : `${this.directory}/${createSessionFileName(new Date())}`;
    const sessionTitle = resolveSessionTitle(
      snapshot?.sessionTitle,
      await this.readStoredSessionTitle(sessionPath),
      snapshot?.messages
    );
    const payload = {
      version: SESSION_STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      ...snapshot,
      sessionTitle
    };

    await this.adapter.write(sessionPath, JSON.stringify(payload, null, 2));
    await this.pruneSessions(options.maxSessions ?? DEFAULT_MAX_SESSION_HISTORY, sessionPath);

    return this.createSessionListItem(sessionPath, payload);
  }

  async listSessions() {
    if (!(await this.adapter.exists(this.directory))) {
      return [];
    }

    const listing = await this.adapter.list(this.directory);
    const sessions = [];
    for (const path of listing.files
      .filter((path) => path.endsWith(".json") && this.isSessionPath(path))
    ) {
      sessions.push(await this.readSessionListItem(path));
    }

    return sessions.sort((left, right) => (
      (right.endedAt ?? right.startedAt ?? 0) - (left.endedAt ?? left.startedAt ?? 0) ||
      right.path.localeCompare(left.path)
    ));
  }

  async pruneSessions(maxSessions = DEFAULT_MAX_SESSION_HISTORY, keepPath = "") {
    if (!Number.isFinite(maxSessions) || maxSessions <= 0 || typeof this.adapter.remove !== "function") {
      return;
    }

    const sessions = await this.listSessions();
    const protectedPath = normalizePath(keepPath);
    const removableSessions = sessions
      .filter((session) => normalizePath(session.path) !== protectedPath)
      .slice(Math.max(0, maxSessions - 1));

    for (const session of removableSessions) {
      await this.adapter.remove(session.path);
    }
  }

  async loadSession(sessionPath) {
    if (!this.isSessionPath(sessionPath)) {
      throw new Error("Session file is outside the CoDriver session directory.");
    }

    const content = await this.adapter.read(sessionPath);
    return JSON.parse(content);
  }

  async readSessionListItem(path) {
    try {
      const payload = JSON.parse(await this.adapter.read(path));
      return this.createSessionListItem(path, payload);
    } catch {
      return this.createSessionListItem(path, null);
    }
  }

  async readStoredSessionTitle(path) {
    if (!this.isSessionPath(path) || !(await this.adapter.exists(path))) {
      return null;
    }

    try {
      const payload = JSON.parse(await this.adapter.read(path));
      return getStoredSessionTitle(payload?.sessionTitle);
    } catch {
      return null;
    }
  }

  createSessionListItem(path, payload) {
    const range = getSessionTimeRange(path, payload);
    return {
      path,
      name: getFileName(path),
      displayName: formatSessionDisplayName(range.startedAt, resolveSessionTitle(payload?.sessionTitle, null, payload?.messages)),
      sessionTitle: resolveSessionTitle(payload?.sessionTitle, null, payload?.messages),
      startedAt: range.startedAt,
      endedAt: range.endedAt
    };
  }

  async ensureDirectory() {
    if (await this.adapter.exists(this.directory)) {
      return;
    }

    await this.adapter.mkdir(this.directory);
  }

  isSessionPath(sessionPath) {
    return typeof sessionPath === "string" &&
      normalizePath(sessionPath).startsWith(`${normalizePath(this.directory)}/`) &&
      sessionPath.endsWith(".json");
  }
}

function createSessionFileName(date) {
  const suffix = Math.random().toString(16).slice(2, 8);
  return `session-${date.toISOString().replace(/[:.]/g, "-")}-${suffix}.json`;
}

function getSessionTimeRange(path, payload) {
  const fileTimestamp = getSessionTimestampFromPath(path);
  const savedTimestamp = getTimestamp(payload?.savedAt);
  const createdAtValues = [
    ...getCollectionTimestamps(payload?.messages),
    ...getCollectionTimestamps(payload?.changeProposals),
    ...getCollectionTimestamps(payload?.attachments)
  ];

  const startCandidates = [...createdAtValues, fileTimestamp, savedTimestamp]
    .filter((value) => Number.isFinite(value));
  const endCandidates = [...createdAtValues, savedTimestamp, fileTimestamp]
    .filter((value) => Number.isFinite(value));

  const startedAt = startCandidates.length > 0 ? Math.min(...startCandidates) : null;
  const endedAt = endCandidates.length > 0 ? Math.max(...endCandidates) : startedAt;

  return {
    startedAt,
    endedAt: endedAt ?? startedAt
  };
}

function getCollectionTimestamps(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => getTimestamp(item?.createdAt))
    .filter((value) => Number.isFinite(value));
}

function getSessionTimestampFromPath(path) {
  const match = getFileName(path).match(/^session-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)-/);
  if (!match) {
    return null;
  }

  return getTimestamp(`${match[1]}:${match[2]}:${match[3]}.${match[4]}`);
}

function getTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function createSessionTitle(messages) {
  const firstRequest = (Array.isArray(messages) ? messages : []).find(isEligibleUserRequest);
  const text = typeof firstRequest?.titleText === "string"
    ? firstRequest.titleText.trim()
    : String(firstRequest?.content ?? "").trim();

  if (!text || text === GENERATED_ATTACHMENT_FALLBACK) {
    return UNTITLED_SESSION_TITLE;
  }

  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_SESSION_TITLE_CODE_POINTS) {
    return text;
  }

  return `${codePoints.slice(0, MAX_SESSION_TITLE_CODE_POINTS).join("").trimEnd()}...`;
}

function isEligibleUserRequest(message) {
  if (message?.role !== "user") {
    return false;
  }

  const text = typeof message.titleText === "string"
    ? message.titleText.trim()
    : String(message?.content ?? "").trim();
  if (!text || text === GENERATED_ATTACHMENT_FALLBACK) {
    return false;
  }

  if (typeof message.isSessionTitleEligible === "boolean") {
    return message.isSessionTitleEligible;
  }

  return !isSlashOnlySkillActivation(text);
}

function isSlashOnlySkillActivation(text) {
  return /^\/skill:[A-Za-z0-9_-]+\s*$/.test(text);
}

function getStoredSessionTitle(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveSessionTitle(snapshotTitle, storedTitle, messages) {
  const snapshotValue = getStoredSessionTitle(snapshotTitle);
  const storedValue = getStoredSessionTitle(storedTitle);
  const title = snapshotValue && snapshotValue !== UNTITLED_SESSION_TITLE
    ? snapshotValue
    : storedValue && storedValue !== UNTITLED_SESSION_TITLE
      ? storedValue
      : null;

  if (title) {
    return title;
  }

  const derivedTitle = createSessionTitle(messages);
  return derivedTitle !== UNTITLED_SESSION_TITLE
    ? derivedTitle
    : snapshotValue ?? storedValue ?? UNTITLED_SESSION_TITLE;
}

function formatSessionDisplayName(startedAt, sessionTitle = UNTITLED_SESSION_TITLE) {
  const startDate = Number.isFinite(startedAt) ? new Date(startedAt) : null;
  const time = startDate ? formatLocalSessionStart(startDate) : "Unknown session time";
  return `${time} - ${getStoredSessionTitle(sessionTitle) ?? UNTITLED_SESSION_TITLE}`;
}

function formatLocalSessionStart(date) {
  return `${padNumber(date.getDate())}.${padNumber(date.getMonth() + 1)}.${padNumber(date.getFullYear() % 100)} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function getFileName(path) {
  return path.split("/").pop() ?? path;
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function sanitizePathSegment(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-") || "codriver";
}

module.exports = {
  DEFAULT_MAX_SESSION_HISTORY,
  createSessionTitle,
  formatSessionDisplayName,
  MAX_SESSION_TITLE_CODE_POINTS,
  SESSION_STORAGE_VERSION,
  SessionStorage,
  UNTITLED_SESSION_TITLE
};
