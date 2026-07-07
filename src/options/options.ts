/**
 * Settings page entry point.
 *
 * Vanilla TypeScript UI for configuring AI endpoint, site patterns,
 * export preferences, and auto-export configurations.
 * Communicates with the background via browser.runtime.sendMessage.
 */

import type { Settings, SitePattern, AutoExportConfig, ExportDestination, AutoExportMode, SkillLibrary, StoredSkill, Persona } from "@shared/types";
import { buildMessage, sendToBackground, isMessageOfKind } from "@shared/messages";
import type { FieldError } from "@background/settings/manager";
import { parseSkillFile } from "@shared/skill-parser";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_USER_PATTERNS = 50;
const MAX_SKILLS = 20;
const MAX_PERSONAS = 10;
const SKILL_MAX_SIZE = 512 * 1024;
const CONNECTION_TEST_TIMEOUT_MS = 10_000;
const SELECTOR_PREVIEW_MAX_CHARS = 500;
const LIBRARY_STORAGE_KEY = "distill_skill_library";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OptionsState {
  settings: Settings | null;
  editingPatternIndex: number | null;
  editingAutoExportOrigin: string | null;
  library: SkillLibrary | null;
  editingPersonaId: string | null;
}

const state: OptionsState = {
  settings: null,
  editingPatternIndex: null,
  editingAutoExportOrigin: null,
  library: null,
  editingPersonaId: null,
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

function $input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadLibrary();
  bindEventListeners();
});

async function loadSettings(): Promise<void> {
  try {
    // Read settings from storage (same key the settings manager uses)
    const stored = await browser.storage.sync.get("settings");
    let settings: Settings | null = stored?.settings as Settings ?? null;
    if (!settings) {
      const local = await browser.storage.local.get("settings");
      settings = local?.settings as Settings ?? null;
    }
    if (!settings) {
      // No settings stored yet — use defaults
      settings = {
        schemaVersion: 1,
        ai: { baseUrl: "", modelId: "", apiKeyRef: null, systemPrompt: "" },
        export: {
          filenamePattern: "YYYY-MM-DD-slugified-title",
          defaultDestination: { kind: "download" },
          frontmatterFields: ["title", "author", "source_url", "publication_date", "capture_date", "site_name"],
        },
        sitePatterns: [],
        autoExportConfigs: [],
      };
    }
    state.settings = settings;
    renderAll();
  } catch {
    showSaveStatus("Failed to load settings", true);
  }
}

// ---------------------------------------------------------------------------
// Event Binding
// ---------------------------------------------------------------------------

function bindEventListeners(): void {
  // Connection test
  $("btn-test-connection").addEventListener("click", handleConnectionTest);

  // Model fetching
  $("btn-fetch-models").addEventListener("click", handleFetchModels);
  ($("ai-model-select") as HTMLSelectElement).addEventListener("change", handleModelSelect);
  $input("ai-base-url").addEventListener("change", handleFetchModels);

  // Pattern management
  $("btn-add-pattern").addEventListener("click", handleAddPattern);
  $("btn-save-pattern").addEventListener("click", handleSavePattern);
  $("btn-cancel-pattern").addEventListener("click", handleCancelPattern);

  // Selector preview on input change
  $input("pattern-selector").addEventListener("input", handleSelectorPreview);

  // Skill library
  $("btn-add-skill").addEventListener("click", () => {
    ($("skill-file-input") as HTMLInputElement).click();
  });
  ($("skill-file-input") as HTMLInputElement).addEventListener("change", handleSkillUpload);

  // Persona management
  $("btn-add-persona").addEventListener("click", handleAddPersona);
  $("btn-save-persona").addEventListener("click", handleSavePersona);
  $("btn-cancel-persona").addEventListener("click", handleCancelPersona);

  // Save settings
  $("btn-save-settings").addEventListener("click", handleSaveSettings);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll(): void {
  if (!state.settings) return;
  renderAiSection();
  renderExportSection();
  renderPatternsSection();
  renderAutoExportSection();
  renderSkillLibrarySection();
}

function renderAiSection(): void {
  if (!state.settings) return;
  $input("ai-base-url").value = state.settings.ai.baseUrl;
  $input("ai-model-id").value = state.settings.ai.modelId;

  // Set the dropdown to the current model if it's in the list
  const select = $("ai-model-select") as HTMLSelectElement;
  if (state.settings.ai.modelId && select.querySelector(`option[value="${CSS.escape(state.settings.ai.modelId)}"]`)) {
    select.value = state.settings.ai.modelId;
  }

  // API key is not displayed for security — only show placeholder if one is set
  $input("ai-api-key").value = "";
  $input("ai-api-key").placeholder = state.settings.ai.apiKeyRef ? "••••••••" : "sk-...";

  // Auto-fetch models if base URL is configured
  if (state.settings.ai.baseUrl) {
    handleFetchModels();
  }
}

function renderExportSection(): void {
  if (!state.settings) return;
  $input("export-filename-pattern").value = state.settings.export.filenamePattern;

  // Frontmatter field checkboxes
  const container = $("frontmatter-fields");
  const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
  checkboxes.forEach((cb) => {
    cb.checked = state.settings!.export.frontmatterFields.includes(cb.value);
  });
}

function renderPatternsSection(): void {
  if (!state.settings) return;
  const list = $("patterns-list");
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");

  if (userPatterns.length === 0) {
    list.innerHTML = '<div class="empty-state">No user-defined patterns. Click "Add Pattern" to create one.</div>';
    return;
  }

  list.innerHTML = userPatterns
    .map((pattern, index) => renderPatternItem(pattern, index))
    .join("");

  // Bind edit/delete buttons
  list.querySelectorAll<HTMLButtonElement>("[data-action='edit-pattern']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index!, 10);
      handleEditPattern(idx);
    });
  });

  list.querySelectorAll<HTMLButtonElement>("[data-action='delete-pattern']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index!, 10);
      handleDeletePattern(idx);
    });
  });
}

