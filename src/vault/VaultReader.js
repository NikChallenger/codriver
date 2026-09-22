const { resolveVaultAudioPath } = require("./AudioPathResolver");

class VaultReader {
  constructor(app) {
    this.app = app;
    this.vault = app.vault ?? app;
  }

  async readFile(file) {
    return this.vault.read(file);
  }

  getActiveFile() {
    return this.app.workspace?.getActiveFile?.() ?? null;
  }

  getActiveFileInfo() {
    const file = this.getActiveFile();
    if (!file) {
      return {
        path: null,
        name: "",
        extension: "",
        isMarkdown: false
      };
    }

    return {
      path: file.path,
      name: file.name ?? getFileName(file.path),
      extension: file.extension ?? getFileExtension(file.path),
      isMarkdown: (file.extension ?? getFileExtension(file.path)) === "md"
    };
  }

  getActiveMarkdownContextInfo() {
    const file = this.getActiveFile();
    if (!file) {
      return {
        available: false,
        path: null,
        label: "No active Markdown note",
        reason: "No active Markdown note is open."
      };
    }

    if (file.extension !== "md") {
      return {
        available: false,
        path: file.path,
        label: "Active file is not Markdown",
        reason: "The active file is not a Markdown note."
      };
    }

    return {
      available: true,
      path: file.path,
      label: file.path,
      reason: ""
    };
  }

  getActiveMarkdownContextLabel() {
    return this.getActiveMarkdownContextInfo().label;
  }

  async readActiveMarkdownContext() {
    const file = this.getActiveFile();
    if (!file) {
      return {
        included: false,
        reason: "No active Markdown note is open.",
        path: null,
        content: ""
      };
    }

    if (file.extension !== "md") {
      return {
        included: false,
        reason: "The active file is not a Markdown note.",
        path: file.path,
        content: ""
      };
    }

    const content = await this.readFile(file);
    return {
      included: true,
      reason: "",
      path: file.path,
      content
    };
  }

  async readMentionedMarkdownContext(text) {
    const file = this.findMentionedMarkdownFile(text);
    if (!file) {
      return {
        included: false,
        reason: "No mentioned Markdown note was found.",
        path: null,
        content: ""
      };
    }

    const content = await this.readFile(file);
    return {
      included: true,
      reason: "",
      path: file.path,
      content
    };
  }

  async readMarkdownPath(path) {
    const normalizedPath = normalizePathSeparators(String(path || "").trim());
    if (!normalizedPath) {
      throw new Error("Set a vault-relative Markdown note path before reading.");
    }

    const file = this.vault.getAbstractFileByPath?.(normalizedPath);
    if (!file) {
      throw new Error(`Vault note was not found: ${normalizedPath}`);
    }

    if (file.extension !== "md") {
      throw new Error("Only Markdown notes can be read through this tool.");
    }

    const content = await this.readFile(file);
    return {
      path: file.path,
      content
    };
  }

  async listVaultPath(path = "") {
    const normalizedPath = normalizeVaultPath(path);
    const folder = this.getFolderByPath(normalizedPath);
    if (folder?.children && Array.isArray(folder.children)) {
      return {
        path: normalizedPath,
        entries: folder.children.map(createVaultEntry).filter(Boolean).sort(sortVaultEntries)
      };
    }

    return {
      path: normalizedPath,
      entries: this.deriveVaultEntriesFromFiles(normalizedPath)
    };
  }

  async getMarkdownDocumentMap(path, options = {}) {
    const note = await this.readMarkdownPath(path);
    const file = this.getAbstractFileByPath(note.path);
    const cache = file ? this.app.metadataCache?.getFileCache?.(file) : null;
    const cachedFrontmatter = cache?.frontmatter && typeof cache.frontmatter === "object"
      ? cache.frontmatter
      : null;
    const headings = Array.isArray(cache?.headings)
      ? cache.headings.map((heading) => ({
          heading: heading.heading,
          level: heading.level,
          line: heading.position?.start?.line ?? null
        }))
      : parseMarkdownHeadings(note.content);
    const blocks = cache?.blocks && typeof cache.blocks === "object"
      ? Object.entries(cache.blocks).map(([id, block]) => ({
          id,
          line: block?.position?.start?.line ?? null
        }))
      : [];
    const frontmatter = cachedFrontmatter
      ? { ...cachedFrontmatter }
      : parseSimpleFrontmatter(note.content);
    const result = {
      path: note.path,
      headings,
      blocks,
      frontmatterKeys: Object.keys(frontmatter).sort()
    };

    if (options?.includeFrontmatterValues === true) {
      result.frontmatter = frontmatter;
    }

    if (options?.includeLinks === true) {
      result.links = this.getMarkdownLinks(note.path);
    }

    return result;
  }

