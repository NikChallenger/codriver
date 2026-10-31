const { ARGUMENT_BYTES, CONTENT_BYTES, RECORD_BYTES, byteLength, serializeContent } = require("./DetailedLogContent");
const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_MAX_ARCHIVED_LOGS = 0;
const DIAGNOSTIC_LOG_VERSION = 1;
const CURRENT_DIAGNOSTIC_LOG_FILENAME = "diagnostics.log";

class DiagnosticLogger {
  constructor(app, pluginId, isEnabled, options = {}) {
    this.adapter = app.vault.adapter;
    const configDir = normalizeConfigDir(app.vault.configDir);
    this.directory = `${configDir}/plugins/${sanitizePathSegment(pluginId || "codriver")}/logs`;
    this.currentLogPath = `${this.directory}/${CURRENT_DIAGNOSTIC_LOG_FILENAME}`;
    this.isEnabledResolver = typeof isEnabled === "function" ? isEnabled : () => Boolean(isEnabled);
    this.logLevelResolver = typeof options.getLogLevel === "function" ? options.getLogLevel : () => options.logLevel ?? "errors";
    this.logTargetResolver = typeof options.getLogTarget === "function" ? options.getLogTarget : () => options.logTarget ?? "console";
    this.isMobileAppResolver = typeof options.isMobileApp === "function" ? options.isMobileApp : () => false;
    this.console = options.console ?? console;
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxArchivedLogs = options.maxArchivedLogs ?? DEFAULT_MAX_ARCHIVED_LOGS;
    this.sessionId = "";
    this.initializedForLaunch = false;
    this.writeQueue = Promise.resolve();
    this.contentGeneration = 0;
    this.contentConsent = false;
    this.contentConfiguration = "";
    this.pendingContentBytes = 0;
    this.pendingContentRecords = 0;
    this.droppedContentRecords = 0;
  }

  isEnabled() {
    return Boolean(this.isEnabledResolver());
  }

  getCurrentLogPath() {
    return this.currentLogPath;
  }

  getLogLevel() {
    return normalizeLogLevel(this.logLevelResolver());
  }

  getLogTarget() {
    if (this.isMobileAppResolver()) {
      return "file";
    }

    return normalizeLogTarget(this.logTargetResolver());
  }

  setSessionId(sessionId) {
    this.sessionId = normalizeSessionId(sessionId);
  }

  getSessionId() {
    return this.sessionId;
  }

  createSessionScope() {
    const logger = this;
    let sessionId = "";
    return {
      debug(event, detail) {
        return logger.debugForSession(sessionId, event, detail);
      },
      content(event, value, options = {}) {
        return logger.content(event, value, { ...options, sessionId: options.sessionId ?? sessionId });
      },
      captureContentPermit() { return logger.captureContentPermit(); },
      getLogLevel() {
        return logger.getLogLevel();
      },
      getSessionId() {
        return sessionId;
      },
      isEnabled() {
        return logger.isEnabled();
      },
      setSessionId(value) {
        sessionId = normalizeSessionId(value);
      }
    };
  }

  async refresh() {
    this.syncContentConfiguration();
    await this.pruneArchivedLogs();
    if (!this.isEnabled() || this.getLogTarget() !== "file") {
      return;
    }

    await this.initializeForLaunch();
  }

  async initializeForLaunch() {
    if (!this.isEnabled() || this.getLogTarget() !== "file") {
      return;
    }

    const currentLogExists = await this.adapter.exists(this.currentLogPath);
    if (this.initializedForLaunch && currentLogExists) {
      return;
    }

    await this.ensureDirectory();
    await this.adapter.write(this.currentLogPath, `${this.createLine("diagnostics.started", {
      version: DIAGNOSTIC_LOG_VERSION,
      logPath: this.currentLogPath,
      rotation: {
        maxLogBytes: this.maxLogBytes,
        maxArchivedLogs: this.maxArchivedLogs
      }
    })}\n`);
    await this.pruneArchivedLogs();
    this.initializedForLaunch = true;
  }

  debug(event, detail) {
    return this.debugForSession(this.sessionId, event, detail);
  }

  debugForSession(sessionId, event, detail) {
    if (!this.isEnabled() || !this.shouldLogEvent(event, detail)) {
      return Promise.resolve();
    }

    const normalizedSessionId = normalizeSessionId(sessionId);
    const writeTask = this.writeQueue
      .then(() => this.writeLine(event, detail, normalizedSessionId))
      .catch(() => {
        console.warn("[CoDriver diagnostics] Unable to write diagnostic log.");
      });
    this.writeQueue = writeTask;
    return writeTask;
  }

  syncContentConfiguration() {
    const configuration = `${this.isEnabled()}:${this.getLogLevel()}:${this.getLogTarget()}`;
    if (configuration !== this.contentConfiguration) {
      this.contentConfiguration = configuration;
      this.revokeContentConsent();
    }
  }

