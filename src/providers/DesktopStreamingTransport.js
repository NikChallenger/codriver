function createDesktopChatUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!/^https?:\/\//i.test(baseUrl) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("Use a complete HTTP(S) provider endpoint without credentials or a fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

function openDesktopStreamingResponse(url, { method, headers, body, signal }) {
  let request;
  let toWeb;
  try {
    const transport = url.protocol === "https:" ? require("https") : require("http");
    request = transport.request;
    toWeb = require("stream").Readable.toWeb;
  } catch {
    throw new Error("Enable CORS streaming requires Node HTTP support in Obsidian Desktop.");
  }
  if (typeof request !== "function" || typeof toWeb !== "function") {
    throw new Error("Enable CORS streaming requires Node HTTP support in Obsidian Desktop.");
  }

  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const failConnection = () => reject(signal?.aborted
      ? signal.reason
      : new Error("Could not connect to the provider using Enable CORS. Check the endpoint and network."));
    try {
      const outgoing = request(url.href, {
        method,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        headers: {
          ...headers,
          "Accept-Encoding": "identity",
          "Content-Length": new TextEncoder().encode(body).byteLength
        },
        signal
      }, (incoming) => {
        const status = incoming.statusCode;
        if (status < 200 || status >= 300) {
          incoming.destroy();
          resolve({ status });
          return;
        }

        const encoding = String(incoming.headers["content-encoding"] ?? "").trim().toLowerCase();
        if (encoding && encoding !== "identity") {
          incoming.destroy();
          reject(new Error("The provider sent a compressed stream. Enable CORS on desktop requires an uncompressed event stream."));
          return;
        }
        try {
          const stream = toWeb(incoming, {
            strategy: { highWaterMark: incoming.readableHighWaterMark, size: (chunk) => chunk.byteLength }
          });
          resolve({
            status,
            body: {
              getReader() {
                const reader = stream.getReader();
                return {
                  async read() {
                    try {
                      return await reader.read();
                    } catch {
                      if (signal?.aborted) throw signal.reason;
                      throw new Error("The provider connection closed before the stream completed.");
                    }
                  },
                  releaseLock: () => reader.releaseLock()
                };
              }
            },
            close: () => incoming.destroy()
          });
        } catch {
          incoming.destroy();
          reject(new Error("Obsidian Desktop could not open the provider event stream."));
        }
      });
      outgoing.on("error", failConnection);
      outgoing.end(body);
    } catch {
      failConnection();
    }
  });
}

module.exports = { createDesktopChatUrl, openDesktopStreamingResponse };
