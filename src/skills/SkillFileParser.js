const MAX_SKILL_MARKDOWN_CHARACTERS = 131_072;
const MAX_SKILL_AUXILIARY_FILE_CHARACTERS = 65_536;
const MAX_SKILL_AUXILIARY_CHARACTERS = 131_072;
const MAX_SKILL_AUXILIARY_REFERENCES = 32;
const MAX_TOTAL_SKILL_AUXILIARY_CHARACTERS = 524_288;
const MAX_SKILL_MCP_REQUIREMENT_ENTRIES = 32;
const MAX_SKILL_MCP_TOOLS_PER_ENTRY = 128;
const MAX_SKILL_MCP_TOOL_REFERENCES = 256;
const MAX_SKILL_MCP_IDENTITY_CHARACTERS = 160;
const MAX_SKILL_METADATA_PLACEHOLDER_KEY_CHARACTERS = 64;
const MAX_SKILL_METADATA_PLACEHOLDER_VALUE_CHARACTERS = 1024;
const SKILL_PROMPT_IGNORE_START = "<!-- codriver-ignore:start -->";
const SKILL_PROMPT_IGNORE_END = "<!-- codriver-ignore:end -->";
const SKILL_INVOCATIONS = new Set(["manual", "model", "always"]);
const SKILL_COMPATIBILITIES = new Set(["mobile", "desktop"]);
const MAX_SKILL_METADATA_DISPLAY_CHARACTERS = 80;
const SKILL_TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".md",
  ".txt",
  ".tsv",
  ".yaml",
  ".yml"
]);

function createSkillFromSource(source, context = {}) {
  const skillContent = String(source.content || "");
  if (skillContent.length > MAX_SKILL_MARKDOWN_CHARACTERS) {
    throw new Error(
      `Skill ${source.skillPath} exceeds the ${MAX_SKILL_MARKDOWN_CHARACTERS} character SKILL.md limit.`
    );
  }

  const parsed = parseSkillMarkdown(skillContent);
  const metadata = parsed.metadata;
  const customMetadata = isPlainObject(metadata.metadata) ? metadata.metadata : {};
  const invocation = normalizeSkillEnumMetadata(
    metadata.invocation,
    Object.prototype.hasOwnProperty.call(metadata, "invocation"),
    "invocation",
    SKILL_INVOCATIONS,
    "model"
  );
  const compatibility = normalizeSkillEnumMetadata(
    metadata.compatibility,
    Object.prototype.hasOwnProperty.call(metadata, "compatibility"),
    "compatibility",
    SKILL_COMPATIBILITIES,
    ""
  );
  const metadataWarnings = [invocation.warning, compatibility.warning].filter(Boolean);
  const skillName = String(metadata.name || source.directory || "").trim();

  if (!skillName) {
    throw new Error(`Skill ${source.skillPath} is missing required name metadata.`);
  }

  const description = String(metadata.description || "").trim();

  if (!description) {
    throw new Error(`Skill ${source.skillPath} is missing required description metadata.`);
  }

  const sourceContext = {
    ...context,
    baseDir: source.directory || ""
  };

  const prompt = buildSystemPrompt(
    stripSkillPromptIgnoredBlocks(parsed.body),
    source.files,
    sourceContext,
    customMetadata
  );

  return {
    id: skillName,
    name: skillName,
    description,
    license: String(metadata.license || "").trim(),
    compatibility: compatibility.value,
    compatibilityDisplay: compatibility.displayValue,
    metadata: customMetadata,
    invocation: invocation.value,
    invocationDisplay: invocation.displayValue,
    metadataWarnings,
    ...(metadata.requires ? { requires: metadata.requires } : {}),
    command: `skill:${skillName}`,
    hidden: false,
    required: false,
    systemPrompt: prompt.content,
    requestedMetadataKeys: prompt.requestedMetadataKeys,
    auxiliaryCharacterCount: prompt.auxiliaryCharacterCount,
    sourcePath: source.skillPath
  };
}

