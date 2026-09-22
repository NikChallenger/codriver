const CODE_FENCE_PATTERN = /```([A-Za-z0-9_-]+)?\s*\r?\n([\s\S]*?)```/g;
const MCP_TOOL_CALL_LANGUAGE = "codriver-tool-call";
const JSON_LANGUAGE = "json";

function parseModelResponseForMcpToolCalls(content) {
  const toolCalls = [];
  const displayParts = [];
  let lastIndex = 0;
  let match;

  while ((match = CODE_FENCE_PATTERN.exec(content)) !== null) {
    const language = normalizeFenceLanguage(match[1]);
    if (!shouldParseFence(language)) {
      continue;
    }

    displayParts.push(content.slice(lastIndex, match.index));

    const result = parseToolCallJson(match[2], language);
    if (result.toolCalls.length > 0) {
      toolCalls.push(...result.toolCalls);
    } else {
      displayParts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  displayParts.push(content.slice(lastIndex));

  return {
    displayContent: normalizeDisplayContent(displayParts.join("")),
    toolCalls
  };
}

function normalizeFenceLanguage(language) {
  return typeof language === "string" ? language.trim().toLowerCase() : "";
}

function shouldParseFence(language) {
  return language === MCP_TOOL_CALL_LANGUAGE || language === JSON_LANGUAGE;
}

function parseToolCallJson(jsonText, language) {
  try {
    const parsed = parseJsonFromText(jsonText);
    const rawCalls = unwrapToolCallObjects(parsed);
    const toolCalls = rawCalls
      .map((call) => normalizeToolCall(call, language))
      .filter(Boolean);

    return { toolCalls };
  } catch {
    return { toolCalls: [] };
  }
}

function unwrapToolCallObjects(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isPlainObject(value)) {
    return [];
  }

  for (const key of ["toolCalls", "tool_calls", "calls"]) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }

  return [value];
}

function normalizeToolCall(value, language) {
  if (!isPlainObject(value)) {
    return null;
  }

  if (language !== MCP_TOOL_CALL_LANGUAGE && !isExplicitToolCallObject(value)) {
    return null;
  }

  const serverId = readString(value.serverId ?? value.server ?? value.mcpServerId);
  const toolName = readString(value.toolName ?? value.tool ?? value.name);
  if (!toolName) {
    return null;
  }

  return {
    serverId,
    toolName,
    arguments: isPlainObject(value.arguments)
      ? cloneJsonObject(value.arguments)
      : (isPlainObject(value.args) ? cloneJsonObject(value.args) : {}),
    reason: readString(value.reason)
  };
}

function isExplicitToolCallObject(value) {
  const type = readString(value.type ?? value.kind ?? value.action).toLowerCase();
  return type === "mcp-tool-call" ||
    type === "mcp_tool_call" ||
    type === "tool-call" ||
    type === "tool_call";
}

function parseJsonFromText(value) {
  const trimmedValue = String(value || "").trim();
  try {
    return JSON.parse(trimmedValue);
  } catch (_error) {
    const jsonObject = extractFirstJsonObject(trimmedValue);
    if (!jsonObject) {
      throw _error;
    }

    return JSON.parse(jsonObject.text);
  }
}

function extractFirstJsonObject(value) {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          start,
          end: index + 1,
          text: value.slice(start, index + 1)
        };
      }
    }
  }

  return null;
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDisplayContent(content) {
  return content
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  parseModelResponseForMcpToolCalls
};
