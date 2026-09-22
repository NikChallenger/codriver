const MAX_COMMAND_PROMPT_CHARACTERS = 32_768;
const MAX_COMMAND_FILE_CHARACTERS = 36_864;
const MAX_COMMAND_DESCRIPTION_CHARACTERS = 1_024;
const MAX_COMMAND_NAME_CHARACTERS = 64;
const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseCommandMarkdown(content, sourcePath = "") {
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const label = sourcePath || "command file";
  if (text.length > MAX_COMMAND_FILE_CHARACTERS) throw new Error(`Command ${label} exceeds the ${MAX_COMMAND_FILE_CHARACTERS} character file limit.`);
  if (!text.startsWith("---\n")) {
    throw new Error(`Command ${label} is missing YAML frontmatter.`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`Command ${label} frontmatter was opened but not closed.`);
  }

  const metadata = {};
  const warnings = [];
  for (const rawLine of text.slice(4, end).split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const match = rawLine.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) throw new Error(`Command ${label} contains invalid frontmatter.`);
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      throw new Error(`Command ${label} contains duplicate ${key} metadata.`);
    }
    metadata[key] = unquoteScalar(match[2].trim());
    if (key !== "name" && key !== "description") warnings.push(`Unknown frontmatter field: ${key}`);
  }

  const name = String(metadata.name ?? "").trim();
  if (!name) throw new Error(`Command ${label} is missing required name metadata.`);
  if (name.length > MAX_COMMAND_NAME_CHARACTERS || !COMMAND_NAME_PATTERN.test(name)) {
    throw new Error(`Command ${label} name must use 1-64 lowercase letters, numbers, and single hyphens.`);
  }
  const description = String(metadata.description ?? "").trim();
  if (!description) throw new Error(`Command ${label} is missing required description metadata.`);
  if (description.length > MAX_COMMAND_DESCRIPTION_CHARACTERS) throw new Error(`Command ${label} description exceeds the ${MAX_COMMAND_DESCRIPTION_CHARACTERS} character limit.`);
  const prompt = text.slice(end + 5).trim();
  if (!prompt) throw new Error(`Command ${label} has an empty prompt body.`);
  if (prompt.length > MAX_COMMAND_PROMPT_CHARACTERS) {
    throw new Error(`Command ${label} exceeds the ${MAX_COMMAND_PROMPT_CHARACTERS} character prompt limit.`);
  }

  return {
    id: name.toLowerCase(),
    name,
    description,
    prompt,
    sourcePath: label,
    warning: warnings.join(" ")
  };
}

function unquoteScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

module.exports = {
  COMMAND_NAME_PATTERN,
  MAX_COMMAND_DESCRIPTION_CHARACTERS,
  MAX_COMMAND_FILE_CHARACTERS,
  MAX_COMMAND_NAME_CHARACTERS,
  MAX_COMMAND_PROMPT_CHARACTERS,
  parseCommandMarkdown
};