function renderPatternItem(pattern: SitePattern, index: number): string {
  const staleClass = pattern.stale ? " stale" : "";
  const staleBadge = pattern.stale
    ? '<span class="pattern-item-stale-badge">⚠ Stale — selector may need updating</span>'
    : "";

  return `
    <div class="pattern-item${staleClass}">
      <div class="pattern-item-info">
        <div class="pattern-item-url">${escapeHtml(pattern.urlMatchPattern)}${staleBadge}</div>
        <div class="pattern-item-selector">${escapeHtml(pattern.contentSelector)}</div>
      </div>
      <div class="pattern-item-actions">
        <button class="btn-small btn-secondary" data-action="edit-pattern" data-index="${index}">Edit</button>
        <button class="btn-small btn-danger" data-action="delete-pattern" data-index="${index}">Delete</button>
      </div>
    </div>
  `;
}

function renderAutoExportSection(): void {
  if (!state.settings) return;
  const list = $("auto-export-list");
  const configs = state.settings.autoExportConfigs;

  if (configs.length === 0) {
    list.innerHTML = '<div class="empty-state">No auto-export configurations.</div>';
    return;
  }

  list.innerHTML = configs
    .map((config) => renderAutoExportItem(config))
    .join("");

  // Bind edit/delete buttons
  list.querySelectorAll<HTMLButtonElement>("[data-action='edit-auto-export']").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleEditAutoExport(btn.dataset.origin!);
    });
  });

  list.querySelectorAll<HTMLButtonElement>("[data-action='delete-auto-export']").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleDeleteAutoExport(btn.dataset.origin!);
    });
  });
}

