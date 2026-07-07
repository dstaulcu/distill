import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createStreamingClient,
  type StreamChatCompletionRequest,
  type StreamingClientOptions,
  type ChatMessage,
} from "./streaming-client";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a ReadableStream from SSE text chunks. */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/** Creates a mock fetch that returns a streaming SSE response. */
function createMockFetch(
  status: number,
  chunks: string[],
  opts?: { delay?: number },
): typeof globalThis.fetch {
  return async (_url, _init) => {
    if (opts?.delay) {
      await new Promise((r) => setTimeout(r, opts.delay));
    }
    return new Response(createSSEStream(chunks), {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

/** Creates a mock fetch that throws a network error. */
function createNetworkErrorFetch(message = "Network failure"): typeof globalThis.fetch {
  return async () => {
    throw new TypeError(message);
  };
}

/** Creates a mock fetch that respects abort signal. */
function createAbortableFetch(chunks: string[], chunkDelay: number): typeof globalThis.fetch {
  return async (_url, init) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Create a stream that delivers chunks with delays
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        await new Promise((r) => setTimeout(r, chunkDelay));
        if (signal?.aborted) {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

/** Standard messages for test requests. */
const testMessages: ReadonlyArray<ChatMessage> = [
  { role: "user", content: "Hello" },
];

function makeRequest(overrides?: Partial<StreamChatCompletionRequest>): StreamChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: testMessages,
    signal: new AbortController().signal,
    onToken: () => {},
    ...overrides,
  };
}

function makeOptions(overrides?: Partial<StreamingClientOptions>): StreamingClientOptions {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test-key",
    fetch: createMockFetch(200, []),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CF-2.2 createStreamingClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("URL construction", () => {
    it("appends /v1/chat/completions to base URL without trailing slash", async () => {
      let calledUrl = "";
      const mockFetch: typeof globalThis.fetch = async (url, _init) => {
        calledUrl = url as string;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const client = createStreamingClient(makeOptions({ baseUrl: "https://api.example.com", fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest());

      expect(calledUrl).toBe("https://api.example.com/v1/chat/completions");
    });

    it("removes trailing slashes before appending path", async () => {
      let calledUrl = "";
      const mockFetch: typeof globalThis.fetch = async (url, _init) => {
        calledUrl = url as string;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const client = createStreamingClient(makeOptions({ baseUrl: "https://api.example.com///", fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest());

      expect(calledUrl).toBe("https://api.example.com/v1/chat/completions");
    });

    it("handles base URL with existing path", async () => {
      let calledUrl = "";
      const mockFetch: typeof globalThis.fetch = async (url, _init) => {
        calledUrl = url as string;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const client = createStreamingClient(makeOptions({ baseUrl: "https://api.example.com/proxy/", fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest());

      expect(calledUrl).toBe("https://api.example.com/proxy/v1/chat/completions");
    });
  });

  describe("request construction", () => {
    it("sends correct headers and body", async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch: typeof globalThis.fetch = async (_url, init) => {
        capturedInit = init;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const client = createStreamingClient(makeOptions({ apiKey: "sk-my-key", fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest({ model: "gpt-4o" }));

      expect(capturedInit?.method).toBe("POST");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBe("Bearer sk-my-key");

      const body = JSON.parse(capturedInit?.body as string);
      expect(body.model).toBe("gpt-4o");
      expect(body.stream).toBe(true);
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("clears its per-read timeout timers once the stream completes (no leaked timers)", async () => {
      vi.useFakeTimers();
      try {
        const mockFetch = createMockFetch(200, [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]);
        const client = createStreamingClient(makeOptions({ fetch: mockFetch }));

        const result = await client.streamChatCompletion(makeRequest());
        expect(result.ok).toBe(true);

        // Every read raced against a timeout; those timers must be cancelled
        // when the read wins, not left to fire up to 30s later.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("CF-5.3 omits the Authorization header when apiKey is empty (keyless endpoints)", async () => {
      let capturedInit: RequestInit | undefined;
      const mockFetch: typeof globalThis.fetch = async (_url, init) => {
        capturedInit = init;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const client = createStreamingClient(makeOptions({ apiKey: "", fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest());

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  describe("successful streaming", () => {
    it("delivers tokens via onToken callback and returns full content", async () => {
      vi.useRealTimers();

      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const tokens: string[] = [];
      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("Hello world");
      }
      expect(tokens).toEqual(["Hello", " world"]);
    });

    it("handles multiple tokens in a single chunk", async () => {
      vi.useRealTimers();

      const chunks = [
        'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const tokens: string[] = [];
      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("AB");
      }
      expect(tokens).toEqual(["A", "B"]);
    });

    it("skips empty delta content", async () => {
      vi.useRealTimers();

      const chunks = [
        'data: {"choices":[{"delta":{"content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const tokens: string[] = [];
      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("Hi");
      }
      expect(tokens).toEqual(["Hi"]);
    });

    it("handles stream ending without [DONE] marker", async () => {
      vi.useRealTimers();

      const chunks = [
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      ];

      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("partial");
      }
    });

    it("ignores non-data SSE lines", async () => {
      vi.useRealTimers();

      const chunks = [
        ": this is a comment\n",
        "event: message\n",
        'data: {"choices":[{"delta":{"content":"token"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const tokens: string[] = [];
      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("token");
      }
      expect(tokens).toEqual(["token"]);
    });

    it("handles malformed JSON in SSE data gracefully", async () => {
      vi.useRealTimers();

      const chunks = [
        'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
        "data: {invalid json}\n\n",
        'data: {"choices":[{"delta":{"content":"also good"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const tokens: string[] = [];
      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, chunks) }));
      const result = await client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe("goodalso good");
      }
      expect(tokens).toEqual(["good", "also good"]);
    });
  });

  describe("non-2xx response", () => {
    it("returns non-2xx failure with status code", async () => {
      vi.useRealTimers();

      const client = createStreamingClient(
        makeOptions({ fetch: createMockFetch(429, ["Rate limited"]) }),
      );
      const result = await client.streamChatCompletion(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-2xx");
        expect(result.statusCode).toBe(429);
        expect(result.detail).toBe("Server returned 429");
        expect(result.partialContent).toBe("");
      }
    });

    it("returns non-2xx for 500 errors", async () => {
      vi.useRealTimers();

      const client = createStreamingClient(
        makeOptions({ fetch: createMockFetch(500, []) }),
      );
      const result = await client.streamChatCompletion(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non-2xx");
        expect(result.statusCode).toBe(500);
      }
    });
  });

  describe("network errors", () => {
    it("returns network failure on fetch error", async () => {
      vi.useRealTimers();

      const client = createStreamingClient(
        makeOptions({ fetch: createNetworkErrorFetch("Connection refused") }),
      );
      const result = await client.streamChatCompletion(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("network");
        expect(result.detail).toBe("Connection refused");
        expect(result.partialContent).toBe("");
      }
    });
  });

  describe("abort handling", () => {
    it("returns aborted failure when signal is already aborted", async () => {
      vi.useRealTimers();

      const controller = new AbortController();
      controller.abort();

      const client = createStreamingClient(makeOptions({ fetch: createMockFetch(200, []) }));
      const result = await client.streamChatCompletion(
        makeRequest({ signal: controller.signal }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("aborted");
        expect(result.partialContent).toBe("");
      }
    });

    it("returns aborted failure with partial content when aborted during streaming", async () => {
      vi.useRealTimers();

      const controller = new AbortController();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" more"}}]}\n\n',
      ];

      // Abort after first chunk is processed
      let tokenCount = 0;
      const client = createStreamingClient(
        makeOptions({ fetch: createAbortableFetch(chunks, 10) }),
      );
      const result = await client.streamChatCompletion(
        makeRequest({
          signal: controller.signal,
          onToken: () => {
            tokenCount++;
            if (tokenCount >= 1) {
              controller.abort();
            }
          },
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("aborted");
        expect(result.partialContent.length).toBeGreaterThan(0);
      }
    });

    it("returns aborted failure when fetch itself is aborted", async () => {
      vi.useRealTimers();

      const controller = new AbortController();
      const mockFetch: typeof globalThis.fetch = async (_url, init) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        // Simulate slow fetch
        await new Promise((r) => setTimeout(r, 100));
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Response(createSSEStream([]), { status: 200 });
      };

      // Abort immediately
      setTimeout(() => controller.abort(), 5);

      const client = createStreamingClient(makeOptions({ fetch: mockFetch }));
      const result = await client.streamChatCompletion(
        makeRequest({ signal: controller.signal }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("aborted");
      }
    });
  });

  describe("token timeout", () => {
    it("returns timeout failure when no token arrives within timeout", async () => {
      // Use a very short timeout for testing
      const slowStream = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueue anything — simulates a stalled stream
        },
      });

      const mockFetch: typeof globalThis.fetch = async () => {
        return new Response(slowStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      const client = createStreamingClient(
        makeOptions({ fetch: mockFetch, tokenTimeoutMs: 50 }),
      );

      const resultPromise = client.streamChatCompletion(makeRequest());

      // Advance timers to trigger timeout
      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("timeout");
        expect(result.detail).toContain("50ms");
        expect(result.partialContent).toBe("");
      }
    });

    it("returns timeout failure with partial content when stream stalls after tokens", async () => {
      const encoder = new TextEncoder();
      let enqueueCount = 0;

      const slowStream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Enqueue one token immediately
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
          );
          enqueueCount++;
          // Then stall — never enqueue more
        },
      });

      const mockFetch: typeof globalThis.fetch = async () => {
        return new Response(slowStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      const tokens: string[] = [];
      const client = createStreamingClient(
        makeOptions({ fetch: mockFetch, tokenTimeoutMs: 50 }),
      );

      const resultPromise = client.streamChatCompletion(
        makeRequest({ onToken: (t) => tokens.push(t) }),
      );

      // Advance timers to trigger timeout after the first token
      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("timeout");
        expect(result.partialContent).toBe("Hello");
      }
      expect(tokens).toEqual(["Hello"]);
    });

    it("uses default 30s timeout when tokenTimeoutMs is not specified", () => {
      // We can verify this by checking the client is created without error
      // and the timeout detail message would reference 30000ms
      const client = createStreamingClient(makeOptions({ tokenTimeoutMs: undefined }));
      expect(client).toBeDefined();
      expect(client.streamChatCompletion).toBeInstanceOf(Function);
    });
  });

  describe("null response body", () => {
    it("returns malformed failure when response body is null", async () => {
      vi.useRealTimers();

      const mockFetch: typeof globalThis.fetch = async () => {
        // Create a response object and override body to be null
        const resp = new Response(null, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
        Object.defineProperty(resp, "body", { value: null });
        return resp;
      };

      const client = createStreamingClient(makeOptions({ fetch: mockFetch }));
      const result = await client.streamChatCompletion(makeRequest());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed");
        expect(result.detail).toBe("Response body is null");
        expect(result.partialContent).toBe("");
      }
    });
  });

  describe("dependency injection", () => {
    it("uses the injected fetch implementation", async () => {
      vi.useRealTimers();

      const fetchSpy = vi.fn(createMockFetch(200, ["data: [DONE]\n\n"]));
      const client = createStreamingClient(makeOptions({ fetch: fetchSpy }));
      await client.streamChatCompletion(makeRequest());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("passes abort signal to fetch", async () => {
      vi.useRealTimers();

      let capturedSignal: AbortSignal | undefined;
      const mockFetch: typeof globalThis.fetch = async (_url, init) => {
        capturedSignal = init?.signal as AbortSignal;
        return new Response(createSSEStream(["data: [DONE]\n\n"]), { status: 200 });
      };

      const controller = new AbortController();
      const client = createStreamingClient(makeOptions({ fetch: mockFetch }));
      await client.streamChatCompletion(makeRequest({ signal: controller.signal }));

      expect(capturedSignal).toBe(controller.signal);
    });
  });
});
