const { requestUrl } = require("obsidian");
const { CODRIVER_PLUGIN_VERSION, MCP_PROTOCOL_VERSION } = require("../constants");
const {
  createJsonRpcErrorDiagnostic,
  hashText,
  isPlainObject,
  normalizeDiscoveredTool,
  normalizeErrorMessage
} = require("./McpToolUtils");

class McpHttpClient {
  constructor(server, options = {}) {
    this.endpoint = String(server?.endpoint ?? "").trim();
    this.headers = parseHeaderLines(server?.headers);
    this.protocolVersion = MCP_PROTOCOL_VERSION;
    this.sessionId = "";
    this.nextId = 1;
    this.serverSummary = createServerSummary(server);
    this.diagnostics = options.diagnostics ?? null;
  }

  async discoverTools() {
    if (!this.endpoint) {
      throw new Error("Set an MCP HTTP endpoint before discovering tools.");
    }

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
  }

  async callTool(name, args = {}) {
    if (!this.endpoint) {
      throw new Error("Set an MCP HTTP endpoint before calling tools.");
    }

    const toolName = typeof name === "string" ? name.trim() : "";
    if (!toolName) {
      throw new Error("Set an MCP tool name before calling tools.");
    }

    await this.initialize();
    await this.sendNotification("notifications/initialized");

    const response = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: isPlainObject(args) ? args : {}
    });

    return response?.result ?? {};
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
    }, {
      includeSession: false
    });

    const negotiatedVersion = response?.result?.protocolVersion;
    if (typeof negotiatedVersion === "string" && negotiatedVersion.trim()) {
      this.protocolVersion = negotiatedVersion.trim();
    }

    return response;
  }

  async sendRequest(method, params = {}, options = {}) {
    const id = this.nextId;
    this.nextId += 1;

    const response = await this.postJsonRpc({
      jsonrpc: "2.0",
      id,
      method,
      params
    }, options);

    let payload;
    try {
      payload = parseJsonRpcResponse(response, id);
    } catch {
      await this.logDiagnostic("mcp.http.response.parse.failed", {
        ...this.serverSummary,
        jsonRpcMethod: method,
        requestId: id,
        error: "MCP server did not return a valid JSON-RPC response.",
        parseState: "invalid-json-rpc",
        response: createResponseSummary(response, id)
      });
      throw new Error(`MCP server did not return a valid JSON-RPC response for ${method}.`);
    }

    if (payload.error) {
      throw new Error(payload.error.message || `MCP request failed: ${method}.`);
    }

    return payload;
  }

  async sendNotification(method, params = {}) {
    await this.postJsonRpc({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  async postJsonRpc(payload, options = {}) {
    await this.logDiagnostic("mcp.http.request.started", {
      ...this.serverSummary,
      jsonRpcMethod: payload.method,
      requestId: payload.id ?? null,
      hasSession: Boolean(this.sessionId),
      includeSession: options.includeSession !== false,
      headerNames: Object.keys(this.createHeaders(options)).sort()
    });

    let response;
    try {
      response = await requestUrl({
        url: this.endpoint,
        method: "POST",
        headers: this.createHeaders(options),
        body: JSON.stringify(payload)
      });
    } catch (error) {
      await this.logDiagnostic("mcp.http.request.failed", {
        ...this.serverSummary,
        jsonRpcMethod: payload.method,
        requestId: payload.id ?? null,
        error: normalizeErrorMessage(error)
      });
      throw error;
    }

    await this.logDiagnostic("mcp.http.response.received", {
      ...this.serverSummary,
      jsonRpcMethod: payload.method,
      requestId: payload.id ?? null,
      response: createResponseSummary(response, payload.id ?? null)
    });

    const sessionId = getHeader(response.headers, "Mcp-Session-Id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MCP HTTP request failed with status ${response.status}.`);
    }

    return response;
  }

  async logDiagnostic(event, detail) {
    if (!this.diagnostics || typeof this.diagnostics.debug !== "function") {
      return;
    }

    await this.diagnostics.debug(event, detail);
  }

  createHeaders(options = {}) {
    const headers = {
      ...this.headers,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    };

    if (options.includeSession !== false) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }
    }

    return headers;
  }
}

function parseHeaderLines(value) {
  const headers = {};
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (key && headerValue) {
      headers[key] = headerValue;
    }
  }

  return headers;
}

function createServerSummary(server) {
  return {
    serverId: typeof server?.id === "string" ? server.id : "",
    serverName: typeof server?.name === "string" ? server.name : "",
    transport: typeof server?.transport === "string" ? server.transport : "",
    endpoint: summarizeEndpoint(server?.endpoint),
    customHeaderNames: Object.keys(parseHeaderLines(server?.headers)).sort()
  };
}