  revokeContentConsent() {
    this.contentConsent = false;
    this.contentGeneration += 1;
  }

  activateContent() {
    this.syncContentConfiguration();
    this.contentConsent = !this.disposed && this.isEnabled() && this.getLogTarget() === "file" && this.getLogLevel() === "detailed";
    return this.contentConsent;
  }

  captureContentPermit() {
    this.syncContentConfiguration();
    return this.contentConsent ? this.contentGeneration : null;
  }

  dispose() {
    this.disposed = true;
    this.revokeContentConsent();
  }

  isContentPermitCurrent(permit) {
    return permit !== null && permit === this.captureContentPermit();
  }

  content(event, value, options = {}) {
    // A permit captured at request/dispatch time prevents backfill after activation.
    if (!this.isContentPermitCurrent(options.permit) ||
        !["assistant.final", "tool.arguments", "tool.result", "tool.applied"].includes(event)) return Promise.resolve();
    if (this.pendingContentRecords >= 32 || this.pendingContentBytes >= 1024 * 1024) {
      this.droppedContentRecords += 1;
      return Promise.resolve();
    }
    let line;
    try {
      const maximum = event === "tool.arguments" ? ARGUMENT_BYTES : CONTENT_BYTES;
      let detail = serializeContent(value, maximum, options.redactor);
      const identity = {
        toolName: typeof options.toolName === "string" ? options.toolName.slice(0, 160) : undefined,
        callId: normalizeSessionId(options.callId),
        droppedRecords: this.droppedContentRecords || undefined
      };
      line = `${this.createLine(`content.${event}`, { ...identity, ...detail }, options.sessionId ?? this.sessionId)}\n`;
      if (byteLength(line) > RECORD_BYTES) {
        detail = serializeContent(detail.content, 12 * 1024, options.redactor);
        detail.truncated = true;
        detail.marker = "[TRUNCATED: detailed log record limit]";
        line = `${this.createLine(`content.${event}`, { ...identity, ...detail }, options.sessionId ?? this.sessionId)}\n`;
      }
    } catch {
      this.droppedContentRecords += 1;
      return Promise.resolve();
    }
    const size = byteLength(line);
    if (size > RECORD_BYTES || this.pendingContentBytes + size > 1024 * 1024) {
      this.droppedContentRecords += 1;
      return Promise.resolve();
    }
    this.droppedContentRecords = 0;
    this.pendingContentBytes += size;
    this.pendingContentRecords += 1;
    // Only a bounded, already redacted string is retained in the queue.
    const permit = options.permit;
    const task = this.writeQueue.then(async () => {
      if (!this.isContentPermitCurrent(permit)) return;
      await this.initializeForLaunch();
      if (!this.isContentPermitCurrent(permit)) return;
      let current = await this.adapter.read(this.currentLogPath);
      if (!this.isContentPermitCurrent(permit)) return;
      if (byteLength(current) + size > this.maxLogBytes) {
        await this.rotateCurrentLog(current);
        current = await this.adapter.read(this.currentLogPath);
      }
      if (!this.isContentPermitCurrent(permit)) return;
      await this.adapter.write(this.currentLogPath, `${current}${line}`);
    }).catch(() => {
      console.warn("[CoDriver diagnostics] Unable to write diagnostic log.");
    }).finally(() => {
      this.pendingContentBytes -= size;
      this.pendingContentRecords -= 1;
      if (this.pendingContentRecords === 0 && this.droppedContentRecords > 0) {
        const count = this.droppedContentRecords;
        this.droppedContentRecords = 0;
        void this.debug("diagnostics.content.dropped", { count });
      }
    });
    this.writeQueue = task;
    return task;
  }

  async flush() {
    let pending;
    do {
      pending = this.writeQueue;
      await pending;
    } while (pending !== this.writeQueue);
  }

  async readCurrentLog() {
    await this.flush();

    if (!this.isEnabled()) {
      return createLogReadResult("disabled", this.currentLogPath);
    }
    if (this.getLogTarget() !== "file") {
      return createLogReadResult("not-file", this.currentLogPath);
    }
    if (!await this.adapter.exists(this.currentLogPath)) {
      return createLogReadResult("missing", this.currentLogPath);
    }

    const content = await this.adapter.read(this.currentLogPath);
    if (!content) {
      return createLogReadResult("empty", this.currentLogPath);
    }

    return {
      ok: true,
      path: this.currentLogPath,
      content
    };
  }

