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
      .catch((error) => {
        console.warn("[CoDriver diagnostics] Unable to write diagnostic log.", error);
      });
    this.writeQueue = writeTask;
    return writeTask;
  }

  async flush() {
    await this.writeQueue;
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

    return currentContent.length > 0 && currentContent.length + nextLine.length > this.maxLogBytes;
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
  return String(value || "").trim().toLowerCase() === "errors" ? "errors" : "all";
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