function renderAutoExportItem(config: AutoExportConfig): string {
  const destLabel = config.destination.kind === "download" ? "Download" : "Clipboard";
  const modeLabel = config.mode === "content-only" ? "Content only" : "Full";
  const isEditing = state.editingAutoExportOrigin === config.origin;

  let editorHtml = "";
  if (isEditing) {
    editorHtml = `
      <div class="auto-export-editor">
        <div class="form-row">
          <div class="form-group">
            <label for="ae-enabled-${escapeAttr(config.origin)}">Enabled</label>
            <input type="checkbox" id="ae-enabled-${escapeAttr(config.origin)}" ${config.enabled ? "checked" : ""} />
          </div>
          <div class="form-group">
            <label for="ae-interval-${escapeAttr(config.origin)}">Interval (min)</label>
            <input type="number" id="ae-interval-${escapeAttr(config.origin)}" min="1" max="120" value="${config.intervalMinutes}" />
          </div>
          <div class="form-group">
            <label for="ae-dest-${escapeAttr(config.origin)}">Destination</label>
            <select id="ae-dest-${escapeAttr(config.origin)}">
              <option value="download" ${config.destination.kind === "download" ? "selected" : ""}>Download</option>
              <option value="clipboard" ${config.destination.kind === "clipboard" ? "selected" : ""}>Clipboard</option>
            </select>
          </div>
          <div class="form-group">
            <label for="ae-mode-${escapeAttr(config.origin)}">Mode</label>
            <select id="ae-mode-${escapeAttr(config.origin)}">
              <option value="content-only" ${config.mode === "content-only" ? "selected" : ""}>Content only</option>
              <option value="full" ${config.mode === "full" ? "selected" : ""}>Full</option>
            </select>
          </div>
        </div>
        <div class="form-group form-actions">
          <button type="button" data-action="save-auto-export" data-origin="${escapeAttr(config.origin)}">Save</button>
          <button type="button" class="btn-secondary" data-action="cancel-auto-export">Cancel</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="auto-export-item">
      <div class="auto-export-item-info">
        <div class="auto-export-item-origin">${escapeHtml(config.origin)}</div>
        <div class="auto-export-item-details">Every ${config.intervalMinutes} min · ${destLabel} · ${modeLabel}${config.skipIfUnchanged ? " · Skip unchanged" : ""}</div>
      </div>
      <div class="auto-export-item-actions">
        <button class="btn-small btn-secondary" data-action="edit-auto-export" data-origin="${escapeAttr(config.origin)}">Edit</button>
        <button class="btn-small btn-danger" data-action="delete-auto-export" data-origin="${escapeAttr(config.origin)}">Delete</button>
      </div>
    </div>
    ${editorHtml}
  `;
}

// ---------------------------------------------------------------------------
// Handlers: AI Connection Test
// ---------------------------------------------------------------------------

async function handleConnectionTest(): Promise<void> {
  const statusEl = $("connection-status");
  const btn = $("btn-test-connection") as HTMLButtonElement;

  const baseUrl = $input("ai-base-url").value.trim();
  const modelId = $input("ai-model-id").value.trim();
  const apiKey = $input("ai-api-key").value.trim();

  // Client-side validation
  if (!baseUrl) {
    showConnectionStatus("Base URL is required", "error");
    return;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    showConnectionStatus("Base URL must start with http:// or https://", "error");
    return;
  }

  btn.disabled = true;
  showConnectionStatus("Testing...", "testing");

  try {
    const response = await Promise.race([
      sendToBackground("connectionTest", { baseUrl, apiKey, modelId }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), CONNECTION_TEST_TIMEOUT_MS)
      ),
    ]);

    if (response && typeof response === "object" && isMessageOfKind(response, "connectionTestResult")) {
      const result = response.payload;
      if (result.ok) {
        showConnectionStatus("Connected successfully", "success");
      } else {
        showConnectionStatus(result.reason ?? "Connection failed", "error");
      }
    } else if (response && typeof response === "object") {
      // Direct result from background handler
      const result = response as { ok: boolean; reason?: string; detail?: string };
      if (result.ok) {
        showConnectionStatus("Connected successfully", "success");
      } else {
        showConnectionStatus(result.detail ?? result.reason ?? "Connection failed", "error");
      }
    } else {
      showConnectionStatus("Unexpected response", "error");
    }
  } catch (err) {
    const message = err instanceof Error && err.message === "timeout"
      ? "Connection timed out (10s)"
      : "Connection failed";
    showConnectionStatus(message, "error");
  } finally {
    btn.disabled = false;
  }
}

function showConnectionStatus(text: string, type: "success" | "error" | "testing"): void {
  const el = $("connection-status");
  el.textContent = text;
  el.className = `connection-status ${type}`;
}

// ---------------------------------------------------------------------------
// Handlers: Model Fetching
// ---------------------------------------------------------------------------

async function handleFetchModels(): Promise<void> {
  const baseUrl = $input("ai-base-url").value.trim();
  if (!baseUrl) return;

  const select = $("ai-model-select") as HTMLSelectElement;
  const btn = $("btn-fetch-models") as HTMLButtonElement;
  const apiKey = $input("ai-api-key").value.trim();

  // Use stored key if input is empty
  const effectiveKey = apiKey || "";

  btn.disabled = true;
  select.disabled = true;

  // Preserve current selection
  const currentModel = $input("ai-model-id").value.trim() || select.value;

  try {
    const endpoint = baseUrl.replace(/\/+$/, "") + "/v1/models";
    const response = await fetch(endpoint, {
      method: "GET",
      headers: effectiveKey
        ? { Authorization: `Bearer ${effectiveKey}` }
        : {},
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // Silently fail — user can still type manually
      return;
    }

    const json = await response.json() as { data?: Array<{ id: string }> };
    const models = json.data ?? [];

    // Clear existing options (keep the placeholder)
    select.innerHTML = '<option value="">— Select a model —</option>';

    // Sort models alphabetically
    models.sort((a, b) => a.id.localeCompare(b.id));

    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.id;
      select.appendChild(option);
    }

    // Restore selection
    if (currentModel) {
      const matchingOption = select.querySelector(`option[value="${CSS.escape(currentModel)}"]`);
      if (matchingOption) {
        select.value = currentModel;
      } else if (currentModel) {
        // Add the current model as an option even if not in the list
        const option = document.createElement("option");
        option.value = currentModel;
        option.textContent = `${currentModel} (not found on server)`;
        select.appendChild(option);
        select.value = currentModel;
      }
    }
  } catch {
    // Silently fail — models endpoint might not be available
  } finally {
    btn.disabled = false;
    select.disabled = false;
  }
}

