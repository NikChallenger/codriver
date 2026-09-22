const {
  COMMAND_NAME_PATTERN,
  MAX_COMMAND_NAME_CHARACTERS,
  parseCommandMarkdown
} = require("./CommandFileParser");
const { normalizeSkillFolderPath, validateSkillFolderPath } = require("../skills/SkillFolderLoader");

const DEFAULT_COMMAND_FOLDER_PATH = "codriver/commands";

class CommandFolderLoader {
  constructor(app, directory = DEFAULT_COMMAND_FOLDER_PATH) {
    this.app = app;
    this.vault = app?.vault;
    this.directory = normalizeCommandFolderPath(directory);
  }

  getDirectory() { return this.directory; }
  setDirectory(value) { this.directory = validateCommandFolderPath(value); return this.directory; }

  async ensureDirectory() {
    const directory = validateCommandFolderPath(this.directory);
    if (!this.vault?.getAbstractFileByPath) throw new Error("Command folders require Obsidian Vault APIs.");
    let current = null;
    const segments = directory.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join("/");
      current = this.vault.getAbstractFileByPath(path);
      if (current) {
        if (!isVaultFolder(current)) throw new Error(`Commands folder path collides with a vault file: ${path}`);
        continue;
      }
      current = await this.vault.createFolder?.(path);
      if (!isVaultFolder(current)) current = this.vault.getAbstractFileByPath(path);
      if (!isVaultFolder(current)) throw new Error(`Unable to create the commands folder: ${path}`);
    }
    return current;
  }

  async loadCommands() {
    const root = await this.ensureDirectory();
    const commands = [];
    const errors = [];
    for (const file of root.children.filter((child) => isDirectMarkdownFile(child, root.path)).sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        const read = this.vault.cachedRead ?? this.vault.read;
        if (typeof read !== "function") throw new Error("Reading commands requires Obsidian Vault APIs.");
        commands.push(parseCommandMarkdown(await read.call(this.vault, file), file.path));
      } catch (error) {
        errors.push({ path: file.path, message: error instanceof Error ? error.message : "Unknown command load error." });
      }
    }
    const byId = new Map();
    for (const command of commands) {
      const matches = byId.get(command.id) ?? [];
      matches.push(command);
      byId.set(command.id, matches);
    }
    const loaded = [];
    for (const matches of byId.values()) {
      if (matches.length === 1) loaded.push(matches[0]);
      else for (const command of matches) errors.push({ path: command.sourcePath, message: `Duplicate command name: ${command.name}` });
    }
    return { commands: loaded.sort((a, b) => a.name.localeCompare(b.name)), errors };
  }

  async createCommand(name) {
    const commandName = validateNewCommandName(name);
    await this.ensureDirectory();
    const path = `${this.directory}/${commandName}.md`;
    if (this.vault.getAbstractFileByPath(path)) throw createDuplicateCommandError(commandName, path);
    if (typeof this.vault.create !== "function") throw new Error("Creating a command requires Obsidian Vault APIs.");
    const file = await this.vault.create(path, createNewCommandTemplate(commandName));
    return { created: true, name: commandName, path: file?.path ?? path, file };
  }

  getCommandFile(path) {
    const normalized = normalizeVaultPath(path);
    const directory = validateCommandFolderPath(this.directory);
    const relative = normalized.startsWith(`${directory}/`) ? normalized.slice(directory.length + 1) : "";
    if (!relative || relative.includes("/") || !relative.toLowerCase().endsWith(".md")) {
      throw new Error("Command file must be a direct Markdown child of the configured commands folder.");
    }
    const file = this.vault?.getAbstractFileByPath?.(normalized);
    if (!isVaultFile(file)) throw new Error(`Command file was not found: ${normalized}`);
    return file;
  }
}

function normalizeCommandFolderPath(value) {
  return normalizeSkillFolderPath(value ?? DEFAULT_COMMAND_FOLDER_PATH);
}

function validateCommandFolderPath(value) {
  try { return validateSkillFolderPath(value); }
  catch (error) { throw new Error(String(error?.message ?? error).replaceAll("Skills folder", "Commands folder")); }
}

function validateNewCommandName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("Command name is required.");
  if (name.length > MAX_COMMAND_NAME_CHARACTERS || !COMMAND_NAME_PATTERN.test(name)) {
    throw new Error("Command name must use 1-64 lowercase letters, numbers, and single hyphens.");
  }
  return name;
}

function createNewCommandTemplate(name) {
  const commandName = validateNewCommandName(name);
  return [
    "---",
    `name: ${commandName}`,
    "description: Describe when this command is useful.",
    "---",
    "",
    "Distill the following into its most useful knowledge points. Return only a bulleted list:",
    "",
    "{}",
    ""
  ].join("\n");
}

function createDuplicateCommandError(name, existingPath = "") {
  const error = new Error(`A command file already exists for: ${name}`);
  error.code = "command-exists";
  error.existingPath = existingPath;
  return error;
}

function isVaultFolder(file) { return Boolean(file) && Array.isArray(file.children) && typeof file.path === "string"; }
function isVaultFile(file) { return Boolean(file) && !isVaultFolder(file) && typeof file.path === "string"; }
function isDirectMarkdownFile(file, directory) {
  if (!isVaultFile(file) || !file.path.toLowerCase().endsWith(".md")) return false;
  const prefix = `${normalizeVaultPath(directory)}/`;
  return file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes("/");
}
function normalizeVaultPath(path) { return String(path ?? "").replaceAll("\\", "/").replace(/\/{2,}/g, "/"); }

module.exports = {
  CommandFolderLoader,
  DEFAULT_COMMAND_FOLDER_PATH,
  createDuplicateCommandError,
  createNewCommandTemplate,
  normalizeCommandFolderPath,
  validateCommandFolderPath,
  validateNewCommandName
};
