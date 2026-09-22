function resolveFetch(fetchImplementation) {
  if (typeof fetchImplementation === "function") {
    return fetchImplementation;
  }
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error("Streaming is unavailable in this Obsidian runtime.");
}

async function openStreamingResponse(request, options = {}) {
  const fetchImplementation = resolveFetch(options.fetch);
  return await fetchImplementation(request.url, {
    method: request.method || "GET",
    headers: request.headers,
    body: request.body,
    signal: request.signal
  });
}

async function consumeServerSentEvents(response, onEvent) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new Error("The provider returned a response without a readable event stream.");
  }
  if (typeof onEvent !== "function") {
    throw new Error("A streaming event handler is required.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let eventCount = 0;
  let firstLine = true;

  const dispatch = async () => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const event = {
      event: eventName || "message",
      data: dataLines.join("\n")
    };
    eventName = "";
    dataLines = [];
    eventCount += 1;
    await onEvent(event);
  };

  const processLine = async (line) => {
    let value = line;
    if (firstLine) {
      firstLine = false;
      value = value.replace(/^\uFEFF/, "");
    }
    if (value === "") {
      await dispatch();
      return;
    }
    if (value.startsWith(":")) {
      return;
    }
    const separator = value.indexOf(":");
    const field = separator === -1 ? value : value.slice(0, separator);
    let fieldValue = separator === -1 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) {
      fieldValue = fieldValue.slice(1);
    }
    if (field === "event") {
      eventName = fieldValue;
    } else if (field === "data") {
      dataLines.push(fieldValue);
    }
  };

  const drainLines = async (final = false) => {
    while (buffer.length > 0) {
      const boundary = findLineBoundary(buffer, final);
      if (!boundary) {
        break;
      }
      const line = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      await processLine(line);
    }
    if (final && buffer.length > 0) {
      const line = buffer;
      buffer = "";
      await processLine(line);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      await drainLines(false);
    }
    buffer += decoder.decode();
    await drainLines(true);
    await dispatch();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released its reader after cancellation.
    }
  }

  if (eventCount === 0) {
    throw new Error("The provider returned an empty event stream.");
  }
  return { eventCount };
}

function findLineBoundary(value, final) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") {
      return { index, length: 1 };
    }
    if (character === "\r") {
      if (index + 1 >= value.length && !final) {
        return null;
      }
      return {
        index,
        length: value[index + 1] === "\n" ? 2 : 1
      };
    }
  }
  return null;
}

async function readFetchResponse(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: Number.isInteger(response?.status) ? response.status : 0,
    headers: response?.headers,
    text,
    json
  };
}

function isSuccessfulResponse(response) {
  return Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
}

module.exports = {
  consumeServerSentEvents,
  isSuccessfulResponse,
  openStreamingResponse,
  readFetchResponse
};
