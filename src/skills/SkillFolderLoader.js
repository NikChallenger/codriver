const {
  extractSkillFileReferences,
  parseSkillMarkdown,
  SKILL_PROMPT_IGNORE_END,
  SKILL_PROMPT_IGNORE_START,
  stripSkillPromptIgnoredBlocks,
  SKILL_TEXT_EXTENSIONS: USER_SKILL_TEXT_EXTENSIONS
} = require("./SkillFileParser");

const DEFAULT_SKILL_FOLDER_PATH = "codriver/skills";
const LEGACY_HIDDEN_SKILL_FOLDER_PATH = ".codriver/skills";
const MAX_NEW_SKILL_NAME_CHARACTERS = 64;
const NEW_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class SkillFolderLoader {
  constructor(app, directory = DEFAULT_SKILL_FOLDER_PATH) {
    this.app = app;
    this.vault = app?.vault;
    this.directory = normalizeSkillFolderPath(directory);
  }

  getDirectory() {
    return this.directory;
  }

  setDirectory(directory) {
    this.directory = validateSkillFolderPath(directory);
    return this.directory;
  }

  async loadSkillSources() {
    const root = await this.ensureDirectory();
    const sources = [];
    const errors = [];
    const folders = root.children
      .filter(isVaultFolder)
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const folder of folders) {
      const skillPath = `${folder.path}/SKILL.md`;
      const skillFile = this.getAbstractFileByPath(skillPath);
      if (!isVaultFile(skillFile)) {
        continue;
      }

      try {
        sources.push(await this.loadSkillSource(folder, skillFile));
      } catch (error) {
        errors.push({
          path: skillPath,
          message: error instanceof Error ? error.message : "Unknown user skill load error."
        });
      }
    }

    return { sources, errors };
  }

  async ensureDirectory() {
    const directory = validateSkillFolderPath(this.directory);
    if (!this.vault || typeof this.vault.getAbstractFileByPath !== "function") {
      throw new Error("Skill folders require Obsidian Vault APIs.");
    }

    let current = null;
    const segments = directory.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const folderPath = segments.slice(0, index + 1).join("/");
      current = this.getAbstractFileByPath(folderPath);
      if (current) {
        if (!isVaultFolder(current)) {
          throw new Error(`Skills folder path collides with a vault file: ${folderPath}`);
        }
        continue;
      }

      if (typeof this.vault.createFolder !== "function") {
        throw new Error("Creating the skills folder requires Obsidian Vault APIs.");
      }
      current = await this.vault.createFolder(folderPath);
      if (!isVaultFolder(current)) {
        current = this.getAbstractFileByPath(folderPath);
      }
      if (!isVaultFolder(current)) {
        throw new Error(`Unable to create the skills folder: ${folderPath}`);
      }
    }

    return current;
  }

  async createSkill(name) {
    const skillName = validateNewSkillName(name);
    await this.ensureDirectory();
    const skillDirectory = `${this.directory}/${skillName}`;
    const skillPath = `${skillDirectory}/SKILL.md`;
    const existingDirectory = this.getAbstractFileByPath(skillDirectory);
    const existingSkill = this.getAbstractFileByPath(skillPath);

    if (existingDirectory || existingSkill) {
      throw createDuplicateSkillError(skillName, isVaultFile(existingSkill) ? existingSkill.path : "");
    }
    if (typeof this.vault.createFolder !== "function" || typeof this.vault.create !== "function") {
      throw new Error("Creating a skill requires Obsidian Vault APIs.");
    }

    const createdDirectory = await this.vault.createFolder(skillDirectory);
    if (!isVaultFolder(createdDirectory) && !isVaultFolder(this.getAbstractFileByPath(skillDirectory))) {
      throw new Error(`Unable to create the skill folder: ${skillDirectory}`);
    }
    if (this.getAbstractFileByPath(skillPath)) {
      throw createDuplicateSkillError(skillName, skillPath);
    }

    const file = await this.vault.create(skillPath, createNewSkillTemplate(skillName));
    return {
      created: true,
      name: skillName,
      path: file?.path ?? skillPath,
      file
    };
  }

  getSkillFile(path) {
    const normalizedPath = normalizeVaultPath(path);
    const directory = validateSkillFolderPath(this.directory);
    if (normalizedPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("Skill file path must stay inside the configured skills folder.");
    }
    if (!normalizedPath.startsWith(`${directory}/`) || !normalizedPath.endsWith("/SKILL.md")) {
      throw new Error("Skill file must stay inside the configured skills folder.");
    }

    const file = this.getAbstractFileByPath(normalizedPath);
    if (!isVaultFile(file)) {
      throw new Error(`Skill file was not found: ${normalizedPath}`);
    }
    return file;
  }

  async loadSkillSource(directory, skillFile) {
    const content = await this.readVaultFile(skillFile);
    return {
      directory: directory.path,
      skillPath: skillFile.path,
      content,
      files: await this.readReferencedAuxiliaryFiles(directory.path, content)
    };
  }

  async readReferencedAuxiliaryFiles(baseDirectory, skillContent) {
    let body = "";
    try {
      body = stripSkillPromptIgnoredBlocks(parseSkillMarkdown(skillContent).body);
    } catch {
      return [];
    }

    let references = [];
    try {
      references = extractSkillFileReferences(body);
    } catch {
      return [];
    }

    const files = [];
    for (const relativePath of references) {
      if (!USER_SKILL_TEXT_EXTENSIONS.has(getExtension(relativePath))) {
        continue;
      }

      const filePath = `${normalizeVaultPath(baseDirectory)}/${relativePath}`;
      const file = this.getAbstractFileByPath(filePath);
      if (!isVaultFile(file)) {
        continue;
      }

      files.push({
        path: file.path,
        relativePath,
        content: await this.readVaultFile(file)
      });
    }

    return files;
  }

  async readVaultFile(file) {
    const read = this.vault?.cachedRead ?? this.vault?.read;
    if (typeof read !== "function") {
      throw new Error("Reading skills requires Obsidian Vault APIs.");
    }
    return read.call(this.vault, file);
  }

  getAbstractFileByPath(path) {
    return this.vault?.getAbstractFileByPath?.(normalizeVaultPath(path)) ?? null;
  }
}