function parseSkillMarkdown(content) {
  const normalizedContent = String(content || "").replace(/\r\n/g, "\n");
  if (!normalizedContent.startsWith("---\n")) {
    return {
      metadata: {},
      body: normalizedContent.trim()
    };
  }

  const closingIndex = normalizedContent.indexOf("\n---", 4);
  if (closingIndex === -1) {
    throw new Error("Skill frontmatter was opened but not closed.");
  }

  return {
    metadata: parseFrontmatter(normalizedContent.slice(4, closingIndex)),
    body: normalizedContent.slice(closingIndex + 4).trim()
  };
}

function stripSkillPromptIgnoredBlocks(body) {
  return stripCompleteMarkerBlocks(
    String(body || ""),
    SKILL_PROMPT_IGNORE_START,
    SKILL_PROMPT_IGNORE_END
  );
}

function stripCompleteMarkerBlocks(value, startMarker, endMarker) {
  const sections = [];
  let cursor = 0;
  let removed = false;

  while (cursor < value.length) {
    const startIndex = value.indexOf(startMarker, cursor);
    if (startIndex === -1) {
      break;
    }

    let depth = 1;
    let scanIndex = startIndex + startMarker.length;
    let endIndex = -1;
    while (depth > 0) {
      const nextStartIndex = value.indexOf(startMarker, scanIndex);
      const nextEndIndex = value.indexOf(endMarker, scanIndex);
      if (nextEndIndex === -1) {
        break;
      }
      if (nextStartIndex !== -1 && nextStartIndex < nextEndIndex) {
        depth += 1;
        scanIndex = nextStartIndex + startMarker.length;
        continue;
      }

      depth -= 1;
      endIndex = nextEndIndex;
      scanIndex = nextEndIndex + endMarker.length;
    }

    if (depth > 0 || endIndex === -1) {
      break;
    }

    sections.push(value.slice(cursor, startIndex).trim());
    cursor = endIndex + endMarker.length;
    removed = true;
  }

  if (!removed) {
    return value;
  }

  sections.push(value.slice(cursor).trim());
  return sections.filter(Boolean).join("\n\n");
}

function parseFrontmatter(frontmatter) {
  const metadata = {};
  let activeMappingKey = null;
  const lines = frontmatter.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const isNestedLine = /^\s+/.test(line);
    if (isNestedLine && activeMappingKey && isPlainObject(metadata[activeMappingKey])) {
      const nestedSeparatorIndex = trimmed.indexOf(":");
      if (nestedSeparatorIndex !== -1) {
        const nestedKey = trimmed.slice(0, nestedSeparatorIndex).trim();
        const nestedValue = trimmed.slice(nestedSeparatorIndex + 1).trim();
        metadata[activeMappingKey][nestedKey] = parseFrontmatterValue(nestedValue);
      }
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key === "requires") {
      if (isNestedLine) {
        throw new Error("Skill requires must be a top-level frontmatter mapping.");
      }
      if (Object.prototype.hasOwnProperty.call(metadata, "requires")) {
        throw new Error("Skill frontmatter contains duplicate requires metadata.");
      }
      const parsedRequires = parseSkillRequiresBlock(lines, index, value);
      metadata.requires = parsedRequires.requires;
      index = parsedRequires.endIndex;
      activeMappingKey = null;
      continue;
    }

    if (!value) {
      metadata[key] = {};
      activeMappingKey = key;
      continue;
    }

    metadata[key] = parseFrontmatterValue(value);
    activeMappingKey = null;
  }

  return metadata;
}

function parseSkillRequiresBlock(lines, startIndex, rootValue) {
  if (rootValue) {
    throw new Error("Skill requires must be a mapping containing mcp.");
  }

  const block = [];
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      endIndex = index;
      continue;
    }

    if (/^\S/.test(line)) {
      break;
    }
    if (/^\s*\t/.test(line)) {
      throw new Error("Skill requires indentation must use spaces.");
    }

    const indent = getLeadingSpaceCount(line);
    if (indent % 2 !== 0) {
      throw new Error("Skill requires indentation must use two-space levels.");
    }
    block.push({
      indent,
      text: trimmed,
      lineNumber: index + 1
    });
    endIndex = index;
  }

  if (block.length === 0) {
    throw new Error("Skill requires.mcp must be a non-empty array.");
  }

  const mcpHeader = block[0];
  const mcpSeparator = mcpHeader.text.indexOf(":");
  const mcpKey = mcpSeparator === -1 ? mcpHeader.text : mcpHeader.text.slice(0, mcpSeparator).trim();
  const mcpValue = mcpSeparator === -1 ? "" : mcpHeader.text.slice(mcpSeparator + 1).trim();
  if (mcpHeader.indent !== 2 || mcpKey !== "mcp") {
    throw new Error(`Unknown skill requires key: ${mcpKey || mcpHeader.text}.`);
  }
  if (mcpValue) {
    throw new Error("Skill requires.mcp must be a non-empty block array.");
  }

  const entries = parseSkillMcpRequirementEntries(block.slice(1));
  return {
    requires: {
      mcp: normalizeSkillMcpRequirements(entries)
    },
    endIndex
  };
}