  async getMarkdownFrontmatter(path) {
    const note = await this.readMarkdownPath(path);
    const file = this.getAbstractFileByPath(note.path);
    const cache = file ? this.app.metadataCache?.getFileCache?.(file) : null;
    const frontmatter = cache?.frontmatter && typeof cache.frontmatter === "object"
      ? { ...cache.frontmatter }
      : parseSimpleFrontmatter(note.content);

    return {
      path: note.path,
      frontmatter
    };
  }

  async readMarkdownTarget(path, targetType, target) {
    const normalizedType = String(targetType ?? "").trim().toLowerCase();
    const normalizedTarget = String(target ?? "").trim();
    if (!normalizedTarget) {
      throw new Error("Set a target before reading a note target.");
    }

    if (normalizedType === "heading") {
      return this.readMarkdownHeadingTarget(path, normalizedTarget);
    }

    if (normalizedType === "block") {
      return this.readMarkdownBlockTarget(path, normalizedTarget);
    }

    if (normalizedType === "frontmatter") {
      return this.readMarkdownFrontmatterTarget(path, normalizedTarget);
    }

    throw new Error("Target type must be heading, block, or frontmatter.");
  }

  async readMarkdownHeadingTarget(path, headingText) {
    const note = await this.readMarkdownPath(path);
    const section = findMarkdownSection(note.content, headingText);
    if (!section) {
      throw new Error(`Heading was not found exactly once: ${headingText}`);
    }

    return {
      path: note.path,
      targetType: "heading",
      target: headingText,
      content: section.content,
      startLine: section.startLine,
      endLine: section.endLine,
      characterCount: section.content.length
    };
  }

  async readMarkdownBlockTarget(path, blockId) {
    const note = await this.readMarkdownPath(path);
    const file = this.getAbstractFileByPath(note.path);
    const cache = file ? this.app.metadataCache?.getFileCache?.(file) : null;
    const normalizedBlockId = normalizeBlockId(blockId);
    const block = cache?.blocks?.[normalizedBlockId];
    const lines = getMarkdownLines(note.content);

    if (block?.position?.start && Number.isInteger(block.position.start.line)) {
      const startLine = block.position.start.line;
      const endLine = Number.isInteger(block.position.end?.line) ? block.position.end.line : startLine;
      const content = lines.slice(startLine, endLine + 1).map((line) => line.text).join("");
      return {
        path: note.path,
        targetType: "block",
        target: normalizedBlockId,
        content: content.trimEnd(),
        startLine,
        endLine,
        characterCount: content.trimEnd().length
      };
    }

    const blockPattern = new RegExp(`(^|\\s)\\^${escapeRegExp(normalizedBlockId)}\\b`);
    const lineIndex = lines.findIndex((line) => blockPattern.test(line.text));
    if (lineIndex === -1) {
      throw new Error(`Block reference was not found: ^${normalizedBlockId}`);
    }

    const range = expandMarkdownParagraphRange(lines, lineIndex);
    const content = lines.slice(range.startLine, range.endLine + 1).map((line) => line.text).join("");
    return {
      path: note.path,
      targetType: "block",
      target: normalizedBlockId,
      content: content.trimEnd(),
      startLine: range.startLine,
      endLine: range.endLine,
      characterCount: content.trimEnd().length
    };
  }

  async readMarkdownFrontmatterTarget(path, key) {
    const result = await this.getMarkdownFrontmatter(path);
    if (!Object.prototype.hasOwnProperty.call(result.frontmatter, key)) {
      throw new Error(`Frontmatter key was not found: ${key}`);
    }

    return {
      path: result.path,
      targetType: "frontmatter",
      target: key,
      value: result.frontmatter[key]
    };
  }

