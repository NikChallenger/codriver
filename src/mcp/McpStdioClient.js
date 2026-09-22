const { CODRIVER_PLUGIN_VERSION, MCP_PROTOCOL_VERSION } = require("../constants");
const {
  createJsonRpcErrorDiagnostic,
  createSafeErrorText,
  hashText,
  isPlainObject,
  normalizeDiscoveredTool,
  normalizeErrorMessage
} = require("./McpToolUtils");
const {
  assertStdioMcpRuntimeSupported,
  loadStdioMcpSpawn
} = require("./McpRuntimeSupport");

const DEFAULT_STDIO_REQUEST_TIMEOUT_MS = 30000;
const MAX_STDERR_BUFFER_CHARS = 4096;
const MAX_STDERR_DIAGNOSTIC_CHARS = 240;

class McpStdioClient {
  constructor(server, options = {}) {
    this.command = String(server?.command ?? "").trim();
    this.args = parseCommandArguments(server?.args);
    this.env = parseEnvironmentLines(server?.env);
    this.protocolVersion = MCP_PROTOCOL_VERSION;
    this.nextId = 1;
    this.child = null;
    this.stdoutBuffer = "";
    this.pendingRequests = new Map();
    this.closed = false;
    this.stderrCharacterCount = 0;
    this.stderrChunkCount = 0;
    this.stderrTail = "";
    this.serverSummary = createServerSummary(server);
    this.diagnostics = options.diagnostics ?? null;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(1, Math.trunc(options.requestTimeoutMs))
      : DEFAULT_STDIO_REQUEST_TIMEOUT_MS;
  }

  async discoverTools() {
    assertStdioMcpRuntimeSupported();

    if (!this.command) {
      throw new Error("Set an MCP stdio command before discovering tools.");
    }

    try {
      await this.initialize();
      await this.sendNotification("notifications/initialized");

      const tools = [];
      let cursor = "";
      do {
        const response = await this.sendRequest("tools/list", cursor ? { cursor } : {});
        const result = response?.result ?? {};
        if (!Array.isArray(result.tools)) {
          throw new Error("MCP server responded without a tools list.");
        }

        tools.push(...result.tools.map(normalizeDiscoveredTool).filter(Boolean));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
      } while (cursor);

      return tools;
    } finally {
      this.close();
    }
  }

  async callTool(name, args = {}) {
    assertStdioMcpRuntimeSupported();

    if (!this.command) {
      throw new Error("Set an MCP stdio command before calling tools.");
    }

    const toolName = typeof name === "string" ? name.trim() : "";
    if (!toolName) {
      throw new Error("Set an MCP tool name before calling tools.");
    }

    try {
      await this.initialize();
      await this.sendNotification("notifications/initialized");

      const response = await this.sendRequest("tools/call", {
        name: toolName,
        arguments: isPlainObject(args) ? args : {}
      });

      return response?.result ?? {};
    } finally {
      this.close();
    }
  }