function summarizeEndpoint(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (!value) {
    return {
      present: false,
      hash: "",
      protocol: "",
      host: "",
      path: "",
      hasQuery: false
    };
  }

  try {
    const parsed = new URL(value);
    return {
      present: true,
      hash: hashText(value),
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      path: parsed.pathname,
      hasQuery: Boolean(parsed.search)
    };
  } catch {
    return {
      present: true,
      hash: hashText(value),
      protocol: "",
      host: "",
      path: "",
      hasQuery: value.includes("?")
    };
  }
}

function createResponseSummary(response, expectedId = null) {
  const text = String(response?.text ?? "");
  const contentType = getHeader(response?.headers, "content-type");
  const jsonRead = readResponseJson(response);
  const candidates = collectResponseCandidates(jsonRead, text);
  const envelope = findJsonRpcEnvelope(candidates, expectedId);
  return {
    status: Number.isInteger(response?.status) ? response.status : null,
    contentType,
    headerNames: Object.keys(response?.headers ?? {}).sort(),
    hasJson: jsonRead.hasJson,
    jsonReadState: jsonRead.state,
    textLength: text.length,
    responseFormat: classifyResponseFormat(contentType, text, jsonRead.hasJson),
    jsonRpcCandidateCount: candidates.filter(isJsonRpcEnvelope).length,
    jsonRpcRequestIdMatched: hasMatchingJsonRpcId(candidates, expectedId),
    jsonRpcState: getJsonRpcState(envelope),
    ...createJsonRpcErrorDiagnostic(envelope?.error)
  };
}

function parseJsonRpcResponse(response, expectedId) {
  const jsonRead = readResponseJson(response);
  const text = String(response?.text ?? "").trim();
  const payload = findJsonRpcEnvelope(collectResponseCandidates(jsonRead, text), expectedId);

  if (!payload) {
    throw new Error("MCP server did not return a JSON-RPC response.");
  }

  return payload;
}

function readResponseJson(response) {
  try {
    const value = response?.json;
    if (value && typeof value === "object") {
      return {
        hasJson: true,
        value,
        state: "available"
      };
    }
  } catch {
    return {
      hasJson: false,
      value: null,
      state: "unreadable"
    };
  }

  return {
    hasJson: false,
    value: null,
    state: "absent"
  };
}

function collectResponseCandidates(jsonRead, text) {
  const candidates = [];
  if (jsonRead.hasJson) {
    candidates.push(jsonRead.value);
  }

  const normalizedText = String(text ?? "").trim();
  if (normalizedText) {
    candidates.push(...parseTextPayloadCandidates(normalizedText));
  }

  return candidates;
}

function findJsonRpcEnvelope(candidates, expectedId) {
  const envelopes = candidates.filter(isJsonRpcEnvelope);
  if (expectedId !== null && expectedId !== undefined) {
    const matching = envelopes.find((candidate) => (
      candidate.id === expectedId || String(candidate.id) === String(expectedId)
    ));
    if (matching) {
      return matching;
    }
  }

  return envelopes[0] ?? null;
}

function hasMatchingJsonRpcId(candidates, expectedId) {
  if (expectedId === null || expectedId === undefined) {
    return null;
  }

  return candidates.filter(isJsonRpcEnvelope).some((candidate) => (
    candidate.id === expectedId || String(candidate.id) === String(expectedId)
  ));
}

function isJsonRpcEnvelope(candidate) {
  return candidate?.jsonrpc === "2.0";
}

function getJsonRpcState(envelope) {
  if (!envelope) {
    return "none";
  }
  if (envelope.error) {
    return "error";
  }
  if (Object.prototype.hasOwnProperty.call(envelope, "result")) {
    return "result";
  }
  return "envelope";
}

function classifyResponseFormat(contentType, text, hasJson) {
  if (hasJson) {
    return "json";
  }

  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) {
    return "empty";
  }
  if (String(contentType ?? "").toLowerCase().includes("text/event-stream") || /^data:/m.test(normalizedText)) {
    return "sse";
  }
  if (normalizedText.startsWith("{") || normalizedText.startsWith("[")) {
    return "json-text";
  }
  return "other";
}

function parseTextPayloadCandidates(text) {
  if (text.startsWith("{")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }

  return text
    .split(/\r?\n\r?\n/)
    .flatMap((eventText) => parseSseEventData(eventText))
    .map((eventData) => {
      try {
        return JSON.parse(eventData);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseSseEventData(eventText) {
  const dataLines = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  return dataLines.length > 0 ? [dataLines.join("\n")] : [];
}

function getHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }

  return "";
}

module.exports = {
  McpHttpClient,
  parseHeaderLines
};