function handleModelSelect(): void {
  const select = $("ai-model-select") as HTMLSelectElement;
  const modelInput = $input("ai-model-id");

  if (select.value) {
    modelInput.value = select.value;
  }
}

// ---------------------------------------------------------------------------
// Handlers: Site Patterns
// ---------------------------------------------------------------------------

function handleAddPattern(): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  if (userPatterns.length >= MAX_USER_PATTERNS) {
    showSaveStatus(`Maximum of ${MAX_USER_PATTERNS} user-defined patterns reached`, true);
    return;
  }

  state.editingPatternIndex = null;
  showPatternEditor("Add Site Pattern", "", "");
}

function handleEditPattern(userIndex: number): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const pattern = userPatterns[userIndex];
  if (!pattern) return;

  state.editingPatternIndex = userIndex;
  showPatternEditor("Edit Site Pattern", pattern.urlMatchPattern, pattern.contentSelector);
}

function handleDeletePattern(userIndex: number): void {
  if (!state.settings) return;
  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const pattern = userPatterns[userIndex];
  if (!pattern) return;

  // Remove from settings
  const updatedPatterns = state.settings.sitePatterns.filter((p) => p.id !== pattern.id);
  state.settings = { ...state.settings, sitePatterns: updatedPatterns };
  renderPatternsSection();
}

function handleSavePattern(): void {
  if (!state.settings) return;

  const urlPattern = $input("pattern-url").value.trim();
  const selector = $input("pattern-selector").value.trim();

  // Client-side validation
  const errors = validatePatternFields(urlPattern, selector);
  showPatternErrors(errors);
  if (errors.length > 0) return;

  const userPatterns = state.settings.sitePatterns.filter((p) => p.source === "user");
  const builtinPatterns = state.settings.sitePatterns.filter((p) => p.source === "builtin");

  if (state.editingPatternIndex !== null) {
    // Editing existing
    const existing = userPatterns[state.editingPatternIndex];
    const updated: SitePattern = {
      ...existing,
      urlMatchPattern: urlPattern,
      contentSelector: selector,
      stale: false,
    };
    userPatterns[state.editingPatternIndex] = updated;
  } else {
    // Adding new
    const newPattern: SitePattern = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: "user",
      urlMatchPattern: urlPattern,
      contentSelector: selector,
    };
    userPatterns.push(newPattern);
  }

  state.settings = { ...state.settings, sitePatterns: [...userPatterns, ...builtinPatterns] };
  hidePatternEditor();
  renderPatternsSection();
}

function handleCancelPattern(): void {
  hidePatternEditor();
}

function showPatternEditor(title: string, url: string, selector: string): void {
  $("pattern-editor-title").textContent = title;
  $input("pattern-url").value = url;
  $input("pattern-selector").value = selector;
  $("pattern-editor").classList.remove("hidden");
  $("selector-preview").textContent = "No preview available";
  clearPatternErrors();
}

function hidePatternEditor(): void {
  $("pattern-editor").classList.add("hidden");
  state.editingPatternIndex = null;
  clearPatternErrors();
}

function validatePatternFields(urlPattern: string, selector: string): FieldError[] {
  const errors: FieldError[] = [];

  if (!urlPattern) {
    errors.push({ field: "pattern-url", message: "URL match pattern is required" });
  }

  if (!selector) {
    errors.push({ field: "pattern-selector", message: "Content selector is required" });
  } else if (selector.length > 1024) {
    errors.push({ field: "pattern-selector", message: "Selector must be at most 1024 characters" });
  } else {
    // Validate CSS selector syntax
    try {
      document.querySelector(selector);
    } catch {
      errors.push({ field: "pattern-selector", message: "Invalid CSS selector syntax" });
    }
  }

  return errors;
}

function showPatternErrors(errors: FieldError[]): void {
  clearPatternErrors();
  for (const error of errors) {
    const el = document.getElementById(`error-${error.field}`);
    if (el) {
      el.textContent = error.message;
    }
    const input = document.getElementById(error.field);
    if (input) {
      input.classList.add("has-error");
    }
  }
}

function clearPatternErrors(): void {
  const errorEls = document.querySelectorAll<HTMLElement>("#pattern-editor .field-error");
  errorEls.forEach((el) => (el.textContent = ""));
  const inputs = document.querySelectorAll<HTMLElement>("#pattern-editor input");
  inputs.forEach((el) => el.classList.remove("has-error"));
}

