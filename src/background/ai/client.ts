/**
 * Non-streaming AI client for one-shot requests and connection testing.
 *
 * Uses OpenAI-compatible chat completions endpoint with configurable
 * timeout and injectable fetch dependency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiClient {
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResult>;
  testConnection(): Promise<ConnectionTestResult>;
}

export interface AiClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number; // Default: 60_000
  readonly fetch?: typeof globalThis.fetch;
}

export interface ChatCompletionRequest {
  readonly messages: ReadonlyArray<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  readonly model?: string; // Override the default model
}

export type ChatCompletionResult =
  | { readonly ok: true; readonly content: string }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "network" | "non-2xx";
      readonly statusCode?: number;
      readonly detail: string;
    };

export type ConnectionTestResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "network" | "timeout" | "non-2xx";
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Constructs the chat completions endpoint URL from a base URL.
 * Strips trailing slashes and appends `/v1/chat/completions`.
 */
function buildEndpointUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
}

/**
 * Creates a non-streaming AI client for one-shot requests and connection testing.
 */
export function createAiClient(opts: AiClientOptions): AiClient {
  const {
    baseUrl,
    apiKey,
    model,
    timeoutMs = 60_000,
    fetch: fetchFn = globalThis.fetch,
  } = opts;

  const endpointUrl = buildEndpointUrl(baseUrl);

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  async function chatCompletion(
    req: ChatCompletionRequest
  ): Promise<ChatCompletionResult> {
    const body = JSON.stringify({
      model: req.model ?? model,
      messages: req.messages,
      stream: false,
    });

    let response: Response;
    try {
      response = await fetchFn(endpointUrl, {
        method: "POST",
        headers: buildHeaders(),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        return {
          ok: false,
          reason: "timeout",
          detail: `Request timed out after ${timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        reason: "network",
        detail: err instanceof Error ? err.message : "Network error",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: "non-2xx",
        statusCode: response.status,
        detail: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    try {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return { ok: true, content };
    } catch {
      return {
        ok: false,
        reason: "network",
        detail: "Failed to parse response JSON",
      };
    }
  }

  async function testConnection(): Promise<ConnectionTestResult> {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "test" }],
      stream: false,
    });

    let response: Response;
    try {
      response = await fetchFn(endpointUrl, {
        method: "POST",
        headers: buildHeaders(),
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        return {
          ok: false,
          reason: "timeout",
          detail: "Connection test timed out after 10000ms",
        };
      }
      return {
        ok: false,
        reason: "network",
        detail: err instanceof Error ? err.message : "Network error",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: "non-2xx",
        detail: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return { ok: true };
  }

  return { chatCompletion, testConnection };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determines if an error is a timeout (AbortError from AbortSignal.timeout).
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}
