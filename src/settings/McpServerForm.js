const { parseCommandArguments } = require("../mcp/McpStdioClient");

class McpCommandError extends Error {}

function formatMcpCommand(server) {
  const command = String(server.command || "");
  const quoted = /^[A-Za-z0-9_./:\\-]+$/.test(command) ? command : `"${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const input = `${quoted}${server.args ? `\n  ${server.args}` : ""}`;
  const expected = [command, ...parseCommandArguments(server.args)];
  if (command && JSON.stringify(parseCommandArguments(input)) !== JSON.stringify(expected)) {
    throw new McpCommandError("Unable to display this command without changing its arguments.");
  }
  return command ? input : "";
}

function parseMcpCommand(input, original = null) {
  if (original && input === formatMcpCommand(original)) return { command: original.command, args: original.args };
  let quote = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "\\" && /[\s"'\\]/.test(input[index + 1] || "!")) { index += 1; continue; }
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (/[;&|<>]/.test(char)) throw new McpCommandError("Command must be one program with arguments. Quote literal shell characters.");
  }
  if (quote) throw new McpCommandError("Close the quote in the MCP command.");
  const values = parseCommandArguments(input);
  if (!values.length) throw new McpCommandError("Enter one MCP program with arguments.");
  const args = values.slice(1).map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
  return { command: values[0], args };
}

module.exports = { McpCommandError, formatMcpCommand, parseMcpCommand };