async function handleSelectorPreview(): Promise<void> {
  const selector = $input("pattern-selector").value.trim();
  const previewEl = $("selector-preview");

  if (!selector) {
    previewEl.textContent = "No preview available";
    return;
  }

  // Try to get preview from the current active tab
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0 || !tabs[0].id) {
      previewEl.textContent = "No active tab available for preview";
      return;
    }

    // Ask the content script for the matched element's text (CF-6.5)
    const response = await browser.tabs.sendMessage(
      tabs[0].id,
      buildMessage("selectorPreview", { selector }),
    );

    if (isMessageOfKind(response, "selectorPreviewResult")) {
      if (response.payload.ok) {
        const text = response.payload.text ?? "";
        const truncated = text.length > SELECTOR_PREVIEW_MAX_CHARS
          ? text.slice(0, SELECTOR_PREVIEW_MAX_CHARS) + "…"
          : text;
        previewEl.textContent = truncated || "Selector matched but no text content found";
      } else {
        previewEl.textContent = response.payload.reason ?? "No preview available";
      }
    } else {
      previewEl.textContent = "No preview available (content script not responding)";
    }
  } catch {
    previewEl.textContent = "No preview available";
  }
}

// ---------------------------------------------------------------------------
// Handlers: Auto-Export
// ---------------------------------------------------------------------------

function handleEditAutoExport(origin: string): void {
  state.editingAutoExportOrigin = origin;
  renderAutoExportSection();

  // Bind save/cancel in the editor
  const list = $("auto-export-list");
  list.querySelectorAll<HTMLButtonElement>("[data-action='save-auto-export']").forEach((btn) => {
    btn.addEventListener("click", () => {
      void handleSaveAutoExport(btn.dataset.origin!);
    });
  });
  list.querySelectorAll<HTMLButtonElement>("[data-action='cancel-auto-export']").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editingAutoExportOrigin = null;
      renderAutoExportSection();
    });
  });
}

async function handleSaveAutoExport(origin: string): Promise<void> {
  if (!state.settings) return;

  const escapedOrigin = escapeAttr(origin);
  const enabledInput = document.getElementById(`ae-enabled-${escapedOrigin}`) as HTMLInputElement | null;
  const intervalInput = document.getElementById(`ae-interval-${escapedOrigin}`) as HTMLInputElement | null;
  const destSelect = document.getElementById(`ae-dest-${escapedOrigin}`) as HTMLSelectElement | null;
  const modeSelect = document.getElementById(`ae-mode-${escapedOrigin}`) as HTMLSelectElement | null;

  if (!intervalInput || !destSelect || !modeSelect) return;

  const interval = parseInt(intervalInput.value, 10);
  if (!Number.isInteger(interval) || interval < 1 || interval > 120) {
    showSaveStatus("Interval must be between 1 and 120 minutes", true);
    return;
  }

  const enabled = enabledInput ? enabledInput.checked : true;
  const destination: ExportDestination = { kind: destSelect.value as "download" | "clipboard" };
  const mode: AutoExportMode = modeSelect.value as AutoExportMode;
  const existing = state.settings.autoExportConfigs.find((c) => c.origin === origin);

  // Persist immediately through the background (SF-4) — auto-export edits must
  // not depend on the separate "Save Settings" button.
  try {
    await sendToBackground("autoExportConfigSave", {
      origin,
      enabled,
      intervalMinutes: interval,
      destination,
      mode,
      skipIfUnchanged: existing?.skipIfUnchanged ?? true,
    });
  } catch {
    showSaveStatus("Failed to save auto-export configuration", true);
    return;
  }

  const updatedConfigs = state.settings.autoExportConfigs.map((config) => {
    if (config.origin === origin) {
      return {
        ...config,
        enabled,
        intervalMinutes: interval,
        destination,
        mode,
        updatedAt: new Date().toISOString(),
      };
    }
    return config;
  });

  state.settings = { ...state.settings, autoExportConfigs: updatedConfigs };
  state.editingAutoExportOrigin = null;
  renderAutoExportSection();
  showSaveStatus("Auto-export configuration saved", false);
}

function handleDeleteAutoExport(origin: string): void {
  if (!state.settings) return;

  const updatedConfigs = state.settings.autoExportConfigs.filter((c) => c.origin !== origin);
  state.settings = { ...state.settings, autoExportConfigs: updatedConfigs };

  // Also send delete message to background
  sendToBackground("autoExportConfigDelete", { origin }).catch(() => {
    // Ignore errors — will be persisted on save
  });

  renderAutoExportSection();
}

// ---------------------------------------------------------------------------
// Handlers: Save Settings
// ---------------------------------------------------------------------------