  async searchMarkdownQuery(query = {}, options = {}) {
    const filters = normalizeSearchQueryFilters(query);
    const maxResults = options.maxResults ?? 8;
    const maxSnippetLength = options.maxSnippetLength ?? 240;
    const results = [];

    for (const file of this.getMarkdownFiles()) {
      const cache = this.app.metadataCache?.getFileCache?.(file);
      const cachedFrontmatter = cache?.frontmatter && typeof cache.frontmatter === "object"
        ? cache.frontmatter
        : null;
      const needsFrontmatterFallback = !cachedFrontmatter && (
        Object.keys(filters.frontmatter).length > 0 ||
        filters.frontmatterExists.length > 0 ||
        (filters.tags.length > 0 && !Array.isArray(cache?.tags))
      );
      const content = filters.text || needsFrontmatterFallback
        ? await this.readFile(file)
        : "";
      const frontmatter = cachedFrontmatter
        ? { ...cachedFrontmatter }
        : (needsFrontmatterFallback ? parseSimpleFrontmatter(content) : {});
      const tags = extractTagsFromCache(cache, frontmatter);
      const stat = normalizeFileStat(file?.stat);
      const match = matchStructuredSearch(
        file.path,
        content,
        frontmatter,
        tags,
        stat,
        filters,
        maxSnippetLength
      );
      if (match.matched) {
        const result = {
          path: file.path,
          mtime: stat.mtime,
          ctime: stat.ctime,
          size: stat.size,
          tags: Array.from(tags).sort((left, right) => left.localeCompare(right)),
          frontmatterKeys: Object.keys(frontmatter).sort((left, right) => left.localeCompare(right)),
          score: match.score,
          matches: match.matches
        };
        if (filters.text) {
          result.snippet = match.snippet;
        }
        results.push(result);
      }
    }

    results.sort((left, right) => compareStructuredSearchResults(left, right, filters));

    return {
      query: filters,
      results: results.slice(0, maxResults)
    };
  }

  getMarkdownLinks(path) {
    const normalizedPath = normalizeVaultPath(path);
    if (!normalizedPath) {
      throw new Error("Set a vault-relative Markdown note path before inspecting links.");
    }
    const file = this.getAbstractFileByPath(normalizedPath);
    if (!file || file.extension !== "md") {
      throw new Error(`Vault note was not found: ${normalizedPath}`);
    }
    const metadataCache = this.app.metadataCache;
    const fileCache = metadataCache?.getFileCache?.(file) ?? null;
    const cache = fileCache ?? {};
    const outgoingLinks = Array.isArray(cache.links)
      ? cache.links.map((link) => createLinkEntry(link, file.path, metadataCache)).filter(Boolean)
      : [];
    const embeds = Array.isArray(cache.embeds)
      ? cache.embeds.map((embed) => createLinkEntry(embed, file.path, metadataCache)).filter(Boolean)
      : [];
    const resolvedLinks = metadataCache?.resolvedLinks;
    const unresolvedLinks = metadataCache?.unresolvedLinks;

    return {
      path: file.path,
      metadataCacheAvailable: Boolean(metadataCache),
      fileCacheAvailable: Boolean(fileCache),
      outgoingLinks,
      backlinks: collectBacklinks(file.path, resolvedLinks),
      unresolvedLinks: collectUnresolvedLinks(file.path, outgoingLinks, unresolvedLinks),
      embeds
    };
  }

  getPeriodicNotePath(period, dateValue = "") {
    const normalizedPeriod = String(period ?? "").trim().toLowerCase();
    if (!["daily", "weekly", "monthly", "quarterly", "yearly"].includes(normalizedPeriod)) {
      throw new Error("Period must be daily, weekly, monthly, quarterly, or yearly.");
    }

    const date = parseIsoDateOrToday(dateValue);
    const settings = this.getPeriodicNoteSettings(normalizedPeriod);
    const format = settings.format || getDefaultPeriodicDateFormat(normalizedPeriod);
    const basename = formatPeriodicDate(format, date, normalizedPeriod);
    const filename = basename.toLowerCase().endsWith(".md") ? basename : `${basename}.md`;
    const folder = normalizeVaultPath(settings.folder ?? "");
    const path = normalizeVaultPath(folder ? `${folder}/${filename}` : filename);
    const file = this.getAbstractFileByPath(path);

    return {
      period: normalizedPeriod,
      date: formatDatePart(date),
      path,
      exists: Boolean(file),
      source: settings.source
    };
  }