function normalizeSkillFolderPath(value) {
  return String(value ?? DEFAULT_SKILL_FOLDER_PATH)
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function validateSkillFolderPath(value) {
  const rawPath = String(value ?? "").trim();
  const normalizedPath = normalizeSkillFolderPath(rawPath);
  if (!rawPath || !normalizedPath) {
    throw new Error("Skills folder must be a non-empty vault-relative path.");
  }
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalizedPath)) {
    throw new Error("Skills folder must be relative to the current vault.");
  }

  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Skills folder must stay inside the current vault.");
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new Error("Skills folder must use folders visible in Obsidian.");
  }
  if (segments.some((segment) => !segment || /[<>:"|?*\x00-\x1F]/.test(segment))) {
    throw new Error("Skills folder contains characters that are unsafe in a vault path.");
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) {
    throw new Error("Skills folder segments cannot end with a dot or space.");
  }
  return normalizedPath;
}

function validateNewSkillName(value) {
  const name = String(value ?? "").trim();
  if (!name) {
    throw new Error("Skill name is required.");
  }
  if (name.length > MAX_NEW_SKILL_NAME_CHARACTERS) {
    throw new Error(`Skill name must be at most ${MAX_NEW_SKILL_NAME_CHARACTERS} characters.`);
  }
  if (!NEW_SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, and single hyphens.");
  }
  return name;
}

function createNewSkillTemplate(name) {
  const skillName = validateNewSkillName(name);
  const title = skillName
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

  return [
    "---",
    `name: ${skillName}`,
    "description: Describe when CoDriver should make this skill available.",
    "invocation: model",
    "---",
    `# ${title}`,
    "",
    SKILL_PROMPT_IGNORE_START,
    "## CoDriver skill reference",
    "",
    "> [!important] Editing workflow",
    "> After saving changes to this `SKILL.md`, open CoDriver Settings and click `Reload skills`.",
    "",
    "This reference is visible in Obsidian but is not included in the active skill prompt.",
    "You can safely delete this entire section.",
    "",
    "### Author-only comments and reference text",
    "",
    "Wrap comments or reference text in a complete marker pair to keep it in `SKILL.md` while",
    "excluding it from the model prompt and auxiliary-file loading. Multiple complete blocks are",
    "supported. An unmatched marker is treated as normal skill instruction text.",
    "",
    "```markdown",
    SKILL_PROMPT_IGNORE_START,
    "Author-only notes or reference text.",
    SKILL_PROMPT_IGNORE_END,
    "```",
    "",
    "### Supported frontmatter fields",
    "",
    "- `name` (required): runtime skill ID and slash-command name. New skills use the",
    "  validated lowercase kebab-case folder name (1-64 characters).",
    "- `description` (required): explains when the skill is useful for slash suggestions and",
    "  model routing.",
    "- `invocation` (optional, default `model`): activation behavior while the skill is Enabled:",
    "  - `manual`: explicit slash activation only.",
    "  - `model`: manual activation, note-frontmatter matching, and model routing.",
    "  - `always`: include the skill in every request while it is Enabled.",
    "  - Any other value keeps the skill unavailable and shows a warning in Settings.",
    "- `license` (optional): descriptive license label; it does not change runtime behavior.",
    "- `compatibility` (optional): restricts availability to `mobile` or `desktop`. When omitted,",
    "  the skill is available on both platforms. Any other value keeps it unavailable and shows",
    "  a warning in Settings.",
    "- `metadata` (optional): one-level custom key/value mapping. An instruction may reference",
    "  one distinct scalar value as `{{metadata.<key>}}`; unreferenced values are not added to",
    "  provider context. Missing, empty, malformed, non-scalar, or oversized values fail closed.",
    "  Metadata cannot load files, execute behavior, or change CoDriver permissions.",
    "- `requires.mcp` (optional): non-empty list of configured MCP server requirements:",
    "  - `server`: exact configured server ID, or a unique exact configured server name.",
    "  - `tools`: optional non-empty list of exact discovered tool names. When omitted, CoDriver",
    "    requires the server's currently enabled, runtime-available discovered tools.",
    "  - Explicit tools may be attached when globally disabled, but requirements never change",
    "    Enabled state, connections, credentials, or exact-tool Auto permissions.",
    "  - Limits: 32 server entries, 128 tools per entry, 256 total tool references, and 160",
    "    characters per server identity or tool name. Duplicate servers merge deterministically.",
    "  - URLs, transports, commands, arguments, environment variables, headers, credentials,",
    "    wildcards, and filesystem paths are not supported.",
    "",
    "Optional frontmatter example:",
    "",
    "```yaml",
    "license: MIT",
    "compatibility: desktop",
    "metadata:",
    "  transcript_path: Transcripts",
    "requires:",
    "  mcp:",
    "    - server: configured-server-id",
    "      tools:",
    "        - exact-tool-name",
    "```",
    "",
    "### Instruction body",
    "",
    "- Text outside this reference becomes the instructions sent while the skill is active.",
    "- `{{vaultName}}` expands to the current vault name; `{baseDir}` expands to this skill folder.",
    "- `{{metadata.transcript_path}}` inserts only that explicitly referenced custom metadata",
    "  value. A skill may reference one distinct custom metadata key, repeated as needed.",
    "- Direct Markdown links, wikilinks, and embeds may include local `.csv`, `.json`, `.md`,",
    "  `.txt`, `.tsv`, `.yaml`, and `.yml` auxiliary files inside this skill folder.",
    "- References are text-only, local, non-recursive, and never fetch remote content.",
    "- Limits: 131072 `SKILL.md` characters, 32 direct references, 65536 characters per auxiliary",
    "  file, 131072 auxiliary characters per skill, and 524288 per reload.",
    "- Skills provide instructions and context only; they do not run local scripts or commands.",
    SKILL_PROMPT_IGNORE_END,
    "",
    "## Instructions",
    "",
    "Write clear instructions for CoDriver here.",
    ""
  ].join("\n");
}

function createDuplicateSkillError(name, existingPath = "") {
  const error = new Error(`A skill folder already exists for: ${name}`);
  error.code = "skill-exists";
  error.existingPath = existingPath;
  return error;
}

function isVaultFolder(file) {
  return Boolean(file) && Array.isArray(file.children) && typeof file.path === "string";
}

function isVaultFile(file) {
  return Boolean(file) && !isVaultFolder(file) && typeof file.path === "string";
}

function getExtension(path) {
  const fileName = path.split("/").pop() ?? "";
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart === -1 ? "" : fileName.slice(extensionStart).toLowerCase();
}

function normalizeVaultPath(path) {
  return String(path ?? "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

module.exports = {
  DEFAULT_SKILL_FOLDER_PATH,
  LEGACY_HIDDEN_SKILL_FOLDER_PATH,
  MAX_NEW_SKILL_NAME_CHARACTERS,
  NEW_SKILL_NAME_PATTERN,
  SkillFolderLoader,
  USER_SKILL_TEXT_EXTENSIONS,
  createDuplicateSkillError,
  createNewSkillTemplate,
  normalizeSkillFolderPath,
  validateNewSkillName,
  validateSkillFolderPath
};
