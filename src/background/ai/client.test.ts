import { describe, it, expect, vi } from "vitest";
import { createAiClient } from "./client";
import type { AiClientOptions, ChatCompletionRequest } from "./client";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a mock fetch that returns a successful chat completion response. */
function createMockFetch(
  overrides: {
    status?: number;
    statusText?: string;
    body?: unknown;
    throwError?: Error;
  } = {}
) {
  const {
    status = 200,
    statusText = "OK",
    body = { choices: [{ message: { content: "Hello!" } }] },
    throwError,
  } = overrides;

  return vi.fn<typeof globalThis.fetch>(async () => {
    if (throwError) throw throwError;
    return new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** Creates a mock fetch that simulates a timeout via DOMException. */
function createTimeoutFetch() {
  return vi.fn<typeof globalThis.fetch>(async () => {
    throw new DOMException("The operation was aborted.", "TimeoutError");
  });
}

/** Default client options for testing. */
function defaultOpts(
  fetchFn: typeof globalThis.fetch
): AiClientOptions {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test-key",
    model: "gpt-4",
    fetch: fetchFn,
  };
}

// ---------------------------------------------------------------------------
// Tests: chatCompletion
// ---------------------------------------------------------------------------

describe("CF-5.4 AiClient", () => {
  describe("chatCompletion", () => {
    it("sends a POST request to the correct endpoint", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(init?.method).toBe("POST");
    });

    it("strips trailing slashes from base URL", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        baseUrl: "https://api.example.com///",
      });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
    });

    it("includes Authorization header with Bearer token", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    });

    it("CF-5.3 omits the Authorization header when apiKey is empty (keyless endpoints)", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({ ...defaultOpts(mockFetch), apiKey: "" });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("includes Content-Type application/json header", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("sends model and messages in the request body with stream: false", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      const req: ChatCompletionRequest = {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      };

      await client.chatCompletion(req);

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("gpt-4");
      expect(body.messages).toEqual([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ]);
      expect(body.stream).toBe(false);
    });

    it("allows overriding the model in the request", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
        model: "gpt-3.5-turbo",
      });

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("gpt-3.5-turbo");
    });

    it("returns ok: true with content on successful response", async () => {
      const mockFetch = createMockFetch({
        body: { choices: [{ message: { content: "Response text" } }] },
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({ ok: true, content: "Response text" });
    });

    it("returns empty string content when choices array is empty", async () => {
      const mockFetch = createMockFetch({ body: { choices: [] } });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({ ok: true, content: "" });
    });

    it("returns empty string content when message content is missing", async () => {
      const mockFetch = createMockFetch({
        body: { choices: [{ message: {} }] },
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({ ok: true, content: "" });
    });

    it("returns timeout failure on timeout error", async () => {
      const mockFetch = createTimeoutFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "timeout",
        detail: "Request timed out after 60000ms",
      });
    });

    it("returns network failure on fetch error", async () => {
      const mockFetch = createMockFetch({
        throwError: new TypeError("Failed to fetch"),
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "network",
        detail: "Failed to fetch",
      });
    });

    it("returns non-2xx failure with status code on error response", async () => {
      const mockFetch = createMockFetch({
        status: 401,
        statusText: "Unauthorized",
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "non-2xx",
        statusCode: 401,
        detail: "HTTP 401: Unauthorized",
      });
    });

    it("returns non-2xx failure for 500 server error", async () => {
      const mockFetch = createMockFetch({
        status: 500,
        statusText: "Internal Server Error",
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "non-2xx",
        statusCode: 500,
        detail: "HTTP 500: Internal Server Error",
      });
    });

    it("uses custom timeoutMs for the abort signal", async () => {
      const mockFetch = createTimeoutFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        timeoutMs: 5000,
      });

      const result = await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result).toEqual({
        ok: false,
        reason: "timeout",
        detail: "Request timed out after 5000ms",
      });
    });

    it("passes an AbortSignal to fetch", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: testConnection
  // ---------------------------------------------------------------------------

  describe("testConnection", () => {
    it("sends a minimal POST request to the endpoint", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.testConnection();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(init?.method).toBe("POST");
    });

    it("sends a minimal message body with model and test message", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.testConnection();

      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("gpt-4");
      expect(body.messages).toEqual([{ role: "user", content: "test" }]);
      expect(body.stream).toBe(false);
    });

    it("returns ok: true on successful 2xx response", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.testConnection();

      expect(result).toEqual({ ok: true });
    });

    it("returns timeout failure on timeout error", async () => {
      const mockFetch = createTimeoutFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.testConnection();

      expect(result).toEqual({
        ok: false,
        reason: "timeout",
        detail: "Connection test timed out after 10000ms",
      });
    });

    it("returns network failure on fetch error", async () => {
      const mockFetch = createMockFetch({
        throwError: new TypeError("DNS resolution failed"),
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.testConnection();

      expect(result).toEqual({
        ok: false,
        reason: "network",
        detail: "DNS resolution failed",
      });
    });

    it("returns non-2xx failure on error response", async () => {
      const mockFetch = createMockFetch({
        status: 403,
        statusText: "Forbidden",
      });
      const client = createAiClient(defaultOpts(mockFetch));

      const result = await client.testConnection();

      expect(result).toEqual({
        ok: false,
        reason: "non-2xx",
        detail: "HTTP 403: Forbidden",
      });
    });

    it("uses 10s timeout regardless of client timeoutMs setting", async () => {
      const mockFetch = createTimeoutFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        timeoutMs: 120_000, // Client timeout is 120s, but testConnection should use 10s
      });

      const result = await client.testConnection();

      expect(result).toEqual({
        ok: false,
        reason: "timeout",
        detail: "Connection test timed out after 10000ms",
      });
    });

    it("includes Authorization header", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient(defaultOpts(mockFetch));

      await client.testConnection();

      const [, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: URL construction
  // ---------------------------------------------------------------------------

  describe("URL construction", () => {
    it("appends /v1/chat/completions to base URL without trailing slash", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        baseUrl: "https://api.openai.com",
      });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("appends /v1/chat/completions to base URL with single trailing slash", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        baseUrl: "https://api.openai.com/",
      });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("appends /v1/chat/completions to base URL with multiple trailing slashes", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        baseUrl: "https://api.openai.com///",
      });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("handles base URL with path prefix", async () => {
      const mockFetch = createMockFetch();
      const client = createAiClient({
        ...defaultOpts(mockFetch),
        baseUrl: "https://proxy.example.com/openai",
      });

      await client.chatCompletion({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://proxy.example.com/openai/v1/chat/completions"
      );
    });
  });
});