  getPeriodicNoteSettings(period) {
    const periodicPluginOptions = this.app.internalPlugins?.plugins?.["periodic-notes"]?.instance?.options;
    const dailyPluginOptions = this.app.internalPlugins?.plugins?.["daily-notes"]?.instance?.options;
    const candidates = [];

    if (period === "daily" && dailyPluginOptions) {
      candidates.push({
        folder: dailyPluginOptions.folder,
        format: dailyPluginOptions.format,
        source: "daily-notes"
      });
    }

    const periodicOptions = periodicPluginOptions?.[period];
    if (periodicOptions) {
      candidates.push({
        folder: periodicOptions.folder,
        format: periodicOptions.format,
        source: "periodic-notes"
      });
    }

    return candidates.find((candidate) => candidate.folder || candidate.format) ?? {
      folder: "",
      format: "",
      source: "default"
    };
  }

  getTagList() {
    const metadataTags = this.app.metadataCache?.getTags?.();
    if (metadataTags && typeof metadataTags === "object") {
      return Object.entries(metadataTags)
        .map(([tag, count]) => ({
          tag,
          count: Number.isFinite(count) ? count : 0
        }))
        .sort(sortTags);
    }

    const counts = new Map();
    for (const file of this.getMarkdownFiles()) {
      const cache = this.app.metadataCache?.getFileCache?.(file);
      for (const tag of extractTagsFromCache(cache)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort(sortTags);
  }

  async openVaultFile(path, options = {}) {
    const normalizedPath = normalizeVaultPath(path);
    const file = this.getAbstractFileByPath(normalizedPath);
    if (!file) {
      throw new Error(`Vault file was not found: ${normalizedPath}`);
    }

    const leaf = this.app.workspace?.getLeaf?.(options.newLeaf === true);
    if (leaf?.openFile) {
      await leaf.openFile(file);
      return {
        path: file.path,
        opened: true
      };
    }

    if (this.app.workspace?.openLinkText) {
      await this.app.workspace.openLinkText(file.path, "", options.newLeaf === true);
      return {
        path: file.path,
        opened: true
      };
    }

    throw new Error("Obsidian workspace file opening API is not available.");
  }

  async searchMarkdown(query, options = {}) {
    const normalizedQuery = String(query || "").trim();
    const maxResults = options.maxResults ?? 8;
    const maxSnippetLength = options.maxSnippetLength ?? 240;
    const tokens = tokenizeSearchQuery(normalizedQuery);
    if (tokens.length === 0 || typeof this.vault.getMarkdownFiles !== "function") {
      return {
        query: normalizedQuery,
        results: []
      };
    }

    const files = this.vault.getMarkdownFiles()
      .filter((file) => file?.extension === "md" && typeof file.path === "string");
    const results = [];

    for (const file of files) {
      const path = file.path;
      const content = await this.readFile(file);
      const match = scoreSearchMatch(path, content, tokens, maxSnippetLength);
      if (match.score > 0) {
        results.push({
          path,
          score: match.score,
          snippet: match.snippet
        });
      }
    }

    results.sort((left, right) => (
      right.score - left.score || left.path.localeCompare(right.path)
    ));

    return {
      query: normalizedQuery,
      results: results.slice(0, maxResults)
    };
  }

  findMentionedMarkdownFile(text) {
    if (typeof text !== "string" || text.trim().length === 0) {
      return null;
    }

    if (typeof this.vault.getMarkdownFiles !== "function") {
      return null;
    }

    const normalizedText = normalizePathSeparators(text);
    const files = this.vault.getMarkdownFiles()
      .filter((file) => file?.extension === "md" && typeof file.path === "string")
      .sort((left, right) => right.path.length - left.path.length);

    return files.find((file) => normalizedText.includes(normalizePathSeparators(file.path))) ?? null;
  }

  getAbstractFileByPath(path) {
    const normalizedPath = normalizeVaultPath(path);
    return this.vault.getAbstractFileByPath?.(normalizedPath) ?? null;
  }

  resolveAudioPath(input) {
    return resolveVaultAudioPath(this.app, input);
  }

  async readAudioBinary(file) {
    if (!file || typeof file.path !== "string" || typeof this.vault.readBinary !== "function") {
      throw new Error("The vault audio file could not be read.");
    }
    return this.vault.readBinary(file);
  }

  getFolderByPath(path) {
    const normalizedPath = normalizeVaultPath(path);
    if (!normalizedPath) {
      return this.vault.getRoot?.() ?? null;
    }

    const abstractFile = this.getAbstractFileByPath(normalizedPath);
    return abstractFile?.children ? abstractFile : null;
  }

  getMarkdownFiles() {
    return typeof this.vault.getMarkdownFiles === "function"
      ? this.vault.getMarkdownFiles().filter((file) => file?.extension === "md" && typeof file.path === "string")
      : [];
  }

  getAllVaultFiles() {
    if (typeof this.vault.getFiles === "function") {
      return this.vault.getFiles().filter((file) => typeof file?.path === "string");
    }

    return this.getMarkdownFiles();
  }

  deriveVaultEntriesFromFiles(path) {
    const normalizedPath = normalizeVaultPath(path);
    const prefix = normalizedPath ? `${normalizedPath}/` : "";
    const entriesByPath = new Map();

    for (const file of this.getAllVaultFiles()) {
      if (prefix && !file.path.startsWith(prefix)) {
        continue;
      }

      const rest = prefix ? file.path.slice(prefix.length) : file.path;
      if (!rest || rest.startsWith("/")) {
        continue;
      }

      const separatorIndex = rest.indexOf("/");
      if (separatorIndex >= 0) {
        const name = rest.slice(0, separatorIndex);
        const entryPath = prefix ? `${prefix}${name}` : name;
        entriesByPath.set(entryPath, {
          name,
          path: entryPath,
          type: "folder",
          extension: ""
        });
        continue;
      }

      entriesByPath.set(file.path, createVaultEntry(file));
    }

    return [...entriesByPath.values()].filter(Boolean).sort(sortVaultEntries);
  }
}

function normalizePathSeparators(value) {
  return value.replaceAll("\\", "/");
}

function normalizeVaultPath(value) {
  return normalizePathSeparators(String(value ?? "").trim()).replace(/^\/+|\/+$/g, "");
}

function createVaultEntry(item) {
  if (!item || typeof item.path !== "string") {
    return null;
  }

  const hasChildren = Array.isArray(item.children);
  const extension = item.extension ?? (hasChildren ? "" : getFileExtension(item.path));
  return {
    name: item.name ?? getFileName(item.path),
    path: normalizeVaultPath(item.path),
    type: hasChildren ? "folder" : "file",
    extension
  };
}

function sortVaultEntries(left, right) {
  if (left.type !== right.type) {
    return left.type === "folder" ? -1 : 1;
  }

  return left.path.localeCompare(right.path);
}

function getFileName(path) {
  return normalizePathSeparators(String(path ?? "")).split("/").filter(Boolean).pop() ?? "";
}

function getFileExtension(path) {
  const name = getFileName(path);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
}

function tokenizeSearchQuery(value) {
  return Array.from(new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  ));
}

function scoreSearchMatch(path, content, tokens, maxSnippetLength) {
  const normalizedPath = normalizePathSeparators(path).toLowerCase();
  const normalizedContent = String(content || "").toLowerCase();
  let score = 0;
  let firstContentIndex = -1;

  for (const token of tokens) {
    if (normalizedPath.includes(token)) {
      score += 8;
    }

    const contentIndex = normalizedContent.indexOf(token);
    if (contentIndex !== -1) {
      score += 3;
      if (firstContentIndex === -1 || contentIndex < firstContentIndex) {
        firstContentIndex = contentIndex;
      }
    }
  }

  return {
    score,
    snippet: createSearchSnippet(content, firstContentIndex, maxSnippetLength)
  };
}

function createSearchSnippet(content, matchIndex, maxLength) {
  const value = String(content || "");
  if (!value.trim()) {
    return "";
  }

  if (matchIndex === -1) {
    return normalizeSnippetText(value).slice(0, maxLength);
  }

  const start = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const end = Math.min(value.length, start + maxLength);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < value.length ? " ..." : "";
  return `${prefix}${normalizeSnippetText(value.slice(start, end))}${suffix}`;
}

function normalizeSnippetText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseMarkdownHeadings(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (!match) {
        return null;
      }

      return {
        heading: match[2],
        level: match[1].length,
        line: index
      };
    })
    .filter(Boolean);
}