  async initialize() {
    const response = await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "CoDriver",
        title: "CoDriver",
        version: CODRIVER_PLUGIN_VERSION
      }
    });

    const negotiatedVersion = response?.result?.protocolVersion;
    if (typeof negotiatedVersion === "string" && negotiatedVersion.trim()) {
      this.protocolVersion = negotiatedVersion.trim();
    }

    return response;
  }

  async sendRequest(method, params = {}) {
    this.start();

    const id = this.nextId;
    this.nextId += 1;

    await this.logDiagnostic("mcp.stdio.request.started", {
      ...this.serverSummary,
      jsonRpcMethod: method,
      requestId: id
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        const error = new Error(`MCP stdio request timed out for ${method}.`);
        void this.logDiagnostic("mcp.stdio.request.failed", {
          ...this.serverSummary,
          jsonRpcMethod: method,
          requestId: id,
          error: normalizeErrorMessage(error),
          ...this.drainStderrDiagnostic()
        });
        this.close();
        reject(error);
      }, this.requestTimeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        resolve: (payload) => {
          clearTimeout(timer);
          if (payload?.error) {
            reject(new Error(payload.error.message || `MCP request failed: ${method}.`));
            return;
          }

          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      try {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(String(id));
        reject(error);
      }
    });
  }

  async sendNotification(method, params = {}) {
    this.start();
    await this.logDiagnostic("mcp.stdio.notification.sent", {
      ...this.serverSummary,
      jsonRpcMethod: method
    });
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  start() {
    if (this.child) {
      return;
    }

    const spawn = loadStdioMcpSpawn();

    const env = {
      ...(typeof process !== "undefined" && process.env ? process.env : {}),
      ...this.env
    };

    this.child = spawn(this.command, this.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.stdout?.setEncoding?.("utf8");
    this.child.stderr?.setEncoding?.("utf8");
    this.child.stdout?.on?.("data", (chunk) => this.handleStdoutData(chunk));
    this.child.stderr?.on?.("data", (chunk) => this.handleStderrData(chunk));
    this.child.once?.("error", (error) => this.handleProcessFailure(error));
    this.child.once?.("exit", (code, signal) => this.handleProcessExit(code, signal));

    void this.logDiagnostic("mcp.stdio.process.started", this.serverSummary);
  }

  writeMessage(payload) {
    const child = this.child;
    if (!child?.stdin || this.closed) {
      throw new Error("MCP stdio server process is not running.");
    }

    child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  handleStdoutData(chunk) {
    this.stdoutBuffer += String(chunk ?? "");

    while (true) {
      const lineEnd = this.stdoutBuffer.search(/\r?\n/);
      if (lineEnd < 0) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, lineEnd).trim();
      const newlineLength = this.stdoutBuffer[lineEnd] === "\r" && this.stdoutBuffer[lineEnd + 1] === "\n" ? 2 : 1;
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + newlineLength);

      if (!line) {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        void this.logDiagnostic("mcp.stdio.response.parse.failed", {
          ...this.serverSummary,
          error: "MCP stdio server wrote invalid JSON-RPC to stdout.",
          parseState: "invalid-json",
          lineLength: line.length
        });
        this.rejectAllPending(new Error("MCP stdio server wrote invalid JSON-RPC to stdout."));
        this.close();
        return;
      }

      const messages = Array.isArray(payload) ? payload : [payload];
      for (const message of messages) {
        this.handleJsonRpcMessage(message);
      }
    }
  }

  handleJsonRpcMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    const key = message.id === undefined || message.id === null ? "" : String(message.id);
    if (!key) {
      void this.logDiagnostic("mcp.stdio.notification.received", {
        ...this.serverSummary,
        jsonRpcMethod: typeof message.method === "string" ? message.method : ""
      });
      return;
    }

    const pending = this.pendingRequests.get(key);
    if (!pending) {
      void this.logDiagnostic("mcp.stdio.response.unmatched", {
        ...this.serverSummary,
        requestId: key
      });
      return;
    }

    this.pendingRequests.delete(key);
    void this.logDiagnostic("mcp.stdio.response.received", {
      ...this.serverSummary,
      jsonRpcMethod: pending.method,
      requestId: key,
      ...createJsonRpcErrorDiagnostic(message.error)
    });
    pending.resolve(message);
  }

  handleStderrData(chunk) {
    const text = String(chunk ?? "");
    if (!text.trim()) {
      return;
    }

    this.stderrChunkCount += 1;
    this.stderrCharacterCount += text.length;
    const boundedChunk = text.slice(-MAX_STDERR_BUFFER_CHARS);
    this.stderrTail = `${this.stderrTail}${boundedChunk}`.slice(-MAX_STDERR_BUFFER_CHARS);
  }

  handleProcessFailure(error) {
    const detail = normalizeErrorMessage(error);
    void this.logDiagnostic("mcp.stdio.process.failed", {
      ...this.serverSummary,
      error: detail,
      ...this.drainStderrDiagnostic()
    });
    this.rejectAllPending(new Error(`MCP stdio process failed. ${detail}`));
  }

  handleProcessExit(code, signal) {
    const stderrDiagnostic = Number.isInteger(code) && code !== 0
      ? this.drainStderrDiagnostic()
      : this.clearStderrBuffer();
    void this.logDiagnostic("mcp.stdio.process.exited", {
      ...this.serverSummary,
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === "string" ? signal : "",
      ...stderrDiagnostic
    });

    if (!this.closed && this.pendingRequests.size > 0) {
      this.rejectAllPending(new Error(`MCP stdio process exited before responding. Exit code: ${code ?? "unknown"}.`));
    }
  }

  rejectAllPending(error) {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  drainStderrDiagnostic() {
    const redactedTail = createSafeErrorText(this.stderrTail, MAX_STDERR_BUFFER_CHARS);
    const diagnostic = {
      stderrCharacterCount: this.stderrCharacterCount,
      stderrChunkCount: this.stderrChunkCount,
      stderrText: redactedTail.slice(-MAX_STDERR_DIAGNOSTIC_CHARS)
    };
    this.clearStderrBuffer();
    return diagnostic;
  }

  clearStderrBuffer() {
    this.stderrCharacterCount = 0;
    this.stderrChunkCount = 0;
    this.stderrTail = "";
    return {};
  }

  close() {
    this.closed = true;
    if (!this.child) {
      return;
    }

    try {
      this.child.stdin?.end?.();
    } catch {
      // Best-effort cleanup.
    }

    try {
      this.child.kill?.();
    } catch {
      // Best-effort cleanup.
    }

    this.clearStderrBuffer();
  }

  async logDiagnostic(event, detail) {
    if (!this.diagnostics || typeof this.diagnostics.debug !== "function") {
      return;
    }

    await this.diagnostics.debug(event, detail);
  }
}

function parseCommandArguments(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }

  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = text[index + 1] ?? "";
      if (nextChar && (/\s/.test(nextChar) || nextChar === "\"" || nextChar === "'" || nextChar === "\\")) {
        escaping = true;
      } else {
        current += char;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function parseEnvironmentLines(value) {
  const env = {};
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || /\s/.test(key)) {
      continue;
    }

    env[key] = line.slice(separatorIndex + 1).trim();
  }

  return env;
}

function createServerSummary(server) {
  return {
    serverId: typeof server?.id === "string" ? server.id : "",
    serverName: typeof server?.name === "string" ? server.name : "",
    transport: typeof server?.transport === "string" ? server.transport : "",
    commandPresent: Boolean(String(server?.command ?? "").trim()),
    commandHash: hashText(server?.command),
    argumentCount: parseCommandArguments(server?.args).length,
    envNames: Object.keys(parseEnvironmentLines(server?.env)).sort()
  };
}

module.exports = {
  McpStdioClient,
  parseCommandArguments,
  parseEnvironmentLines
};
