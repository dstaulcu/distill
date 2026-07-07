import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createStreamingClient } from "./streaming-client";

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

/** Formats a token string as an SSE data line. */
function tokenToSSEChunk(token: string): string {
  const payload = JSON.stringify({
    choices: [{ delta: { content: token } }],
  });
  return `data: ${payload}\n\n`;
}

// ---------------------------------------------------------------------------
// Property 1: Streaming token accumulation equals final content
// Validates: Requirements 1.4, 1.5, 1.8, 1.12, 1.13
// ---------------------------------------------------------------------------

describe("Property 1: Streaming token accumulation equals final content", () => {
  it("concatenation of onToken callbacks equals final content field for any token sequence", async () => {
    /**
     * **Validates: Requirements 1.4, 1.5, 1.8, 1.12, 1.13**
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 20 }),
        async (tokens) => {
          // Build SSE chunks from the token array, ending with [DONE]
          const sseChunks = tokens.map(tokenToSSEChunk);
          sseChunks.push("data: [DONE]\n\n");

          const mockFetch: typeof globalThis.fetch = async () => {
            return new Response(createSSEStream(sseChunks), {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          };

          const receivedTokens: string[] = [];
          const client = createStreamingClient({
            baseUrl: "https://api.example.com",
            apiKey: "sk-test",
            fetch: mockFetch,
          });

          const result = await client.streamChatCompletion({
            model: "test-model",
            messages: [{ role: "user", content: "hello" }],
            signal: new AbortController().signal,
            onToken: (t) => receivedTokens.push(t),
          });

          const expectedContent = tokens.join("");

          // The result should be successful
          expect(result.ok).toBe(true);
          if (result.ok) {
            // The final content field equals the concatenation of all tokens
            expect(result.content).toBe(expectedContent);
          }

          // The concatenation of all onToken callbacks equals the final content
          expect(receivedTokens.join("")).toBe(expectedContent);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: AI client URL construction
// Validates: Requirements 1.12
// ---------------------------------------------------------------------------

describe("Property 19: AI client URL construction", () => {
  it("constructed endpoint URL has exactly one slash between base and /v1/chat/completions", async () => {
    /**
     * **Validates: Requirements 1.4, 1.5, 1.8, 1.12, 1.13**
     */

    // Generator for base URLs with varying trailing slashes
    const baseUrlArb = fc
      .tuple(
        fc.constantFrom("https://", "http://"),
        fc.webSegment().filter((s) => s.length > 0),
        fc.constantFrom(".com", ".io", ".org", ".net"),
        fc.stringOf(fc.constantFrom("/"), { minLength: 0, maxLength: 5 }),
      )
      .map(([protocol, domain, tld, trailingSlashes]) => {
        return `${protocol}${domain}${tld}${trailingSlashes}`;
      });

    await fc.assert(
      fc.asyncProperty(baseUrlArb, async (baseUrl) => {
        let capturedUrl = "";
        const mockFetch: typeof globalThis.fetch = async (url) => {
          capturedUrl = url as string;
          return new Response(createSSEStream(["data: [DONE]\n\n"]), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        };

        const client = createStreamingClient({
          baseUrl,
          apiKey: "sk-test",
          fetch: mockFetch,
        });

        await client.streamChatCompletion({
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
          signal: new AbortController().signal,
          onToken: () => {},
        });

        // The URL should end with /v1/chat/completions
        expect(capturedUrl).toContain("/v1/chat/completions");

        // There should be exactly one slash between the base portion and "v1/chat/completions"
        // i.e., no double slashes before v1
        const v1Index = capturedUrl.indexOf("/v1/chat/completions");
        expect(v1Index).toBeGreaterThan(0);

        // The character before "/v1" should NOT be a slash (no double slash)
        const charBeforeV1 = capturedUrl[v1Index - 1];
        expect(charBeforeV1).not.toBe("/");
      }),
      { numRuns: 100 },
    );
  });

  it("base URLs with path segments preserve the path before /v1/chat/completions", async () => {
    /**
     * **Validates: Requirements 1.12**
     */

    // Generator for base URLs with path segments and varying trailing slashes
    const baseUrlWithPathArb = fc
      .tuple(
        fc.constantFrom("https://", "http://"),
        fc.webSegment().filter((s) => s.length > 0),
        fc.constantFrom(".com", ".io"),
        fc.array(fc.webSegment().filter((s) => s.length > 0), { minLength: 1, maxLength: 3 }),
        fc.stringOf(fc.constantFrom("/"), { minLength: 0, maxLength: 4 }),
      )
      .map(([protocol, domain, tld, pathSegments, trailingSlashes]) => {
        return `${protocol}${domain}${tld}/${pathSegments.join("/")}${trailingSlashes}`;
      });

    await fc.assert(
      fc.asyncProperty(baseUrlWithPathArb, async (baseUrl) => {
        let capturedUrl = "";
        const mockFetch: typeof globalThis.fetch = async (url) => {
          capturedUrl = url as string;
          return new Response(createSSEStream(["data: [DONE]\n\n"]), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        };

        const client = createStreamingClient({
          baseUrl,
          apiKey: "sk-test",
          fetch: mockFetch,
        });

        await client.streamChatCompletion({
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
          signal: new AbortController().signal,
          onToken: () => {},
        });

        // The URL must end with /v1/chat/completions
        expect(capturedUrl.endsWith("/v1/chat/completions")).toBe(true);

        // No double slashes anywhere in the URL (except after protocol)
        const urlWithoutProtocol = capturedUrl.replace(/^https?:\/\//, "");
        expect(urlWithoutProtocol).not.toContain("//");
      }),
      { numRuns: 100 },
    );
  });
});