function parseFrontmatterKeys(content) {
  return Object.keys(parseSimpleFrontmatter(content)).sort();
}

function parseSimpleFrontmatter(content) {
  const text = String(content ?? "");
  if (!text.startsWith("---")) {
    return {};
  }

  const endMatch = /\r?\n---\r?\n/.exec(text.slice(3));
  if (!endMatch) {
    return {};
  }

  const frontmatterText = text.slice(3, 3 + endMatch.index).trim();
  const frontmatter = {};
  for (const line of frontmatterText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (key) {
      frontmatter[key] = parseFrontmatterScalar(rawValue);
    }
  }

  return frontmatter;
}

function parseFrontmatterScalar(value) {
  if (!value) {
    return "";
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return value.replace(/^["']|["']$/g, "");
}

function extractTagsFromCache(cache, frontmatter = cache?.frontmatter) {
  const tags = new Set();
  for (const item of Array.isArray(cache?.tags) ? cache.tags : []) {
    if (typeof item?.tag === "string" && item.tag.trim()) {
      tags.add(item.tag.trim());
    }
  }

  const frontmatterTags = frontmatter?.tags;
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      const normalized = normalizeTag(tag);
      if (normalized) {
        tags.add(normalized);
      }
    }
  } else {
    const normalized = normalizeTag(frontmatterTags);
    if (normalized) {
      tags.add(normalized);
    }
  }

  return tags;
}

function normalizeTag(value) {
  const tag = String(value ?? "").trim();
  if (!tag) {
    return "";
  }

  return tag.startsWith("#") ? tag : `#${tag}`;
}

function sortTags(left, right) {
  return right.count - left.count || left.tag.localeCompare(right.tag);
}

function findMarkdownSection(content, headingReference) {
  const target = normalizeMarkdownHeadingText(headingReference);
  if (!target) {
    return null;
  }

  const lines = getMarkdownLines(content);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseMarkdownHeadingLine(lines[index].text);
    if (!heading || normalizeMarkdownHeadingText(heading.text) !== target) {
      continue;
    }

    let endLine = lines.length - 1;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextHeading = parseMarkdownHeadingLine(lines[nextIndex].text);
      if (nextHeading && nextHeading.level <= heading.level) {
        endLine = Math.max(index, nextIndex - 1);
        break;
      }
    }

    const sectionContent = lines.slice(index, endLine + 1).map((line) => line.text).join("").trimEnd();
    matches.push({
      content: sectionContent,
      startLine: index,
      endLine
    });
  }

  return matches.length === 1 ? matches[0] : null;
}