async function handleSaveSettings(): Promise<void> {
  if (!state.settings) return;

  // Gather current form values
  const baseUrl = $input("ai-base-url").value.trim();
  const modelId = $input("ai-model-id").value.trim();
  const apiKey = $input("ai-api-key").value.trim();
  const filenamePattern = $input("export-filename-pattern").value.trim();

  // Gather frontmatter fields
  const frontmatterFields: string[] = [];
  const checkboxes = $("frontmatter-fields").querySelectorAll<HTMLInputElement>("input[type='checkbox']");
  checkboxes.forEach((cb) => {
    if (cb.checked) frontmatterFields.push(cb.value);
  });

  // Client-side validation
  const errors = validateFormFields(baseUrl, filenamePattern);
  clearAllFieldErrors();
  if (errors.length > 0) {
    displayFieldErrors(errors);
    return;
  }

  // Build the complete settings object
  const settingsToSave: Settings = {
    ...state.settings,
    ai: {
      ...state.settings.ai,
      baseUrl,
      modelId,
    },
    export: {
      ...state.settings.export,
      filenamePattern,
      frontmatterFields,
    },
  };

  const btn = $("btn-save-settings") as HTMLButtonElement;
  btn.disabled = true;

  try {
    // Persist through the settings manager (CF-5.2): it validates, handles
    // the sync→local quota fallback, and broadcasts the change to all contexts.
    const saveResponse = await sendToBackground("settingsChanged", settingsToSave);
    if (isMessageOfKind(saveResponse, "settingsSaveResult") && !saveResponse.payload.ok) {
      displayFieldErrors(saveResponse.payload.errors ?? []);
      showSaveStatus("Settings not saved — fix the highlighted fields", true);
      return;
    }

    // Handle API key: store via SecureStore in the background (CF-5.3).
    // The background records the resulting apiKeyRef in settings itself.
    let finalSettings = settingsToSave;
    if (apiKey) {
      const response = await sendToBackground("apiKeySave", { apiKey });
      if (isMessageOfKind(response, "apiKeySaveResult") && response.payload.ok && response.payload.ref) {
        finalSettings = { ...settingsToSave, ai: { ...settingsToSave.ai, apiKeyRef: response.payload.ref } };
        $input("ai-api-key").value = "";
      } else {
        showSaveStatus("Settings saved, but storing the API key failed", true);
        state.settings = settingsToSave;
        renderAll();
        return;
      }
    }

    state.settings = finalSettings;
    showSaveStatus("Settings saved", false);
    renderAll();
  } catch {
    showSaveStatus("Failed to save settings", true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Client-Side Validation
// ---------------------------------------------------------------------------

function validateFormFields(baseUrl: string, filenamePattern: string): FieldError[] {
  const errors: FieldError[] = [];

  // AI base URL: must start with http:// or https:// when non-empty
  if (baseUrl !== "" && !/^https?:\/\//.test(baseUrl)) {
    errors.push({ field: "ai.baseUrl", message: "Base URL must start with http:// or https://" });
  }

  // Filename pattern: must be non-empty
  if (filenamePattern.trim() === "") {
    errors.push({ field: "export.filenamePattern", message: "Filename pattern must not be empty" });
  }

  return errors;
}

function displayFieldErrors(errors: ReadonlyArray<FieldError>): void {
  for (const error of errors) {
    // Map field paths to DOM element IDs
    const elementId = fieldToElementId(error.field);
    const errorEl = document.getElementById(`error-${elementId}`);
    if (errorEl) {
      errorEl.textContent = error.message;
    }
    const inputEl = document.getElementById(elementId);
    if (inputEl) {
      inputEl.classList.add("has-error");
    }
  }
}

function clearAllFieldErrors(): void {
  document.querySelectorAll<HTMLElement>(".field-error").forEach((el) => (el.textContent = ""));
  document.querySelectorAll<HTMLElement>(".has-error").forEach((el) => el.classList.remove("has-error"));
}

function fieldToElementId(field: string): string {
  const map: Record<string, string> = {
    "ai.baseUrl": "ai-base-url",
    "ai.modelId": "ai-model-id",
    "ai.apiKey": "ai-api-key",
    "export.filenamePattern": "export-filename-pattern",
  };
  return map[field] ?? field;
}

// ---------------------------------------------------------------------------
// Status Display
// ---------------------------------------------------------------------------

function showSaveStatus(message: string, isError: boolean): void {
  const el = $("save-status");
  el.textContent = message;
  el.className = `save-status ${isError ? "error" : "success"}`;
  if (!isError) {
    setTimeout(() => {
      el.textContent = "";
      el.className = "save-status";
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str.replace(/[&"'<>]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return ch;
    }
  });
}

// ---------------------------------------------------------------------------
// Skill Library & Personas
// ---------------------------------------------------------------------------

async function loadLibrary(): Promise<void> {
  try {
    const stored = await browser.storage.local.get(LIBRARY_STORAGE_KEY);
    const lib = stored?.[LIBRARY_STORAGE_KEY] as SkillLibrary | undefined;
    if (lib && typeof lib === "object" && lib.schemaVersion === 1) {
      state.library = lib;
    } else {
      state.library = { schemaVersion: 1, skills: [], personas: [], active: { kind: "none" } };
    }
    renderSkillLibrarySection();
  } catch {
    state.library = { schemaVersion: 1, skills: [], personas: [], active: { kind: "none" } };
  }
}

async function saveLibrary(): Promise<void> {
  if (!state.library) return;
  await browser.storage.local.set({ [LIBRARY_STORAGE_KEY]: state.library });
}

function renderSkillLibrarySection(): void {
  if (!state.library) return;

  // Skills list
  const skillsList = $("skills-list");
  if (state.library.skills.length === 0) {
    skillsList.innerHTML = '<p class="empty-list">No skills uploaded yet.</p>';
  } else {
    skillsList.innerHTML = state.library.skills.map((skill) => `
      <div class="skill-item">
        <div class="skill-item-info">
          <div class="skill-item-name">${escapeHtml(skill.name)}</div>
          <div class="skill-item-desc">${escapeHtml(skill.description)}</div>
        </div>
        <button class="btn-small btn-danger" data-action="delete-skill" data-id="${escapeAttr(skill.id)}">Delete</button>
      </div>
    `).join("");

    skillsList.querySelectorAll("[data-action='delete-skill']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.id!;
        handleDeleteSkill(id);
      });
    });
  }

  // Personas list
  const personasList = $("personas-list");
  if (state.library.personas.length === 0) {
    personasList.innerHTML = '<p class="empty-list">No personas created yet.</p>';
  } else {
    personasList.innerHTML = state.library.personas.map((persona) => {
      const skillNames = persona.skillIds
        .map((sid) => state.library!.skills.find((s) => s.id === sid)?.name ?? "?")
        .join(", ");
      return `
        <div class="persona-item">
          <div class="persona-item-info">
            <div class="persona-item-name">${escapeHtml(persona.name)}</div>
            <div class="persona-item-desc">${escapeHtml(skillNames)} (${persona.skillIds.length} skills)</div>
          </div>
          <div class="persona-item-actions">
            <button class="btn-small btn-secondary" data-action="edit-persona" data-id="${escapeAttr(persona.id)}">Edit</button>
            <button class="btn-small btn-danger" data-action="delete-persona" data-id="${escapeAttr(persona.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join("");

    personasList.querySelectorAll("[data-action='edit-persona']").forEach((btn) => {
      btn.addEventListener("click", () => {
        handleEditPersona((btn as HTMLElement).dataset.id!);
      });
    });
    personasList.querySelectorAll("[data-action='delete-persona']").forEach((btn) => {
      btn.addEventListener("click", () => {
        handleDeletePersona((btn as HTMLElement).dataset.id!);
      });
    });
  }
}

function handleSkillUpload(): void {
  const input = $("skill-file-input") as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  input.value = "";

  if (!file.name.endsWith(".md")) {
    showSaveStatus("Only .md files are accepted", true);
    return;
  }
  if (file.size > SKILL_MAX_SIZE) {
    showSaveStatus("Skill file too large (max 512 KB)", true);
    return;
  }
  if (state.library && state.library.skills.length >= MAX_SKILLS) {
    showSaveStatus(`Skill library is full (max ${MAX_SKILLS})`, true);
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    const raw = reader.result as string;
    const result = parseSkillFile(raw);
    if (!result.ok) {
      showSaveStatus(`Skill parse error: ${result.errors.join(", ")}`, true);
      return;
    }

    if (!state.library) return;
    const skill = result.skill;
    const existingIndex = state.library.skills.findIndex((s) => s.name === skill.name);
    const id = existingIndex >= 0 ? state.library.skills[existingIndex].id : `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored: StoredSkill = { ...skill, id, addedAt: existingIndex >= 0 ? state.library.skills[existingIndex].addedAt : new Date().toISOString() };

    let skills: StoredSkill[];
    if (existingIndex >= 0) {
      skills = [...state.library.skills];
      skills[existingIndex] = stored;
    } else {
      skills = [...state.library.skills, stored];
    }

    state.library = { ...state.library, skills };
    await saveLibrary();
    renderSkillLibrarySection();
    showSaveStatus(existingIndex >= 0 ? `Skill "${skill.name}" updated` : `Skill "${skill.name}" added`, false);
  };
  reader.onerror = () => {
    showSaveStatus("Failed to read skill file", true);
  };
  reader.readAsText(file);
}

async function handleDeleteSkill(id: string): Promise<void> {
  if (!state.library) return;
  const skills = state.library.skills.filter((s) => s.id !== id);

  // Remove from personas
  let personas = state.library.personas.map((p) => {
    const filtered = p.skillIds.filter((sid) => sid !== id);
    return filtered.length === p.skillIds.length ? p : { ...p, skillIds: filtered, updatedAt: new Date().toISOString() };
  }).filter((p) => p.skillIds.length > 0);

  // Deactivate if needed
  let active = state.library.active;
  if (active.kind === "skill" && active.skillId === id) {
    active = { kind: "none" };
  } else if (active.kind === "persona") {
    const personaId = active.personaId;
    if (!personas.some((p) => p.id === personaId)) {
      active = { kind: "none" };
    }
  }

  state.library = { ...state.library, skills, personas, active };
  await saveLibrary();
  renderSkillLibrarySection();
}

function handleAddPersona(): void {
  if (!state.library) return;
  if (state.library.personas.length >= MAX_PERSONAS) {
    showSaveStatus(`Persona limit reached (max ${MAX_PERSONAS})`, true);
    return;
  }
  state.editingPersonaId = null;
  showPersonaEditor("Create Persona", "", "", []);
}

function handleEditPersona(id: string): void {
  if (!state.library) return;
  const persona = state.library.personas.find((p) => p.id === id);
  if (!persona) return;
  state.editingPersonaId = id;
  showPersonaEditor("Edit Persona", persona.name, persona.description, [...persona.skillIds]);
}

function showPersonaEditor(title: string, name: string, description: string, selectedIds: string[]): void {
  $("persona-editor-title").textContent = title;
  $input("persona-name").value = name;
  $input("persona-description").value = description;

  // Render skill checkboxes
  const container = $("persona-skill-checkboxes");
  if (!state.library) { container.innerHTML = ""; return; }
  container.innerHTML = state.library.skills.map((s) => {
    const checked = selectedIds.includes(s.id) ? "checked" : "";
    return `<label><input type="checkbox" value="${escapeAttr(s.id)}" ${checked} /> ${escapeHtml(s.name)}</label>`;
  }).join("");

  $("persona-editor").classList.remove("hidden");
  clearFieldErrors(["persona-name"]);
}

function handleCancelPersona(): void {
  $("persona-editor").classList.add("hidden");
  state.editingPersonaId = null;
}

async function handleSavePersona(): Promise<void> {
  if (!state.library) return;

  const name = $input("persona-name").value.trim();
  const description = $input("persona-description").value.trim();
  const checkboxes = $("persona-skill-checkboxes").querySelectorAll("input[type='checkbox']:checked");
  const skillIds = Array.from(checkboxes).map((cb) => (cb as HTMLInputElement).value);

  // Validate
  clearFieldErrors(["persona-name"]);
  if (!name) {
    showFieldError("persona-name", "Name is required");
    return;
  }
  if (skillIds.length === 0) {
    showFieldError("persona-name", "Select at least one skill");
    return;
  }

  const now = new Date().toISOString();

  if (state.editingPersonaId) {
    // Update existing
    const personas = state.library.personas.map((p) =>
      p.id === state.editingPersonaId ? { ...p, name, description, skillIds, updatedAt: now } : p
    );
    state.library = { ...state.library, personas };
  } else {
    // Create new
    const persona: Persona = {
      id: `persona-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      skillIds,
      createdAt: now,
      updatedAt: now,
    };
    state.library = { ...state.library, personas: [...state.library.personas, persona] };
  }

  const wasEditing = state.editingPersonaId !== null;
  await saveLibrary();
  $("persona-editor").classList.add("hidden");
  state.editingPersonaId = null;
  renderSkillLibrarySection();
  showSaveStatus(wasEditing ? "Persona updated" : "Persona created", false);
}

async function handleDeletePersona(id: string): Promise<void> {
  if (!state.library) return;
  const personas = state.library.personas.filter((p) => p.id !== id);
  let active = state.library.active;
  if (active.kind === "persona" && active.personaId === id) {
    active = { kind: "none" };
  }
  state.library = { ...state.library, personas, active };
  await saveLibrary();
  renderSkillLibrarySection();
}

function showFieldError(field: string, message: string): void {
  const el = document.getElementById(`error-${field}`);
  if (el) el.textContent = message;
}

function clearFieldErrors(fields: string[]): void {
  for (const field of fields) {
    const el = document.getElementById(`error-${field}`);
    if (el) el.textContent = "";
  }
}
