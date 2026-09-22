function normalizeDiscoveredTool(tool) {
  const name = typeof tool?.name === "string" && tool.name.trim()
    ? tool.name.trim()
    : "";
  if (!name) {
    return null;
  }

  return {
    name,
    title: typeof tool?.title === "string" ? tool.title : "",
    description: typeof tool?.description === "string" ? tool.description : "",
    inputSchema: isPlainObject(tool?.inputSchema) ? tool.inputSchema : null,
    outputSchema: isPlainObject(tool?.outputSchema) ? tool.outputSchema : null,
    annotations: isPlainObject(tool?.annotations) ? tool.annotations : null,
    enabled: tool?.enabled !== false,
    allowAutomaticExecution: false
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/Authorization\s*:\s*(?:Bearer\s+)?[^\r\n,;]+/gi, "Authorization: [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function normalizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error.");
  return redactSensitiveText(message);
}

function createSafeErrorText(error, maxLength = 240) {
  return normalizeErrorMessage(error).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function createJsonRpcErrorDiagnostic(error) {
  const hasError = Boolean(error);
  const errorObject = isPlainObject(error) ? error : null;
  return {
    hasError,
    errorCode: Number.isFinite(errorObject?.code) ? errorObject.code : null,
    errorMessage: hasError ? createSafeErrorText(errorObject?.message ?? error) : "",
    hasErrorData: Boolean(errorObject && Object.prototype.hasOwnProperty.call(errorObject, "data"))
  };
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

module.exports = {
  createJsonRpcErrorDiagnostic,
  createSafeErrorText,
  hashText,
  isPlainObject,
  normalizeDiscoveredTool,
  normalizeErrorMessage,
  redactSensitiveText
};
