/**
 * Content script entry point.
 *
 * Listens for messages from the background script via browser.runtime.onMessage.
 * Validates incoming messages using the typed message system, then dispatches
 * to the appropriate handler based on message kind.
 */

import { isMessageOfKind, buildMessage } from "@shared/messages";
import type { MessageOf, ExtractResultPayload, PickerResultPayload, SelectorPreviewResultPayload } from "@shared/messages";
import { extract } from "./extractor/extract";
import { createElementPicker } from "./element-picker";

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleExtractRequested(
  msg: MessageOf<"extractRequested">,
): Promise<MessageOf<"extractResult">> {
  const { selector } = msg.payload;

  const result = await extract({
    contentSelector: selector,
  });

  let payload: ExtractResultPayload;

  if (result.ok) {
    payload = {
      ok: true,
      article: result.article,
      confidence: result.confidence,
      stalePattern: result.stalePattern,
    };
  } else {
    payload = {
      ok: false,
      reason: result.reason,
      detail: result.detail,
    };
  }

  return buildMessage("extractResult", payload, msg.requestId);
}

async function handlePickerActivate(
  msg: MessageOf<"pickerActivate">,
): Promise<MessageOf<"pickerResult">> {
  const picker = createElementPicker();
  const result = await picker.pick();

  let payload: PickerResultPayload;
  if (result) {
    payload = {
      ok: true,
      selector: result.selector,
      previewText: result.previewText,
    };
  } else {
    payload = {
      ok: false,
      reason: "Selection cancelled",
    };
  }

  return buildMessage("pickerResult", payload, msg.requestId);
}

const SELECTOR_PREVIEW_MAX_CHARS = 500;

/**
 * Live selector preview for the options page (CF-6.5): returns the first
 * matched element's text so users can see what a selector captures.
 */
function handleSelectorPreview(
  msg: MessageOf<"selectorPreview">,
): MessageOf<"selectorPreviewResult"> {
  const { selector } = msg.payload;

  let payload: SelectorPreviewResultPayload;
  try {
    const element = document.querySelector(selector);
    if (element) {
      const text = (element.textContent ?? "").trim().slice(0, SELECTOR_PREVIEW_MAX_CHARS);
      payload = { ok: true, text };
    } else {
      payload = { ok: false, reason: "Selector matched no elements" };
    }
  } catch {
    payload = { ok: false, reason: "Invalid CSS selector syntax" };
  }

  return buildMessage("selectorPreviewResult", payload, msg.requestId);
}

// ─── Listener Registration ───────────────────────────────────────────────────

export function registerMessageListener(): void {
  browser.runtime.onMessage.addListener(
    (message: unknown): undefined | Promise<MessageOf<"extractResult"> | MessageOf<"pickerResult"> | MessageOf<"selectorPreviewResult">> => {
      if (isMessageOfKind(message, "extractRequested")) {
        return handleExtractRequested(message);
      }

      if (isMessageOfKind(message, "pickerActivate")) {
        return handlePickerActivate(message);
      }

      if (isMessageOfKind(message, "selectorPreview")) {
        return Promise.resolve(handleSelectorPreview(message));
      }

      // Invalid or unrecognized messages are discarded silently.
      return undefined;
    },
  );
}

// ─── Initialize ──────────────────────────────────────────────────────────────

registerMessageListener();
