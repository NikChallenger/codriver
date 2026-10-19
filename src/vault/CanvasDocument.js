const MAX_CANVAS_CHARACTERS = 262144;
const MAX_CANVAS_NODES = 500;
const MAX_CANVAS_EDGES = 1000;
const MAX_CANVAS_DEPTH = 32;
const MAX_CANVAS_VALUES = 32768;
const SIDES = new Set(["top", "right", "bottom", "left"]);
const ENDS = new Set(["none", "arrow"]);
const TYPES = new Set(["text", "file", "link", "group"]);

class CanvasValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanvasValidationError";
  }
}

// Validate without serializing: textual operations must retain the original bytes.
function validateCanvasDocument(content) {
  if (typeof content !== "string" || content.length > MAX_CANVAS_CHARACTERS) {
    throw new CanvasValidationError("Canvas content must be text within the document size limit.");
  }
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    // JSON parser messages can expose document text; never propagate them.
    const match = /at position (\d+)/.exec(String(error?.message ?? ""));
    const offset = match ? Number(match[1]) : null;
    const location = Number.isSafeInteger(offset) && offset >= 0 && offset <= content.length
      ? ` Error near character ${offset + 1}.` : "";
    throw new CanvasValidationError(`Canvas content must be valid JSON.${location} Use one JSON object without Markdown fences, comments or trailing commas. Escape quotes and line breaks inside card text.`);
  }
  inspectCanvasJson(content);
  assertObject(document, "Canvas document");
  const nodes = readArray(document, "nodes", MAX_CANVAS_NODES);
  const edges = readArray(document, "edges", MAX_CANVAS_EDGES);
  const nodeIds = new Set();
  const edgeIds = new Set();
  for (const node of nodes) {
    assertObject(node, "Canvas node");
    registerId(node, nodeIds, "node");
    if (!TYPES.has(node.type)) throw new CanvasValidationError("Canvas node type is unsupported.");
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isSafeInteger(node[key]) || ((key === "width" || key === "height") && node[key] <= 0)) {
        throw new CanvasValidationError("Canvas node geometry requires safe integer coordinates and positive sizes.");
      }
    }
    validateColor(node);
    if (node.type === "text") assertString(node.text, "Canvas text", true);
    if (node.type === "file") {
      validateReferencePath(node.file);
      if (Object.hasOwn(node, "subpath")) {
        assertString(node.subpath, "Canvas subpath");
        if (!node.subpath.startsWith("#")) throw new CanvasValidationError("Canvas subpath must begin with #.");
      }
    }
    if (node.type === "link") {
      assertString(node.url, "Canvas URL");
      if (/[\u0000-\u001f\u007f]/.test(node.url)) throw new CanvasValidationError("Canvas URL contains unsafe characters.");
    }
    if (node.type === "group") {
      if (Object.hasOwn(node, "label")) assertString(node.label, "Canvas group label", true);
      if (Object.hasOwn(node, "background")) validateReferencePath(node.background);
      if (Object.hasOwn(node, "backgroundStyle") && !["cover", "ratio", "repeat"].includes(node.backgroundStyle)) {
        throw new CanvasValidationError("Canvas group background style is unsupported.");
      }
    }
  }
  for (const edge of edges) {
    assertObject(edge, "Canvas edge");
    registerId(edge, edgeIds, "edge");
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) {
      throw new CanvasValidationError("Canvas edge endpoints must reference existing nodes.");
    }
    for (const key of ["fromSide", "toSide"]) {
      if (Object.hasOwn(edge, key) && !SIDES.has(edge[key])) throw new CanvasValidationError("Canvas edge side is unsupported.");
    }
    for (const key of ["fromEnd", "toEnd"]) {
      if (Object.hasOwn(edge, key) && !ENDS.has(edge[key])) throw new CanvasValidationError("Canvas edge end is unsupported.");
    }
    if (Object.hasOwn(edge, "label")) assertString(edge.label, "Canvas edge label", true);
    validateColor(edge);
  }
  return { document, nodeCount: nodes.length, edgeCount: edges.length };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CanvasValidationError(`${label} must be an object.`);
}

function validateCanvasCreation(content) {
  const result = validateCanvasDocument(content);
  // Existing JSON Canvas files may omit either collection. New generated
  // files require explicit collections so unrelated JSON is not an empty graph.
  if (!Object.hasOwn(result.document, "nodes") || !Object.hasOwn(result.document, "edges")) {
    throw new CanvasValidationError("New Canvas content requires root nodes and edges arrays, using [] when empty. A content.blocks wrapper is not an Obsidian Canvas graph. Text cards belong in nodes with id, type, x, y, width, height and text.");
  }
  return result;
}

function readArray(document, key, maximum) {
  if (!Object.hasOwn(document, key)) return [];
  if (!Array.isArray(document[key]) || document[key].length > maximum) {
    throw new CanvasValidationError(`Canvas ${key} must be an array within the item limit.`);
  }
  return document[key];
}

function assertString(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.length)) throw new CanvasValidationError(`${label} must be a string${allowEmpty ? "" : " that is not empty"}.`);
}

function registerId(item, ids, label) {
  assertString(item.id, `Canvas ${label} ID`);
  if (item.id.length > 128 || /[\u0000-\u001f\u007f]/.test(item.id) || ids.has(item.id)) {
    throw new CanvasValidationError(`Canvas ${label} IDs must be unique bounded strings.`);
  }
  ids.add(item.id);
}

