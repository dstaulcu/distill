/**
 * Streaming AI Client for OpenAI-compatible endpoints.
 *
 * Parses SSE streams, delivers tokens via callback, and enforces
 * a configurable token timeout. Uses dependency injection for fetch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface StreamChatCompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly signal: AbortSignal;
  readonly onToken: (token: string) => void;
}

export type StreamChatCompletionResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "network" | "non-2xx" | "malformed" | "aborted";
      readonly statusCode?: number;
      readonly detail: string;
      readonly partialContent: string;
    };

export interface StreamingAiClient {
  streamChatCompletion(req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult>;
}

export interface StreamingClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly tokenTimeoutMs?: number; // Default: 30_000
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

export function createStreamingClient(opts: StreamingClientOptions): StreamingAiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const tokenTimeoutMs = opts.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const endpoint = opts.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";

  return {
    async streamChatCompletion(req: StreamChatCompletionRequest): Promise<StreamChatCompletionResult> {
      let partialContent = "";

      // Check if already aborted
      if (req.signal.aborted) {
        return {
          ok: false,
          reason: "aborted",
          detail: "Request was aborted before starting",
          partialContent,
        };
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`;
      }

      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: true,
          }),
          signal: req.signal,
        });
      } catch (err: unknown) {
        if (isAbortError(err)) {
          return {
            ok: false,
            reason: "aborted",
            detail: "Request was aborted",
            partialContent,
          };
        }
        return {
          ok: false,
          reason: "network",
          detail: err instanceof Error ? err.message : "Network error",
          partialContent,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: "non-2xx",
          statusCode: response.status,
          detail: `Server returned ${response.status}`,
          partialContent,
        };
      }

      if (!response.body) {
        return {
          ok: false,
          reason: "malformed",
          detail: "Response body is null",
          partialContent,
        };
      }

      // Parse SSE stream
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Track last token time and check on each read
        let lastTokenTime = Date.now();

        const checkTimeout = () => {
          if (Date.now() - lastTokenTime > tokenTimeoutMs) {
            throw new TokenTimeoutError();
          }
        };

        // Set up abort listener
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reader.cancel().catch(() => {});
        };
        req.signal.addEventListener("abort", onAbort);

        try {
          while (true) {
            if (aborted) {
              return {
                ok: false,
                reason: "aborted",
                detail: "Request was aborted during streaming",
                partialContent,
              };
            }

            checkTimeout();

            // Read with a timeout race; the timer is cancelled as soon as the
            // race settles so completed reads don't leave timers behind
            const readTimeout = createReadTimeout(tokenTimeoutMs - (Date.now() - lastTokenTime));
            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
              readResult = await Promise.race([reader.read(), readTimeout.promise]);
            } finally {
              readTimeout.cancel();
            }

            if (aborted) {
              return {
                ok: false,
                reason: "aborted",
                detail: "Request was aborted during streaming",
                partialContent,
              };
            }

            if (readResult.done) {
              break;
            }

            buffer += decoder.decode(readResult.value, { stream: true });

            // Process complete lines from buffer
            const lines = buffer.split("\n");
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();

              if (trimmed === "") {
                continue;
              }

              if (!trimmed.startsWith("data: ")) {
                continue;
              }

              const data = trimmed.slice(6); // Remove "data: " prefix

              if (data === "[DONE]") {
                return { ok: true, content: partialContent };
              }

              try {
                const parsed = JSON.parse(data);
                const token = parsed?.choices?.[0]?.delta?.content;
                if (typeof token === "string" && token.length > 0) {
                  partialContent += token;
                  lastTokenTime = Date.now();
                  req.onToken(token);
                }
              } catch {
                // Skip malformed JSON lines — some SSE streams include comments or metadata
              }
            }
          }
        } finally {
          req.signal.removeEventListener("abort", onAbort);
        }

        // Stream ended without [DONE] — still return what we have as success
        return { ok: true, content: partialContent };
      } catch (err: unknown) {
        if (err instanceof TokenTimeoutError) {
          return {
            ok: false,
            reason: "timeout",
            detail: `No token received within ${tokenTimeoutMs}ms`,
            partialContent,
          };
        }
        if (isAbortError(err)) {
          return {
            ok: false,
            reason: "aborted",
            detail: "Request was aborted during streaming",
            partialContent,
          };
        }
        return {
          ok: false,
          reason: "network",
          detail: err instanceof Error ? err.message : "Stream read error",
          partialContent,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TokenTimeoutError extends Error {
  constructor() {
    super("Token timeout");
    this.name = "TokenTimeoutError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function createReadTimeout(ms: number): { readonly promise: Promise<never>; readonly cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TokenTimeoutError());
    }, Math.max(ms, 0));
  });
  return {
    promise,
    cancel: () => clearTimeout(timeoutId),
  };
}