function parseSkillMcpRequirementEntries(lines) {
  if (lines.length === 0) {
    throw new Error("Skill requires.mcp must be a non-empty array.");
  }

  const entries = [];
  let current = null;
  let toolsMode = false;

  const finishEntry = () => {
    if (!current) {
      return;
    }
    entries.push(current);
    current = null;
    toolsMode = false;
  };

  for (const line of lines) {
    if (line.indent === 2) {
      const key = line.text.split(":", 1)[0].trim();
      throw new Error(`Unknown skill requires key: ${key || line.text}.`);
    }

    if (line.indent === 4 && (line.text === "-" || line.text.startsWith("- "))) {
      finishEntry();
      if (entries.length >= MAX_SKILL_MCP_REQUIREMENT_ENTRIES) {
        throw new Error(
          `Skill requires.mcp exceeds the ${MAX_SKILL_MCP_REQUIREMENT_ENTRIES} server entry limit.`
        );
      }
      current = {
        server: undefined,
        tools: undefined,
        toolsDeclared: false
      };
      toolsMode = false;
      const inlineField = line.text.slice(1).trim();
      if (inlineField) {
        toolsMode = parseSkillMcpRequirementField(current, inlineField);
      }
      continue;
    }

    if (!current) {
      throw new Error(`Malformed skill requires.mcp entry at line ${line.lineNumber}.`);
    }

    if (line.indent === 6) {
      toolsMode = parseSkillMcpRequirementField(current, line.text);
      continue;
    }

    if (line.indent === 8 && toolsMode && line.text.startsWith("- ")) {
      const toolName = cleanScalar(line.text.slice(1));
      current.tools.push(toolName);
      if (current.tools.length > MAX_SKILL_MCP_TOOLS_PER_ENTRY) {
        throw new Error(
          `Skill requires.mcp tools exceed the ${MAX_SKILL_MCP_TOOLS_PER_ENTRY} per-server limit.`
        );
      }
      continue;
    }

    throw new Error(`Malformed skill requires.mcp nesting at line ${line.lineNumber}.`);
  }

  finishEntry();
  if (entries.length === 0) {
    throw new Error("Skill requires.mcp must be a non-empty array.");
  }
  return entries;
}