  async writeLine(event, detail, sessionId = "") {
    const line = `${this.createLine(event, detail, sessionId)}\n`;
    if (this.getLogTarget() === "console") {
      this.writeConsoleLine(event, detail, line);
      return;
    }

    await this.initializeForLaunch();
    let currentContent = "";

    if (await this.adapter.exists(this.currentLogPath)) {
      currentContent = await this.adapter.read(this.currentLogPath);
    }

    if (this.shouldRotate(currentContent, line)) {
      await this.rotateCurrentLog(currentContent, sessionId);
      currentContent = await this.adapter.read(this.currentLogPath);
    }

    await this.adapter.write(this.currentLogPath, `${currentContent}${line}`);
  }

  shouldLogEvent(event, detail) {
    if (this.getLogLevel() !== "errors") {
      return true;
    }

    return isErrorDiagnosticEvent(event, detail);
  }

  writeConsoleLine(event, detail, line) {
    const method = isErrorDiagnosticEvent(event, detail) ? "error" : "info";
    const writer = typeof this.console?.[method] === "function"
      ? this.console[method]
      : this.console?.log;
    if (typeof writer === "function") {
      writer.call(this.console, "[CoDriver diagnostics]", line.trim());
    }
  }

  shouldRotate(currentContent, nextLine) {
    if (!Number.isFinite(this.maxLogBytes) || this.maxLogBytes <= 0) {
      return false;
    }

    return currentContent.length > 0 && byteLength(currentContent) + byteLength(nextLine) > this.maxLogBytes;
  }

  async rotateCurrentLog(currentContent, sessionId = "") {
    if (this.maxArchivedLogs > 0 && currentContent.trim().length > 0) {
      const archivePath = `${this.directory}/diagnostics-${createTimestamp(new Date())}-${Math.random().toString(16).slice(2, 8)}.log`;
      await this.adapter.write(archivePath, currentContent);
    }

    await this.adapter.write(this.currentLogPath, `${this.createLine("diagnostics.rotated", {
      version: DIAGNOSTIC_LOG_VERSION,
      logPath: this.currentLogPath
    }, sessionId)}\n`);
    await this.pruneArchivedLogs();
  }

  async pruneArchivedLogs() {
    if (!Number.isFinite(this.maxArchivedLogs) || this.maxArchivedLogs < 0 || typeof this.adapter.remove !== "function") {
      return;
    }

    if (!await this.adapter.exists(this.directory)) {
      return;
    }

    const listing = await this.adapter.list(this.directory);
    const archivedLogs = listing.files
      .filter((path) => isArchivedDiagnosticLog(path, this.directory))
      .sort()
      .reverse();

    for (const path of archivedLogs.slice(this.maxArchivedLogs)) {
      await this.adapter.remove(path);
    }
  }

  async ensureDirectory() {
    if (await this.adapter.exists(this.directory)) {
      return;
    }

    await this.adapter.mkdir(this.directory);
  }

  createLine(event, detail, sessionId = this.sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
      detail: sanitizeDetail(detail)
    });
  }
}

function sanitizeDetail(detail) {
  if (detail === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return {
      serializationError: "Diagnostic detail could not be serialized."
    };
  }
}

function normalizeLogLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  return level === "detailed" ? "detailed" : level === "errors" ? "errors" : "all";
}

function normalizeLogTarget(value) {
  return String(value || "").trim().toLowerCase() === "console" ? "console" : "file";
}

function normalizeSessionId(value) {
  const sessionId = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._-]{1,160}$/.test(sessionId) ? sessionId : "";
}

function isErrorDiagnosticEvent(event, detail) {
  const eventName = String(event || "").toLowerCase();
  if (eventName.includes("error") || eventName.includes("failed") || eventName.includes("rejected")) {
    return true;
  }

  return detail?.status === "error" ||
    detail?.status === "failed" ||
    detail?.resultIsError === true ||
    Boolean(detail?.error);
}

function isArchivedDiagnosticLog(path, directory) {
  const normalizedPath = normalizePath(path);
  const normalizedDirectory = normalizePath(directory);
  return normalizedPath.startsWith(`${normalizedDirectory}/diagnostics-`) &&
    normalizedPath.endsWith(".log") &&
    !normalizedPath.endsWith(`/${CURRENT_DIAGNOSTIC_LOG_FILENAME}`);
}

function createTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizePath(path) {
  return String(path || "").replaceAll("\\", "/");
}

function normalizeConfigDir(value) {
  const normalized = normalizePath(value || ".obsidian").replace(/^\/+|\/+$/g, "");
  return normalized || ".obsidian";
}

function createLogReadResult(reason, path) {
  return {
    ok: false,
    reason,
    path,
    content: ""
  };
}

function sanitizePathSegment(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-") || "codriver";
}

module.exports = {
  DEFAULT_MAX_ARCHIVED_LOGS,
  DEFAULT_MAX_LOG_BYTES,
  DIAGNOSTIC_LOG_VERSION,
  DiagnosticLogger
};
