const STDIO_MCP_UNAVAILABLE_MESSAGE = "Stdio MCP requires Obsidian desktop with Node child_process support. HTTP MCP servers remain available.";

function getStdioMcpRuntimeSupport(options = {}) {
  const spawn = getStdioMcpSpawn(options);
  if (typeof spawn !== "function") {
    return {
      supported: false,
      message: STDIO_MCP_UNAVAILABLE_MESSAGE
    };
  }

  return {
    supported: true,
    message: "Stdio MCP is available."
  };
}

function isStdioMcpRuntimeSupported(options = {}) {
  return getStdioMcpRuntimeSupport(options).supported;
}

function assertStdioMcpRuntimeSupported(options = {}) {
  const support = getStdioMcpRuntimeSupport(options);
  if (!support.supported) {
    throw new Error(support.message);
  }
}

function loadStdioMcpSpawn(options = {}) {
  const spawn = getStdioMcpSpawn(options);
  if (typeof spawn !== "function") {
    throw new Error(STDIO_MCP_UNAVAILABLE_MESSAGE);
  }

  return spawn;
}

function getStdioMcpSpawn(options = {}) {
  const requireFn = typeof options.requireFn === "function"
    ? options.requireFn
    : (typeof require === "function" ? require : null);
  if (!requireFn) {
    return null;
  }

  try {
    const childProcess = requireFn("child_process");
    return typeof childProcess?.spawn === "function" ? childProcess.spawn : null;
  } catch {
    return null;
  }
}

module.exports = {
  STDIO_MCP_UNAVAILABLE_MESSAGE,
  assertStdioMcpRuntimeSupported,
  getStdioMcpRuntimeSupport,
  isStdioMcpRuntimeSupported,
  loadStdioMcpSpawn
};
