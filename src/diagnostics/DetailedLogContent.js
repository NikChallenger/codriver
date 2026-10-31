const ARGUMENT_BYTES = 32 * 1024;
const CONTENT_BYTES = 64 * 1024;
const RECORD_BYTES = 96 * 1024;
const encoder = new TextEncoder();
const SENSITIVE_KEY = /(?:api.?key|authorization|password|secret|token|cookie|credential|headers|reasoning|thinking|thought|signature|audio|base64|binary|blob|image|attachment|transcript)/i;

function byteLength(text) {
  return encoder.encode(text).length;
}

// Work only on a bounded prefix, including before credential replacement.
function prefixBytes(text, maximum) {
  const prefix = text.slice(0, maximum + 2);
  const bytes = encoder.encode(prefix);
  if (bytes.length <= maximum) return new TextDecoder().decode(bytes);
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function createContentRedactor() {
  let secrets = [];
  let blocked = false;
  return {
    add(value) {
      if (typeof value !== "string" || !value) return;
      if (value.length > 32768 || byteLength(value) > 32768 || secrets.length >= 64) {
        blocked = true;
        return;
      }
      for (const candidate of [value, value.replace(/^Bearer\s+/i, "")]) {
        if (candidate && !secrets.includes(candidate)) secrets.push(candidate);
      }
      secrets.sort((a, b) => b.length - a.length);
    },
    text(value, maximum) {
      if (blocked) return prefixBytes("[Content omitted: credential redaction limit]", maximum);
      // Include overlap so a credential crossing the output boundary is redacted.
      let text = prefixBytes(value, maximum + 32768);
      for (const secret of secrets) text = prefixBytes(text.split(secret).join("[REDACTED]"), maximum + 32768);
      text = text.replace(/data:[^;,\s]{1,120};base64,[A-Za-z0-9+/=\r\n]+/gi, "[Binary data omitted]")
        .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[Encoded payload omitted]");
      return prefixBytes(text, maximum);
    },
    clear() { secrets = []; blocked = false; }
  };
}

function serializeContent(value, maximum = CONTENT_BYTES, redactor = createContentRedactor()) {
  let remaining = maximum;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet();
  function text(value) {
    const result = redactor.text(value, Math.max(0, remaining));
    if (result.length < value.length) truncated = true;
    remaining -= byteLength(result);
    return result;
  }
  function visit(item, depth) {
    if (++nodes > 2000 || remaining <= 0 || depth > 6) {
      truncated = true;
      return "[OMITTED: limit]";
    }
    if (typeof item === "string") return text(item);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : "[Non-finite number]";
    if (typeof item !== "object") return "[Unsupported value]";
    try {
      if (seen.has(item)) return "[Circular reference]";
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return "[Native object omitted]";
      const type = Object.getOwnPropertyDescriptor(item, "type")?.value;
      const mimeType = Object.getOwnPropertyDescriptor(item, "mimeType")?.value;
      if (["image", "audio", "input_audio", "image_url", "file", "blob", "buffer"].includes(type) ||
          (typeof mimeType === "string" && !isTextMime(mimeType))) return "[Non-text content omitted]";
      seen.add(item);
      const result = Array.isArray(item) ? [] : Object.create(null);
      let count = 0;
      // Do not materialize an unbounded key array or invoke accessors/toJSON.
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (++count > 200 || nodes >= 2000 || remaining <= 0) {
          truncated = true;
          if (Array.isArray(result)) result.push("[OMITTED: limit]");
          else result.__omitted = "[OMITTED: limit]";
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        const safeKey = text(key);
        const projected = SENSITIVE_KEY.test(key) ? "[REDACTED]"
          : !descriptor || !("value" in descriptor) ? "[Accessor omitted]"
          : visit(descriptor.value, depth + 1);
        if (Array.isArray(result)) result.push(projected);
        else result[safeKey] = projected;
      }
      return result;
    } catch {
      return "[Unserializable object omitted]";
    }
  }
  let content = visit(value, 0);
  // JSON escaping and structural overhead have their own bounded budget.
  const serialized = JSON.stringify(content);
  if (byteLength(serialized) > maximum) {
    content = prefixBytes(serialized, maximum - 128);
    truncated = true;
  }
  return { content, truncated, retainedBytes: byteLength(typeof content === "string" ? content : JSON.stringify(content)),
    ...(typeof value === "string" ? { originalCharacters: value.length } : {}),
    ...(truncated ? { marker: "[TRUNCATED: detailed log limit]" } : {}) };
}

function projectToolResult(result) {
  // Results are opaque data. Traverse only text/JSON, never binary resource bodies.
  if (!result || typeof result !== "object") return result;
  const projected = [];
  const items = Object.getOwnPropertyDescriptor(result, "content")?.value;
  if (Array.isArray(items)) {
    for (let index = 0; index < Math.min(items.length, 200); index += 1) {
      const item = Object.getOwnPropertyDescriptor(items, String(index))?.value;
      if (!item || typeof item !== "object") continue;
      const type = Object.getOwnPropertyDescriptor(item, "type")?.value;
      const text = Object.getOwnPropertyDescriptor(item, "text")?.value;
      if (type === "text" && typeof text === "string") projected.push(text);
      else if (type === "resource") {
        const resource = Object.getOwnPropertyDescriptor(item, "resource")?.value;
        const resourceText = resource && Object.getOwnPropertyDescriptor(resource, "text")?.value;
        const mimeType = resource && Object.getOwnPropertyDescriptor(resource, "mimeType")?.value;
        if (typeof resourceText === "string" && (mimeType === undefined || isTextMime(mimeType))) projected.push(resourceText);
        else projected.push("[Non-text resource omitted]");
      } else projected.push("[Non-text content omitted]");
    }
    if (items.length > 200) projected.push("[OMITTED: item limit]");
  }
  const structured = Object.getOwnPropertyDescriptor(result, "structuredContent")?.value;
  if (structured !== undefined) projected.push(structured);
  return projected;
}

function isTextMime(value) {
  return typeof value === "string" && /^(?:text\/|application\/(?:json|xml)(?:;|$)|application\/[^;]+\+(?:json|xml)(?:;|$))/i.test(value);
}

module.exports = { ARGUMENT_BYTES, CONTENT_BYTES, RECORD_BYTES, byteLength, prefixBytes,
  createContentRedactor, serializeContent, projectToolResult };
