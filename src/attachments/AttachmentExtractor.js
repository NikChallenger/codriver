const { extractPdfText } = require("./PdfTextExtractor");

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "ini",
  "conf",
  "cfg",
  "env",
  "sql",
  "ps1",
  "sh",
  "bat",
  "cmd",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "scss",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "cs"
]);
const DOCUMENT_ATTACHMENT_EXTENSIONS = new Set(["docx"]);
const PDF_ATTACHMENT_EXTENSIONS = new Set(["pdf"]);
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg"
]);
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  ...TEXT_ATTACHMENT_EXTENSIONS,
  ...DOCUMENT_ATTACHMENT_EXTENSIONS,
  ...PDF_ATTACHMENT_EXTENSIONS,
  ...IMAGE_ATTACHMENT_EXTENSIONS
]);
const DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_TEXT_CHARS = 120000;

async function extractAttachmentText(file, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_ATTACHMENT_TEXT_CHARS;
  const metadata = getAttachmentFileMetadata(file);

  if (!metadata.name) {
    throw new Error("The selected file is missing a name.");
  }

  const isImage = isImageAttachment(metadata);
  if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(metadata.extension) && !isTextMimeType(metadata.mimeType) && !isImage) {
    throw new Error(`CoDriver cannot read .${metadata.extension || "unknown"} files yet.`);
  }

  if (metadata.size > maxBytes) {
    throw new Error(`The file is larger than ${formatBytes(maxBytes)}.`);
  }

  let extracted;
  if (isImage) {
    extracted = await extractImageAttachment(file, metadata);
  } else if (metadata.extension === "pdf") {
    extracted = await extractPdfAttachment(file);
  } else if (metadata.extension === "docx") {
    extracted = await extractDocxAttachment(file);
  } else {
    extracted = await extractTextAttachment(file);
  }

  const limited = limitExtractedText(extracted.text, maxTextChars);
  return {
    ...metadata,
    kind: extracted.kind ?? "text",
    text: limited.text,
    dataUrl: extracted.dataUrl ?? "",
    truncated: limited.truncated || Boolean(extracted.truncated),
    details: extracted.details ?? {}
  };
}

function getAttachmentFileMetadata(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  return {
    name,
    extension: getFileExtension(name),
    size: typeof file?.size === "number" ? file.size : 0,
    mimeType: typeof file?.type === "string" ? file.type : ""
  };
}

async function extractTextAttachment(file) {
  const text = await readTextFile(file);
  return {
    kind: "text",
    text: normalizeExtractedText(text),
    details: {
      format: "text"
    }
  };
}

async function extractDocxAttachment(file) {
  const buffer = await readArrayBuffer(file);
  const zipEntries = await readZipEntries(buffer);
  const documentParts = [
    "word/document.xml",
    ...Array.from(zipEntries.keys())
      .filter((name) => /^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/i.test(name))
      .sort()
  ];
  const textParts = [];

  for (const partPath of documentParts) {
    const bytes = zipEntries.get(partPath);
    if (!bytes) {
      continue;
    }

    const xml = decodeUtf8(bytes);
    const text = extractWordXmlText(xml);
    if (text) {
      textParts.push(text);
    }
  }

  if (textParts.length === 0) {
    throw new Error("No readable document text was found in the DOCX file.");
  }

  return {
    kind: "text",
    text: normalizeExtractedText(textParts.join("\n\n")),
    details: {
      format: "docx"
    }
  };
}

async function extractPdfAttachment(file) {
  const buffer = await readArrayBuffer(file);
  const result = await extractPdfText(buffer);
  return {
    kind: "text",
    text: normalizeExtractedText(result.text),
    details: {
      format: "pdf",
      pageCount: result.totalPages
    }
  };
}

async function extractImageAttachment(file, metadata) {
  const buffer = await readArrayBuffer(file);
  const mimeType = metadata.mimeType || getImageMimeType(metadata.extension) || "application/octet-stream";
  return {
    kind: "image",
    text: "",
    dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`,
    details: {
      format: "image",
      mimeType
    }
  };
}

async function readTextFile(file) {
  if (typeof file?.text === "function") {
    return file.text();
  }

  return decodeUtf8(new Uint8Array(await readArrayBuffer(file)));
}

async function readArrayBuffer(file) {
  if (typeof file?.arrayBuffer !== "function") {
    throw new Error("The selected file could not be read.");
  }

  return file.arrayBuffer();
}

async function readZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (totalEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 DOCX files are not supported yet.");
  }

  const entries = new Map();
  let offset = centralDirectoryOffset;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The DOCX file has an invalid ZIP directory.");
    }

    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const fileNameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength);
    const fileName = decodeUtf8(fileNameBytes);

    if ((flags & 1) !== 0) {
      throw new Error("Encrypted DOCX files are not supported.");
    }

    entries.set(fileName, await readZipEntryBytes(bytes, view, localHeaderOffset, compressedSize, compressionMethod));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

async function readZipEntryBytes(bytes, view, localHeaderOffset, compressedSize, compressionMethod) {
  if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
    throw new Error("The DOCX file has an invalid ZIP entry.");
  }

  const fileNameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressedBytes = bytes.slice(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    return compressedBytes;
  }

  if (compressionMethod === 8) {
    return inflateRawBytes(compressedBytes);
  }

  throw new Error(`Unsupported DOCX compression method ${compressionMethod}.`);
}

async function inflateRawBytes(bytes) {
  if (typeof DecompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") {
    throw new Error("This Obsidian runtime cannot decompress DOCX files.");
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }

  throw new Error("The DOCX file has an invalid ZIP footer.");
}

function extractWordXmlText(xml) {
  const tokens = [];
  const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>/gi;
  let match;

  while ((match = pattern.exec(xml)) !== null) {
    if (typeof match[1] === "string") {
      tokens.push(decodeXmlEntities(match[1]));
      continue;
    }

    if (match[0].startsWith("</w:tc")) {
      tokens.push("\t");
    } else {
      tokens.push("\n");
    }
  }

  return tokens.join("");
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function limitExtractedText(text, maxTextChars) {
  const normalized = normalizeExtractedText(text);
  if (!Number.isFinite(maxTextChars) || normalized.length <= maxTextChars) {
    return {
      text: normalized,
      truncated: false
    };
  }

  return {
    text: normalized.slice(0, maxTextChars).trimEnd(),
    truncated: true
  };
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function isTextMimeType(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("text/");
}

function isImageMimeType(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/");
}

function isImageAttachment(metadata) {
  return IMAGE_ATTACHMENT_EXTENSIONS.has(metadata.extension) || isImageMimeType(metadata.mimeType);
}

function getImageMimeType(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return "image/jpeg";
  }

  if (normalized === "svg") {
    return "image/svg+xml";
  }

  return IMAGE_ATTACHMENT_EXTENSIONS.has(normalized) ? `image/${normalized}` : "";
}

function getFileExtension(name) {
  const match = /\.([^.\\/\s]+)$/.exec(String(name || "").toLowerCase());
  return match ? match[1] : "";
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 bytes";
  }

  const units = ["bytes", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const rounded = unitIndex === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

module.exports = {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENT_TEXT_CHARS,
  SUPPORTED_ATTACHMENT_EXTENSIONS,
  extractAttachmentText,
  formatBytes,
  getAttachmentFileMetadata
};