function parseSkillMcpRequirementField(entry, text) {
  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed skill requires.mcp entry field: ${text}.`);
  }

  const key = text.slice(0, separatorIndex).trim();
  const value = text.slice(separatorIndex + 1).trim();
  if (key !== "server" && key !== "tools") {
    throw new Error(`Unknown skill requires.mcp entry key: ${key || text}.`);
  }

  if (key === "server") {
    if (entry.server !== undefined) {
      throw new Error("Skill requires.mcp entry contains duplicate server metadata.");
    }
    if (!value) {
      throw new Error("Skill requires.mcp server identity must be non-empty.");
    }
    entry.server = cleanScalar(value);
    return false;
  }

  if (entry.toolsDeclared) {
    throw new Error("Skill requires.mcp entry contains duplicate tools metadata.");
  }
  entry.toolsDeclared = true;
  if (!value) {
    entry.tools = [];
    return true;
  }

  const parsedTools = parseFrontmatterValue(value);
  if (!Array.isArray(parsedTools)) {
    throw new Error("Skill requires.mcp tools must be an array.");
  }
  entry.tools = parsedTools;
  if (entry.tools.length > MAX_SKILL_MCP_TOOLS_PER_ENTRY) {
    throw new Error(
      `Skill requires.mcp tools exceed the ${MAX_SKILL_MCP_TOOLS_PER_ENTRY} per-server limit.`
    );
  }
  return false;
}

function normalizeSkillMcpRequirements(entries) {
  const merged = [];
  const byServer = new Map();
  let toolReferenceCount = 0;

  for (const entry of entries) {
    const server = validateSkillMcpIdentity(entry.server, "server");
    let tools = null;
    if (entry.toolsDeclared) {
      if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
        throw new Error(`Skill requires.mcp tools for ${server} must be a non-empty array.`);
      }
      const seenTools = new Set();
      tools = entry.tools.map((toolName) => {
        const normalized = validateSkillMcpIdentity(toolName, "tool");
        if (seenTools.has(normalized)) {
          throw new Error(`Skill requires.mcp tools for ${server} must be unique.`);
        }
        seenTools.add(normalized);
        toolReferenceCount += 1;
        if (toolReferenceCount > MAX_SKILL_MCP_TOOL_REFERENCES) {
          throw new Error(
            `Skill requires.mcp exceeds the ${MAX_SKILL_MCP_TOOL_REFERENCES} total tool reference limit.`
          );
        }
        return normalized;
      });
    }

    let target = byServer.get(server);
    if (!target) {
      target = {
        server,
        tools: tools === null ? null : []
      };
      byServer.set(server, target);
      merged.push(target);
    }

    if (tools === null) {
      target.tools = null;
      continue;
    }
    if (target.tools === null) {
      continue;
    }

    const existingTools = new Set(target.tools);
    for (const toolName of tools) {
      if (!existingTools.has(toolName)) {
        existingTools.add(toolName);
        target.tools.push(toolName);
      }
    }
  }

  return merged.map((entry) => (
    entry.tools === null
      ? { server: entry.server }
      : { server: entry.server, tools: entry.tools }
  ));
}

function validateSkillMcpIdentity(value, type) {
  const identity = String(value ?? "").trim();
  const label = type === "server" ? "server identity" : "tool name";
  if (!identity) {
    throw new Error(`Skill requires.mcp ${label} must be non-empty.`);
  }
  if (identity.length > MAX_SKILL_MCP_IDENTITY_CHARACTERS) {
    throw new Error(
      `Skill requires.mcp ${label} exceeds the ${MAX_SKILL_MCP_IDENTITY_CHARACTERS} character limit.`
    );
  }
  if (
    /[\u0000-\u001f\u007f]/.test(identity) ||
    /[\\/*?=;&|<>$`{}\[\]]/.test(identity) ||
    identity.includes("..") ||
    identity.includes("://") ||
    /^sk-[A-Za-z0-9_-]{8,}$/i.test(identity) ||
    /(?:authorization\s*:|bearer\s+|api[_ -]?key\s*[:=]|password\s*[:=]|token\s*[:=])/i.test(identity)
  ) {
    throw new Error(`Skill requires.mcp ${label} contains a forbidden value.`);
  }
  if (type === "server" && identity.includes(":")) {
    throw new Error("Skill requires.mcp server identity must not contain connection details.");
  }
  return identity;
}

function getLeadingSpaceCount(value) {
  const match = String(value || "").match(/^ */);
  return match ? match[0].length : 0;
}

function parseFrontmatterValue(value) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map(cleanScalar).filter(Boolean);
  }

  return cleanScalar(value);
}