function getMarkdownLines(content) {
  const text = String(content ?? "");
  if (!text) {
    return [];
  }

  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    lines.push({
      text: text.slice(start, end)
    });

    if (newlineIndex === -1) {
      break;
    }

    start = end;
  }

  return lines;
}

function parseMarkdownHeadingLine(line) {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(String(line ?? "").trimEnd());
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2].replace(/\s+#+$/, "").trim()
  };
}

function normalizeMarkdownHeadingText(value) {
  return String(value ?? "")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeBlockId(value) {
  return String(value ?? "").trim().replace(/^\^+/, "");
}

function expandMarkdownParagraphRange(lines, lineIndex) {
  let startLine = lineIndex;
  while (startLine > 0 && lines[startLine - 1].text.trim()) {
    startLine -= 1;
  }

  let endLine = lineIndex;
  while (endLine < lines.length - 1 && lines[endLine + 1].text.trim()) {
    endLine += 1;
  }

  return {
    startLine,
    endLine
  };
}

function normalizeSearchQueryFilters(query) {
  const source = query && typeof query === "object" ? query : {};
  return {
    text: String(source.text ?? source.query ?? "").trim(),
    pathPrefix: normalizeVaultPath(source.pathPrefix ?? source.path ?? ""),
    tags: normalizeTagFilters(source.tags),
    frontmatter: source.frontmatter && typeof source.frontmatter === "object" && !Array.isArray(source.frontmatter)
      ? { ...source.frontmatter }
      : {},
    frontmatterExists: Array.isArray(source.frontmatterExists)
      ? source.frontmatterExists.map((key) => String(key ?? "").trim()).filter(Boolean)
      : [],
    modifiedSince: normalizeSearchDateFilter(source.modifiedSince, "modifiedSince"),
    createdSince: normalizeSearchDateFilter(source.createdSince, "createdSince"),
    sortBy: normalizeSearchSortValue(
      source.sortBy,
      "sortBy",
      ["relevance", "modified", "created", "path"],
      "relevance"
    ),
    sortOrder: normalizeSearchSortValue(source.sortOrder, "sortOrder", ["desc", "asc"], "desc")
  };
}

function normalizeSearchDateFilter(value, label) {
  const date = String(value ?? "").trim();
  if (!date) {
    return "";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !isValidSearchDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new Error(`Structured search ${label} must use a valid YYYY-MM-DD date.`);
  }

  return date;
}

function isValidSearchDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeSearchSortValue(value, label, allowedValues, fallback) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return fallback;
  }
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Structured search ${label} must be one of: ${allowedValues.join(", ")}.`);
  }
  return normalized;
}

function normalizeTagFilters(value) {
  const tags = Array.isArray(value) ? value : (value ? [value] : []);
  return tags.map(normalizeTag).filter(Boolean);
}

function matchStructuredSearch(path, content, frontmatter, tags, stat, filters, maxSnippetLength) {
  const matches = [];
  let score = 0;
  const normalizedPath = normalizeVaultPath(path);

  if (filters.pathPrefix) {
    if (!vaultPathMatchesPrefix(normalizedPath, filters.pathPrefix)) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += 4;
    matches.push("pathPrefix");
  }

  if (filters.tags.length > 0) {
    const noteTags = new Set(Array.from(tags ?? []).map(normalizeTag));
    const missingTag = filters.tags.find((tag) => !noteTags.has(tag));
    if (missingTag) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += filters.tags.length * 5;
    matches.push("tags");
  }

  for (const key of filters.frontmatterExists) {
    if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += 3;
    matches.push(`frontmatter:${key}`);
  }

  for (const [key, expected] of Object.entries(filters.frontmatter)) {
    if (!frontmatterValueMatches(frontmatter[key], expected)) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += 5;
    matches.push(`frontmatter:${key}`);
  }

  if (filters.modifiedSince) {
    if (stat.mtime < getLocalDateStart(filters.modifiedSince)) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += 2;
    matches.push("modifiedSince");
  }

  if (filters.createdSince) {
    if (stat.ctime < getLocalDateStart(filters.createdSince)) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += 2;
    matches.push("createdSince");
  }

  if (filters.text) {
    const textMatch = scoreSearchMatch(path, content, tokenizeSearchQuery(filters.text), maxSnippetLength);
    if (textMatch.score <= 0) {
      return { matched: false, score: 0, snippet: "", matches: [] };
    }
    score += textMatch.score;
    matches.push("text");
    return {
      matched: true,
      score,
      snippet: textMatch.snippet,
      matches
    };
  }

  if (matches.length === 0 && filters.sortBy === "relevance") {
    return { matched: false, score: 0, snippet: "", matches: [] };
  }

  return {
    matched: true,
    score,
    snippet: "",
    matches
  };
}

function normalizeFileStat(stat) {
  return {
    mtime: normalizeStatNumber(stat?.mtime),
    ctime: normalizeStatNumber(stat?.ctime),
    size: normalizeStatNumber(stat?.size)
  };
}

function normalizeStatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function getLocalDateStart(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date.getTime();
}

function compareStructuredSearchResults(left, right, filters) {
  let comparison;
  if (filters.sortBy === "modified") {
    comparison = left.mtime - right.mtime;
  } else if (filters.sortBy === "created") {
    comparison = left.ctime - right.ctime;
  } else if (filters.sortBy === "path") {
    comparison = left.path.localeCompare(right.path);
  } else {
    comparison = left.score - right.score;
  }

  if (comparison !== 0) {
    return filters.sortOrder === "asc" ? comparison : -comparison;
  }

  return left.path.localeCompare(right.path);
}

function vaultPathMatchesPrefix(path, prefix) {
  const normalizedPath = normalizeVaultPath(path).toLowerCase();
  const normalizedPrefix = normalizeVaultPath(prefix).toLowerCase();
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function frontmatterValueMatches(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.every((item) => frontmatterValueMatches(actual, item));
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => frontmatterValueMatches(item, expected));
  }

  return normalizeComparableValue(actual) === normalizeComparableValue(expected);
}

function normalizeComparableValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function createLinkEntry(link, sourcePath, metadataCache) {
  const rawLink = typeof link?.link === "string" ? link.link.trim() : "";
  if (!rawLink) {
    return null;
  }

  const destination = metadataCache?.getFirstLinkpathDest?.(rawLink, sourcePath);
  return {
    link: rawLink,
    displayText: typeof link.displayText === "string" ? link.displayText : "",
    targetPath: destination?.path ?? "",
    line: link.position?.start?.line ?? null
  };
}

function collectBacklinks(targetPath, resolvedLinks) {
  if (!resolvedLinks || typeof resolvedLinks !== "object") {
    return [];
  }

  const backlinks = [];
  for (const [sourcePath, destinations] of Object.entries(resolvedLinks)) {
    if (!destinations || typeof destinations !== "object") {
      continue;
    }

    if (Number(destinations[targetPath] ?? 0) > 0) {
      backlinks.push({
        path: sourcePath,
        count: Number(destinations[targetPath])
      });
    }
  }

  return backlinks.sort((left, right) => left.path.localeCompare(right.path));
}

function collectUnresolvedLinks(sourcePath, outgoingLinks, unresolvedLinks) {
  const unresolvedFromCache = unresolvedLinks?.[sourcePath];
  if (unresolvedFromCache && typeof unresolvedFromCache === "object") {
    return Object.entries(unresolvedFromCache)
      .filter(([, count]) => Number(count) > 0)
      .map(([link, count]) => ({
        link,
        count: Number(count)
      }))
      .sort((left, right) => left.link.localeCompare(right.link));
  }

  return outgoingLinks
    .filter((link) => !link.targetPath)
    .map((link) => ({
      link: link.link,
      count: 1
    }))
    .sort((left, right) => left.link.localeCompare(right.link));
}

function parseIsoDateOrToday(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return new Date();
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new Error("Date must use YYYY-MM-DD format.");
  }

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    throw new Error("Date must be a valid YYYY-MM-DD date.");
  }

  return date;
}

function getDefaultPeriodicDateFormat(period) {
  if (period === "weekly") {
    return "YYYY-[W]WW";
  }

  if (period === "monthly") {
    return "YYYY-MM";
  }

  if (period === "quarterly") {
    return "YYYY-[Q]Q";
  }

  if (period === "yearly") {
    return "YYYY";
  }

  return "YYYY-MM-DD";
}

function formatPeriodicDate(format, date, period) {
  const values = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    D: String(date.getDate()),
    WW: pad2(getIsoWeekNumber(date)),
    W: String(getIsoWeekNumber(date)),
    Q: String(Math.floor(date.getMonth() / 3) + 1)
  };

  return String(format || getDefaultPeriodicDateFormat(period))
    .replace(/\[([^\]]+)]/g, "$1")
    .replace(/YYYY|YY|WW|MM|DD|W|M|D|Q/g, (token) => values[token] ?? token);
}

function getIsoWeekNumber(date) {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  return Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
}

function formatDatePart(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join("-");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  VaultReader
};