function validateColor(item) {
  if (Object.hasOwn(item, "color") && (typeof item.color !== "string" || !/^(?:[1-6]|#[0-9a-fA-F]{6})$/.test(item.color))) {
    throw new CanvasValidationError("Canvas colors must use a preset string 1 through 6 or a six-digit hex color.");
  }
}

function validateReferencePath(path) {
  assertString(path, "Canvas file reference");
  if (path.length > 1024 || path !== path.trim() || /[\\\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CanvasValidationError("Canvas file references must be normalized vault-relative paths.");
  }
}

// JSON.parse accepts repeated keys and loses unsafe numbers. Inspect the source
// after syntax validation so ambiguous documents cannot silently pass validation.
function inspectCanvasJson(content) {
  let cursor = 0;
  let values = 0;
  const skipSpace = () => { while (/\s/.test(content[cursor] ?? "")) cursor += 1; };
  const readString = () => {
    const start = cursor++;
    while (content[cursor] !== '"') {
      if (content[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    cursor += 1;
    return JSON.parse(content.slice(start, cursor));
  };
  const readValue = (depth) => {
    if (++values > MAX_CANVAS_VALUES || depth > MAX_CANVAS_DEPTH) throw new CanvasValidationError("Canvas JSON structure exceeds its limits.");
    skipSpace();
    const character = content[cursor];
    if (character === '"') { readString(); return; }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const end = object ? "}" : "]";
      const keys = new Set();
      cursor += 1;
      skipSpace();
      while (content[cursor] !== end) {
        if (object) {
          const key = readString();
          if (keys.has(key)) throw new CanvasValidationError("Canvas JSON objects must not contain duplicate keys.");
          keys.add(key);
          skipSpace();
          cursor += 1;
        }
        readValue(depth + 1);
        skipSpace();
        if (content[cursor] === ",") { cursor += 1; skipSpace(); } else break;
      }
      cursor += 1;
      return;
    }
    const start = cursor;
    while (cursor < content.length && !/[\s,}\]]/.test(content[cursor])) cursor += 1;
    const token = content.slice(start, cursor);
    if (/^-?\d/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
        throw new CanvasValidationError("Canvas JSON numbers must be finite and safely represented.");
      }
      if (normalizeDecimal(token) !== normalizeDecimal(String(number))) throw new CanvasValidationError("Canvas JSON numbers must not lose numeric precision.");
    }
  };
  readValue(0);
}

function normalizeDecimal(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  let digits = (match[2] + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  const withoutTrailing = digits.replace(/0+$/, "");
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0) + digits.length - withoutTrailing.length;
  if (!Number.isSafeInteger(exponent)) throw new CanvasValidationError("Canvas JSON numeric exponent exceeds its precision limit.");
  return `${match[1]}${withoutTrailing}e${exponent}`;
}

function equalJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

function canvasDocumentsEqual(left, right) {
  // Native Canvas serialization omits these defaults. Normalize only for
  // comparison; the proposed file text is never rewritten.
  const comparable = (content) => {
    const document = validateCanvasDocument(content).document;
    document.nodes ??= [];
    document.edges ??= [];
    for (const item of [...document.nodes, ...document.edges]) {
      if (item.color?.startsWith("#")) item.color = item.color.toLowerCase();
    }
    for (const node of document.nodes) {
      if (node.type !== "group") continue;
      if (node.label === "") delete node.label;
      if (node.backgroundStyle === "cover") delete node.backgroundStyle;
    }
    for (const edge of document.edges) {
      if (edge.fromEnd === "none") delete edge.fromEnd;
      if (edge.toEnd === "arrow") delete edge.toEnd;
      if (edge.label === "") delete edge.label;
    }
    return document;
  };
  return equalJson(comparable(left), comparable(right));
}

function assertCanvasPreservation(before, after) {
  const previous = validateCanvasDocument(before).document;
  const next = validateCanvasDocument(after).document;
  const preserveExtra = (old, updated, known) => {
    for (const key of Object.keys(old).filter((key) => !known.includes(key))) {
      if (!Object.hasOwn(updated, key) || !equalJson(old[key], updated[key])) throw new CanvasValidationError("Canvas patch must preserve existing extension fields.");
    }
  };
  preserveExtra(previous, next, ["nodes", "edges"]);
  for (const [key, known] of [
    ["nodes", ["id", "type", "x", "y", "width", "height", "color", "text", "file", "subpath", "url", "label", "background", "backgroundStyle"]],
    ["edges", ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"]]
  ]) {
    const byId = new Map((next[key] ?? []).map((item) => [item.id, item]));
    for (const item of previous[key] ?? []) {
      const updated = byId.get(item.id);
      if (updated) {
        const typeFields = { text: ["text"], file: ["file", "subpath"], link: ["url"], group: ["label", "background", "backgroundStyle"] };
        const applicable = key === "nodes" ? ["id", "type", "x", "y", "width", "height", "color", ...typeFields[item.type], ...typeFields[updated.type]] : known;
        preserveExtra(item, updated, applicable);
      }
    }
  }
}

module.exports = { CanvasValidationError, validateCanvasCreation, validateCanvasDocument, canvasDocumentsEqual, assertCanvasPreservation,
  MAX_CANVAS_CHARACTERS, MAX_CANVAS_NODES, MAX_CANVAS_EDGES };