function cleanScalar(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function buildSystemPrompt(body, files, context, customMetadata) {
  const metadataPlaceholderState = { key: "" };
  const promptSections = [replacePlaceholders(body, context, customMetadata, metadataPlaceholderState)];
  const includedFiles = findReferencedFiles(body, files);
  let auxiliaryCharacterCount = 0;

  for (const file of includedFiles) {
    const content = String(file.content || "");
    if (content.length > MAX_SKILL_AUXILIARY_FILE_CHARACTERS) {
      throw new Error(
        `Referenced skill file ${file.relativePath || file.path} exceeds the ` +
        `${MAX_SKILL_AUXILIARY_FILE_CHARACTERS} character file limit.`
      );
    }

    auxiliaryCharacterCount += content.length;
    if (auxiliaryCharacterCount > MAX_SKILL_AUXILIARY_CHARACTERS) {
      throw new Error(
        `Referenced skill files exceed the ${MAX_SKILL_AUXILIARY_CHARACTERS} character per-skill limit.`
      );
    }

    promptSections.push([
      `Referenced skill file: ${file.relativePath || file.path}`,
      replacePlaceholders(content, context, customMetadata, metadataPlaceholderState)
    ].join("\n\n"));
  }

  return {
    content: promptSections.filter(Boolean).join("\n\n"),
    auxiliaryCharacterCount,
    requestedMetadataKeys: metadataPlaceholderState.key ? [metadataPlaceholderState.key] : []
  };
}

function findReferencedFiles(body, files) {
  const references = extractSkillFileReferences(body);
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const matchedFiles = [];
  const matchedPaths = new Set();

  for (const reference of references) {
    if (!SKILL_TEXT_EXTENSIONS.has(getPathExtension(reference))) {
      continue;
    }

    const file = findFileByReference(files, reference);
    if (!file) {
      continue;
    }

    const key = normalizeSkillPath(file.path || file.relativePath);
    if (!matchedPaths.has(key)) {
      matchedPaths.add(key);
      matchedFiles.push(file);
    }
  }

  return matchedFiles;
}

function extractSkillFileReferences(body) {
  const references = [];
  const markdownLinkPattern = /\[[^\]]*]\(([^)]+)\)/g;
  const wikiLinkPattern = /!?\[\[([^\[\]]+)]]/g;
  let match;

  const markdown = String(body || "");
  while ((match = markdownLinkPattern.exec(markdown)) !== null) {
    const reference = normalizeMarkdownReference(match[1]);
    if (reference && SKILL_TEXT_EXTENSIONS.has(getPathExtension(reference))) {
      references.push({ index: match.index, reference });
    }
  }

  while ((match = wikiLinkPattern.exec(markdown)) !== null) {
    const reference = normalizeWikiReference(match[1]);
    if (reference && SKILL_TEXT_EXTENSIONS.has(getPathExtension(reference))) {
      references.push({ index: match.index, reference });
    }
  }

  references.sort((left, right) => left.index - right.index);
  const uniqueReferences = [];
  const seen = new Set();

  for (const item of references) {
    if (seen.has(item.reference)) {
      continue;
    }

    seen.add(item.reference);
    uniqueReferences.push(item.reference);
  }

  if (uniqueReferences.length > MAX_SKILL_AUXILIARY_REFERENCES) {
    throw new Error(
      `Skill references exceed the ${MAX_SKILL_AUXILIARY_REFERENCES} direct auxiliary file limit.`
    );
  }

  return uniqueReferences;
}

function normalizeMarkdownReference(value) {
  const rawReference = String(value || "").trim();
  if (!rawReference || rawReference.startsWith("#")) {
    return "";
  }

  const pathOnly = rawReference
    .split("#")[0]
    .split("?")[0]
    .trim()
    .split(/\s+/)[0];

  return normalizeLocalSkillReference(pathOnly);
}

function normalizeWikiReference(value) {
  const pathOnly = String(value || "")
    .split("|")[0]
    .split("#")[0]
    .trim();

  return normalizeLocalSkillReference(pathOnly);
}

function normalizeLocalSkillReference(value) {
  const normalized = normalizeSkillPath(value);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
  ) {
    return "";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return "";
  }

  return segments.filter((segment) => segment !== ".").join("/");
}

function findFileByReference(files, reference) {
  return files.find((file) => {
    const relativePath = normalizeSkillPath(file.relativePath);
    return relativePath === reference;
  });
}

function normalizeSkillPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
}

function getPathExtension(value) {
  const fileName = normalizeSkillPath(value).split("/").pop() || "";
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart === -1 ? "" : fileName.slice(extensionStart).toLowerCase();
}

function replacePlaceholders(value, context, customMetadata, metadataPlaceholderState) {
  const source = String(value || "")
    .replace(/\{\{vaultName\}\}/g, context.vaultName || "current vault")
    .replace(/\{baseDir\}/g, context.baseDir || "");
  const exactMetadataPattern = /\{\{metadata\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g;
  const unmatchedMetadataSyntax = source.replace(exactMetadataPattern, "");
  if (unmatchedMetadataSyntax.includes("{{metadata")) {
    throw new Error(
      "Skill metadata placeholder is malformed. Use {{metadata.<key>}} with a 1-64 character key."
    );
  }

  const withMetadata = source.replace(exactMetadataPattern, (_match, key) => {
    if (key.length > MAX_SKILL_METADATA_PLACEHOLDER_KEY_CHARACTERS) {
      throw new Error(
        `Skill metadata placeholder key exceeds the ${MAX_SKILL_METADATA_PLACEHOLDER_KEY_CHARACTERS} character limit.`
      );
    }
    if (metadataPlaceholderState.key && metadataPlaceholderState.key !== key) {
      throw new Error("A skill may reference only one distinct custom metadata key in its prompt.");
    }
    metadataPlaceholderState.key = key;
    if (!Object.prototype.hasOwnProperty.call(customMetadata, key)) {
      throw new Error(`Skill metadata placeholder references a missing key: metadata.${key}.`);
    }

    const metadataValue = customMetadata[key];
    if (!["string", "number", "boolean"].includes(typeof metadataValue)) {
      throw new Error(`Skill metadata value metadata.${key} must be a scalar value.`);
    }
    const normalizedValue = String(metadataValue);
    if (!normalizedValue.trim()) {
      throw new Error(`Skill metadata value metadata.${key} must be non-empty.`);
    }
    if (
      normalizedValue.length > MAX_SKILL_METADATA_PLACEHOLDER_VALUE_CHARACTERS ||
      /[\u0000-\u001f\u007f]/.test(normalizedValue)
    ) {
      throw new Error(
        `Skill metadata value metadata.${key} contains control characters or exceeds the ` +
        `${MAX_SKILL_METADATA_PLACEHOLDER_VALUE_CHARACTERS} character limit.`
      );
    }
    return normalizedValue;
  });

  return withMetadata;
}

function normalizeSkillEnumMetadata(value, isPresent, field, supportedValues, defaultValue) {
  if (!isPresent) {
    return {
      value: defaultValue,
      displayValue: defaultValue,
      warning: ""
    };
  }

  const normalized = typeof value === "string"
    ? value.trim().toLowerCase()
    : String(value ?? "").trim().toLowerCase();
  const displayValue = formatSkillMetadataDisplayValue(normalized);
  if (supportedValues.has(normalized)) {
    return {
      value: normalized,
      displayValue,
      warning: ""
    };
  }

  return {
    value: normalized,
    displayValue,
    warning: `Invalid ${field} "${displayValue}". Use ${formatSupportedValues(supportedValues)}.`
  };
}

function formatSkillMetadataDisplayValue(value) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= MAX_SKILL_METADATA_DISPLAY_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SKILL_METADATA_DISPLAY_CHARACTERS - 3)}...`;
}

function formatSupportedValues(values) {
  const items = Array.from(values);
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} or ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  createSkillFromSource,
  extractSkillFileReferences,
  MAX_SKILL_AUXILIARY_CHARACTERS,
  MAX_SKILL_AUXILIARY_FILE_CHARACTERS,
  MAX_SKILL_AUXILIARY_REFERENCES,
  MAX_SKILL_MARKDOWN_CHARACTERS,
  MAX_SKILL_MCP_IDENTITY_CHARACTERS,
  MAX_SKILL_METADATA_PLACEHOLDER_KEY_CHARACTERS,
  MAX_SKILL_METADATA_PLACEHOLDER_VALUE_CHARACTERS,
  MAX_SKILL_MCP_REQUIREMENT_ENTRIES,
  MAX_SKILL_MCP_TOOL_REFERENCES,
  MAX_SKILL_MCP_TOOLS_PER_ENTRY,
  MAX_TOTAL_SKILL_AUXILIARY_CHARACTERS,
  parseSkillMarkdown,
  SKILL_COMPATIBILITIES,
  SKILL_INVOCATIONS,
  SKILL_PROMPT_IGNORE_END,
  SKILL_PROMPT_IGNORE_START,
  SKILL_TEXT_EXTENSIONS,
  stripSkillPromptIgnoredBlocks
};
