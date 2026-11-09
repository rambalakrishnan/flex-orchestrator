// BrowserClient: job creation, developer context, token preview, fragment polling, and job-detail dialog wiring.
const form = document.getElementById("create-job-form");
const formStatus = document.getElementById("form-status");
const jobList = document.getElementById("job-list");
const dialog = document.getElementById("job-dialog");
const dialogBody = document.getElementById("job-dialog-body");
const turnsContainer = document.getElementById("turns");
const turnTemplate = document.getElementById("turn-template");
const developerFilesInput = document.getElementById("developer-files");
const judgeEnabledCheckbox = document.getElementById("judge-enabled");
const judgePanel = document.getElementById("judge-panel");
const judgeInjectFailCheckbox = document.getElementById("judge-inject-fail");
const judgeInjectPassCheckbox = document.getElementById("judge-inject-pass");
const healthCheckButton = document.getElementById("health-check");
const healthStatus = document.getElementById("health-status");

const MAX_AUTO_CONTINUATIONS = 3;
const MAX_AUTO_RETRIES = 1;
const GRADE_THRESHOLDS = Object.freeze({ A: 90, B: 80, C: 70, D: 60, F: 50 });

const value = (id) => document.getElementById(id).value;

function setStatus(message) {
  formStatus.textContent = message;
}

function describeError(error) {
  return error instanceof Error && error.message.length > 0 ? error.message : "request failed.";
}

function readRequiredValue(id, label) {
  const raw = value(id).trim();
  if (raw.length === 0) throw new Error(label + " is required.");
  return raw;
}

function readPositiveInteger(id, label) {
  const parsed = Number(value(id));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(label + " must be a positive integer.");
  }
  return parsed;
}

function checkedRadioValue(name, label) {
  const checked = document.querySelector('input[name="' + name + '"]:checked');
  if (!(checked instanceof HTMLInputElement)) {
    throw new Error("Select a " + label + ".");
  }
  return checked.value;
}

function formatErrorDetailValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function formatErrorDetails(details) {
  if (details === null || details === undefined) return "";
  if (typeof details !== "object") return formatErrorDetailValue(details);
  if (Array.isArray(details)) {
    if (details.length === 0) return "";
    return details.map(formatErrorDetailValue).join(", ");
  }
  const entries = Object.entries(details);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => key + "=" + formatErrorDetailValue(value))
    .join(", ");
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    const error = body !== null && typeof body === "object" ? body.error : null;
    const message =
      error !== null &&
      typeof error === "object" &&
      typeof error.message === "string" &&
      error.message.length > 0
        ? error.message
        : null;
    const code =
      error !== null &&
      typeof error === "object" &&
      typeof error.code === "string" &&
      error.code.length > 0
        ? error.code
        : null;
    const detailsText =
      error !== null && typeof error === "object" ? formatErrorDetails(error.details) : "";
    let text = message;
    if (text === null && code !== null) text = code;
    if (
      text === null &&
      body !== null &&
      typeof body === "object" &&
      typeof body.message === "string" &&
      body.message.length > 0
    ) {
      text = body.message;
    }
    if (text !== null) {
      if (code !== null && message !== null) text = "[" + code + "] " + text;
      if (detailsText.length > 0) text += " \u2014 " + detailsText;
      return text;
    }
  } catch {
    // Non-JSON error bodies use the status line below.
  }
  return "Request failed with status " + response.status + ".";
}

/**
 * Uploads each file to /api/files and returns the resulting provider file IDs.
 * Throws a readable Error when the service rejects or cannot parse an upload.
 */
async function uploadFiles(files, turnIndex) {
  const uploadedFileIds = [];
  const list = files === null || files === undefined ? [] : Array.from(files);
  for (const file of list) {
    const body = new FormData();
    body.append("file", file, file.name);
    if (turnIndex !== undefined) body.append("turnIndex", String(turnIndex));

    let response;
    try {
      response = await fetch("/api/files", { method: "POST", body });
    } catch {
      throw new Error('Upload failed for "' + file.name + '": network request failed.');
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      // A non-JSON body is reported through the status branch below.
    }

    if (!response.ok) {
      const resultMessage =
        result !== null && typeof result.message === "string" && result.message.length > 0
          ? result.message
          : null;
      const errorEnvelopeMessage =
        result !== null &&
        typeof result.error === "object" &&
        result.error !== null &&
        typeof result.error.message === "string" &&
        result.error.message.length > 0
          ? result.error.message
          : null;
      const detail =
        resultMessage ??
        errorEnvelopeMessage ??
        "Request failed with status " + response.status + ".";
      throw new Error('Upload failed for "' + file.name + '": ' + detail);
    }

    if (result?.kind === "uploaded") {
      const fileId = result.file?.fileId;
      if (typeof fileId !== "string" || fileId.length === 0) {
        throw new Error(
          'Upload failed for "' + file.name + '": response is missing the file identifier.',
        );
      }
      uploadedFileIds.push(fileId);
      continue;
    }

    if (result?.kind === "rejected") {
      const detail =
        typeof result.message === "string" && result.message.length > 0
          ? result.message
          : result.code;
      throw new Error('Upload rejected for "' + file.name + '": ' + detail + ".");
    }

    throw new Error(
      'Upload failed for "' + file.name + '": unexpected response from the file service.',
    );
  }
  return uploadedFileIds;
}

function turnBlocks() {
  return Array.from(turnsContainer.querySelectorAll(".turn-block"));
}

/** Reassigns 1-based, gap-free turn indices after every add or remove. */
function renumberTurns() {
  const blocks = turnBlocks();
  blocks.forEach((block, index) => {
    const turnIndex = index + 1;
    block.dataset.turnIndex = String(turnIndex);

    const title = block.querySelector(".turn-block-title");
    if (title !== null) title.textContent = "Turn " + turnIndex;

    const prompt = block.querySelector(".turn-prompt");
    if (prompt !== null) {
      prompt.id = "turn-" + turnIndex + "-prompt";
      prompt.setAttribute("aria-label", "Turn " + turnIndex + " prompt");
      const promptLabel = prompt.closest("p")?.querySelector("label") ?? null;
      if (promptLabel !== null) promptLabel.htmlFor = prompt.id;
    }

    const files = block.querySelector(".turn-files");
    if (files !== null) {
      files.id = "turn-" + turnIndex + "-files";
      const filesLabel = files.closest("p")?.querySelector("label") ?? null;
      if (filesLabel !== null) filesLabel.htmlFor = files.id;
    }

    const pinned = block.querySelector(".turn-pinned");
    if (pinned instanceof HTMLInputElement) {
      pinned.id = "turn-" + turnIndex + "-pinned";
      pinned.setAttribute("aria-label", "Pin turn " + turnIndex + " in replay window");
    }
  });
}

function addTurn() {
  turnsContainer.appendChild(turnTemplate.content.cloneNode(true));
  renumberTurns();
  const blocks = turnBlocks();
  const lastBlock = blocks[blocks.length - 1];
  const prompt = lastBlock === undefined ? null : lastBlock.querySelector(".turn-prompt");
  if (prompt !== null) prompt.focus();
}

function removeTurn(button) {
  const block = button.closest(".turn-block");
  if (block === null) return;
  block.remove();
  renumberTurns();
}

/** Restores the composer to a single empty turn after a successful create. */
function resetTurns() {
  const blocks = turnBlocks();
  for (let index = 1; index < blocks.length; index += 1) blocks[index].remove();
  let firstBlock = turnsContainer.querySelector(".turn-block");
  if (firstBlock === null) {
    turnsContainer.appendChild(turnTemplate.content.cloneNode(true));
    firstBlock = turnsContainer.querySelector(".turn-block");
  }
  const prompt = firstBlock === null ? null : firstBlock.querySelector(".turn-prompt");
  if (prompt !== null) prompt.value = "";
  const tokenResult = firstBlock === null ? null : firstBlock.querySelector(".turn-token-result");
  if (tokenResult !== null) setTurnTokenResult(tokenResult, "");
  const countButton = firstBlock === null ? null : firstBlock.querySelector(".turn-count");
  if (countButton instanceof HTMLButtonElement) countButton.disabled = false;
  const pinned = firstBlock === null ? null : firstBlock.querySelector(".turn-pinned");
  if (pinned instanceof HTMLInputElement) pinned.checked = false;
  renumberTurns();
}

/** Non-empty turn prompts become gap-free initial turns; empty blocks are skipped. */
function collectTurnSpecs() {
  const specs = [];
  for (const block of turnBlocks()) {
    const prompt = block.querySelector(".turn-prompt");
    const promptText = prompt === null ? "" : prompt.value;
    if (promptText.trim().length === 0) continue;
    const filesInput = block.querySelector(".turn-files");
    const files =
      filesInput === null || filesInput.files === null ? [] : Array.from(filesInput.files);
    const pinnedInput = block.querySelector(".turn-pinned");
    const pinnedInReplay = pinnedInput instanceof HTMLInputElement && pinnedInput.checked;
    specs.push({ turnIndex: specs.length + 1, promptText, files, pinnedInReplay });
  }
  if (specs.length === 0) {
    throw new Error("Add at least one turn prompt before creating the job.");
  }
  return specs;
}

function buildJudgeConfig() {
  if (!judgeEnabledCheckbox.checked) return { enabled: false };

  const model = readRequiredValue("judge-model", "Judge model");
  const secretName = readRequiredValue("judge-secret", "Judge API Key (Env Var Name)");
  const apiRoot = readRequiredValue("judge-base-url", "Judge base URL");
  const provider = apiRoot.toLowerCase().includes("openrouter") ? "openrouter" : "openai";
  const transport = checkedRadioValue("judge-transport", "judge transport");
  const historyMode = checkedRadioValue("judge-history", "judge history mode");
  const fileDeliveryMode = checkedRadioValue(
    "judge-file-delivery",
    "judge file delivery mode",
  );
  const grade = value("judge-grade");
  const maxGradeThreshold = GRADE_THRESHOLDS[grade];
  if (typeof maxGradeThreshold !== "number") {
    throw new Error("Select a valid minimum acceptable grade.");
  }

  return {
    enabled: true,
    provider,
    apiRoot,
    secretName,
    model,
    transport,
    historyMode,
    fileDeliveryMode,
    injectOnFail: judgeInjectFailCheckbox.checked,
    injectOnPass: judgeInjectPassCheckbox.checked,
    developerPrompt: value("judge-prompt"),
    includePrior: false,
    maxGradeThreshold,
  };
}

function buildCreateJobCommand(params) {
  return {
    jobId: "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: readRequiredValue("job-title", "Title"),
    config: {
      model: readRequiredValue("job-model", "Model"),
      reasoningEffort: value("job-reasoning"),
      maxOutputTokens: readPositiveInteger("job-max-output-tokens", "Max output tokens"),
      cacheTtl: value("job-cache-ttl"),
      webSearch: document.getElementById("job-web-search").checked,
      maxContinuations: MAX_AUTO_CONTINUATIONS,
      maxAutoRetries: MAX_AUTO_RETRIES,
      developerPrompt: params.developerPrompt,
      developerFileIds: params.developerFileIds,
      judge: buildJudgeConfig(),
    },
    initialTurns: params.initialTurns,
    initialPreviousResponseId: value("job-previous-response-id").trim() || null,
  };
}

/** Reads and validates the preview options shared by every turn count. */
function readTokenPreviewOptions() {
  return {
    model: readRequiredValue("job-model", "Model"),
    developerPrompt: value("developer-prompt"),
    maxOutputTokens: readPositiveInteger("job-max-output-tokens", "Max output tokens"),
    reasoningEffort: value("job-reasoning"),
    webSearch: document.getElementById("job-web-search").checked,
  };
}

/** Posts one pending-turn body and resolves with the validated preview response. */
async function requestTokenPreview(body) {
  const response = await fetch("/api/tokens/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  let preview = null;
  try {
    preview = await response.json();
  } catch {
    throw new Error("token preview response was not JSON.");
  }
  if (preview === null || typeof preview !== "object") {
    throw new Error("token preview response was not a JSON object.");
  }
  if (
    typeof preview.projectedTotalInputTokens !== "number" ||
    !Number.isFinite(preview.projectedTotalInputTokens)
  ) {
    throw new Error("token preview response is missing projectedTotalInputTokens.");
  }
  return preview;
}

/** Formats one admitted/rejected preview as a single plain-text line. */
function describeTokenPreview(preview) {
  let text = preview.projectedTotalInputTokens + " input tokens";
  const admission = preview.admission;
  if (admission !== null && typeof admission === "object" && admission.kind === "admitted") {
    const contextTier =
      typeof admission.contextTier === "string" ? admission.contextTier : "unknown";
    text += " \u2014 admitted (context: " + contextTier + ")";
  } else if (
    admission !== null &&
    typeof admission === "object" &&
    admission.kind === "rejected"
  ) {
    text += " \u2014 rejected (" + admission.reason + ")";
    if (typeof admission.message === "string" && admission.message.length > 0) {
      text += ": " + admission.message;
    }
  } else {
    text += " \u2014 admission unavailable";
  }
  return text;
}

function updateJudgePanel() {
  const enabled = judgeEnabledCheckbox.checked;
  judgePanel.hidden = !enabled;
  judgePanel.setAttribute("aria-disabled", String(!enabled));
}

/** Reads the 1-based turn index stamped on a rendered turn block. */
function turnIndexOfBlock(block) {
  const parsedIndex = Number(block.dataset.turnIndex);
  return Number.isSafeInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : null;
}

/** Writes one turn's projected count into that turn card's status line. */
function setTurnTokenResult(resultElement, message, state) {
  resultElement.textContent = message;
  if (state === "ok" || state === "error") resultElement.dataset.state = state;
  else delete resultElement.dataset.state;
}

/**
 * Counts one turn's pending generation request, including the developer context
 * that every generation request carries. Only this turn's button is disabled
 * while its uploads and provider preview run.
 */
async function countTurnTokens(button) {
  const block = button.closest(".turn-block");
  if (block === null) return;
  const resultElement = block.querySelector(".turn-token-result");
  if (resultElement === null) return;

  button.disabled = true;
  setTurnTokenResult(resultElement, "Counting tokens\u2026");

  try {
    const options = readTokenPreviewOptions();
    const turnIndex = turnIndexOfBlock(block);
    if (turnIndex === null) throw new Error("Turn index is missing.");

    const prompt = block.querySelector(".turn-prompt");
    const promptText = prompt === null ? "" : prompt.value;
    const filesInput = block.querySelector(".turn-files");
    const turnFiles = filesInput === null || filesInput.files === null ? [] : filesInput.files;

    const [developerFileIds, attachmentFileIds] = await Promise.all([
      uploadFiles(developerFilesInput.files),
      uploadFiles(turnFiles, turnIndex),
    ]);

    const preview = await requestTokenPreview({
      model: options.model,
      promptText,
      developerPrompt: options.developerPrompt,
      developerFileIds,
      attachmentFileIds,
      maxOutputTokens: options.maxOutputTokens,
      reasoningEffort: options.reasoningEffort,
      webSearch: options.webSearch,
    });

    const rejected = preview.admission?.kind !== "admitted";
    setTurnTokenResult(resultElement, describeTokenPreview(preview), rejected ? "error" : "ok");
  } catch (error) {
    setTurnTokenResult(resultElement, "Error: " + describeError(error), "error");
  } finally {
    button.disabled = false;
  }
}

let creatingJob = false;

function positiveTurnIndexOrNull(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Reports the first submitted response ID returned by a successful create. */
function describeCreatedJobState(state) {
  if (state !== null && typeof state === "object") {
    const activeAttempt = state.activeAttempt;
    if (activeAttempt !== null && typeof activeAttempt === "object") {
      const responseId = activeAttempt.responseId;
      if (typeof responseId === "string" && responseId.length > 0) {
        const job = state.job;
        const turnIndex =
          positiveTurnIndexOrNull(activeAttempt.turnIndex) ??
          (job !== null && typeof job === "object"
            ? positiveTurnIndexOrNull(job.currentTurnIndex)
            : null);
        if (turnIndex !== null) {
          return (
            "Job created. Turn " +
            turnIndex +
            " submitted (response " +
            responseId +
            ")."
          );
        }
      }
    }
  }
  return "Job created.";
}

async function createJob(event) {
  event.preventDefault();
  if (creatingJob) return;
  creatingJob = true;
  setStatus("Creating job\u2026");
  try {
    const turnSpecs = collectTurnSpecs();
    readRequiredValue("job-title", "Title");
    readRequiredValue("job-model", "Model");
    readPositiveInteger("job-max-output-tokens", "Max output tokens");
    buildJudgeConfig();

    const developerPrompt = value("developer-prompt");
    const developerFileIds = await uploadFiles(developerFilesInput.files);
    const initialTurns = [];
    for (const turnSpec of turnSpecs) {
      const attachmentFileIds = await uploadFiles(turnSpec.files, turnSpec.turnIndex);
      initialTurns.push({
        turnIndex: turnSpec.turnIndex,
        promptText: turnSpec.promptText,
        attachmentFileIds,
        pinnedInReplay: turnSpec.pinnedInReplay === true,
      });
    }

    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCreateJobCommand({ developerPrompt, developerFileIds, initialTurns })),
    });
    if (!response.ok) {
      setStatus("Error: " + (await errorMessage(response)));
      return;
    }

    let state = null;
    try {
      state = await response.json();
    } catch {
      // A missing or malformed state body still means the job was accepted.
    }

    form.reset();
    resetTurns();
    updateJudgePanel();
    setStatus(describeCreatedJobState(state));
    await refreshJobs();
  } catch (error) {
    setStatus("Error: " + describeError(error));
  } finally {
    creatingJob = false;
  }
}

async function refreshJobs() {
  try {
    const response = await fetch("/api/jobs/fragment");
    if (response.ok) jobList.innerHTML = await response.text();
  } catch {
    // Keep the last rendered list when the fragment request fails.
  }
}

const DETAIL_REFRESH_INTERVAL_MS = 12000;

let detailJobId = null;
let detailRefreshTimer = null;
let dialogActionRunning = false;

const expandedContentIds = new Set();

function expandedKey(expandId) {
  return detailJobId === null ? expandId : detailJobId + "\n" + expandId;
}

function setExpandToggleState(toggle, open) {
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.textContent = open ? "Show less" : "Show more";
}

function applyExpandState(wrapper) {
  const expandId = wrapper.getAttribute("data-expand-id");
  const toggle = wrapper.querySelector(".expand-toggle");
  const body = wrapper.querySelector(".expandable-body");
  if (!(toggle instanceof HTMLButtonElement) || !(body instanceof HTMLElement)) return;
  const open = expandId !== null && expandedContentIds.has(expandedKey(expandId));
  if (open) wrapper.setAttribute("data-open", "true");
  else wrapper.removeAttribute("data-open");
  setExpandToggleState(toggle, open);
  // Hide the toggle entirely when the content fits without clamping. Measure
  // only while collapsed: an open body reports its full height as fitting.
  const fits = !open && body.scrollHeight <= body.clientHeight + 1;
  body.dataset.fits = fits ? "true" : "false";
  toggle.hidden = fits;
}

function syncExpandToggles() {
  for (const wrapper of dialogBody.querySelectorAll(".expandable")) {
    if (wrapper instanceof HTMLElement) applyExpandState(wrapper);
  }
}

function stopDetailRefresh() {
  if (detailRefreshTimer !== null) {
    clearInterval(detailRefreshTimer);
    detailRefreshTimer = null;
  }
}

function startDetailRefresh() {
  stopDetailRefresh();
  const jobId = detailJobId;
  if (jobId === null) return;
  detailRefreshTimer = setInterval(() => {
    if (!dialog.open || detailJobId !== jobId) {
      stopDetailRefresh();
      return;
    }
    if (dialogActionRunning) return;
    void refreshDetailFragment(jobId, true);
  }, DETAIL_REFRESH_INTERVAL_MS);
}

async function refreshDetailFragment(jobId, silent) {
  if (silent && dialogActionRunning) return;
  try {
    const response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/fragment");
    if (detailJobId !== jobId) return;
    if (silent && dialogActionRunning) return;
    if (response.ok) {
      const fragment = await response.text();
      if (detailJobId !== jobId) return;
      const healthRegion = dialogBody.querySelector(".dialog-health");
      const jsonlRegion = dialogBody.querySelector(".dialog-jsonl");
      const actionError = dialogBody.querySelector(".dialog-action-error");
      dialogBody.innerHTML = fragment;
      if (jsonlRegion instanceof HTMLElement) placeDialogRegion(jsonlRegion);
      if (healthRegion instanceof HTMLElement) placeDialogRegion(healthRegion);
      if (actionError instanceof HTMLElement) dialogBody.prepend(actionError);
      syncExpandToggles();
      return;
    }
    if (!silent) {
      dialogBody.textContent = "Error: " + (await errorMessage(response));
    }
  } catch {
    if (!silent && detailJobId === jobId) {
      dialogBody.textContent = "Error: network request failed.";
    }
  }
}

async function openJobDetail(jobId) {
  detailJobId = jobId;
  stopDetailRefresh();
  dialogBody.textContent = "Loading\u2026";
  if (!dialog.open) dialog.showModal();
  await refreshDetailFragment(jobId, false);
  if (detailJobId === jobId) startDetailRefresh();
}

function describeHealthProbe(probe) {
  if (probe === null || typeof probe !== "object") return "unavailable";

  const parts = [];
  parts.push(probe.ok === true ? "ok" : "error");
  if (typeof probe.latencyMs === "number" && Number.isFinite(probe.latencyMs)) {
    parts.push(Math.max(0, Math.round(probe.latencyMs)) + " ms");
  }

  const status = probe.status;
  if (status !== null && typeof status === "object") {
    const indicator =
      typeof status.indicator === "string" && status.indicator.length > 0
        ? status.indicator
        : "unknown";
    const description = typeof status.description === "string" ? status.description : "";
    parts.push(
      "status: " + indicator + (description.length > 0 ? " \u2014 " + description : ""),
    );
  } else {
    parts.push("status: not reported");
  }

  const models = probe.models;
  if (models !== null && typeof models === "object") {
    let modelsText = models.ok === true ? "models: ok" : "models: unavailable";
    if (typeof models.count === "number" && Number.isFinite(models.count)) {
      modelsText += " (" + models.count + ")";
    }
    if (models.modelPresent === true) modelsText += ", model present";
    else if (models.modelPresent === false) modelsText += ", model missing";
    if (typeof models.error === "string" && models.error.length > 0) {
      modelsText += ", " + models.error;
    }
    parts.push(modelsText);
  }

  if (typeof probe.error === "string" && probe.error.length > 0) {
    parts.push("error: " + probe.error);
  }
  return parts.join(" \u00b7 ");
}

function healthLines(health) {
  const mainProbe = health !== null && typeof health === "object" ? health.main : null;
  const judgeProbe = health !== null && typeof health === "object" ? health.judge : null;
  const lines = [{ label: "Main", text: describeHealthProbe(mainProbe) }];

  if (judgeProbe === null || judgeProbe === undefined) {
    lines.push({ label: "Judge", text: "n/a — open a job for the judge probe" });
  } else if (typeof judgeProbe === "object" && judgeProbe.skipped === true) {
    lines.push({ label: "Judge", text: "skipped (judge disabled)" });
  } else {
    lines.push({ label: "Judge", text: describeHealthProbe(judgeProbe) });
  }
  return lines;
}

function healthState(health) {
  if (
    health === null ||
    typeof health !== "object" ||
    health.main === null ||
    typeof health.main !== "object"
  ) {
    return "error";
  }
  const probes = [health.main];
  if (health.judge !== null && typeof health.judge === "object") probes.push(health.judge);
  for (const probe of probes) {
    if (probe.skipped === true) continue;
    if (probe.ok !== true) return "error";
  }
  return "ok";
}

/**
 * Places an action-result region where the operator can see it: directly
 * after the detail header (above the deliverables), falling back to the end
 * of the dialog when no header is present.
 */
function placeDialogRegion(region) {
  const header = dialogBody.querySelector(".job-detail-header");
  if (!(header instanceof HTMLElement)) {
    dialogBody.appendChild(region);
    return;
  }
  const parent = header.parentNode;
  if (!(parent instanceof HTMLElement)) {
    dialogBody.appendChild(region);
    return;
  }
  if (header.nextSibling !== null) {
    parent.insertBefore(region, header.nextSibling);
  } else {
    parent.appendChild(region);
  }
}

function ensureDialogHealthRegion() {
  const existing = dialogBody.querySelector(".dialog-health");
  if (existing instanceof HTMLElement) {
    existing.hidden = false;
    return existing;
  }
  const region = document.createElement("section");
  region.className = "dialog-health";
  region.hidden = false;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  placeDialogRegion(region);
  return region;
}

function createHealthProbeRow(labelText, valueText) {
  const row = document.createElement("div");
  row.className = "health-probe";
  const label = document.createElement("span");
  label.className = "health-label";
  label.textContent = labelText;
  const value = document.createElement("span");
  value.textContent = valueText;
  row.append(label, value);
  return row;
}

function renderDialogHealth(region, health) {
  const title = document.createElement("h3");
  title.className = "dialog-health-title";
  title.textContent = "Provider health";
  const rows = healthLines(health).map((line) =>
    createHealthProbeRow(line.label, line.text),
  );
  region.replaceChildren(title, ...rows);
  region.dataset.state = healthState(health);
}

async function runDialogHealthCheck(jobId) {
  const region = ensureDialogHealthRegion();
  region.dataset.state = "";
  region.textContent = "Checking provider health\u2026";
  region.scrollIntoView({ block: "nearest" });
  try {
    const response = await fetch("/api/health?jobId=" + encodeURIComponent(jobId));
    if (!response.ok) {
      region.textContent = "Error: " + (await errorMessage(response));
      region.dataset.state = "error";
      return;
    }
    let health = null;
    try {
      health = await response.json();
    } catch {
      throw new Error("health response was not JSON.");
    }
    if (health === null || typeof health !== "object") {
      throw new Error("health response was not a JSON object.");
    }
    renderDialogHealth(region, health);
  } catch (error) {
    region.textContent = "Error: " + describeError(error);
    region.dataset.state = "error";
  }
}

function clearDialogActionError() {
  const region = dialogBody.querySelector(".dialog-action-error");
  if (region !== null) region.remove();
}

function showDialogActionError(message) {
  let region = dialogBody.querySelector(".dialog-action-error");
  if (!(region instanceof HTMLElement)) {
    region = document.createElement("p");
    region.className = "dialog-action-error error-text";
    region.setAttribute("role", "alert");
    dialogBody.prepend(region);
  }
  region.textContent = "Error: " + message;
}

/**
 * Parses an NDJSON export line-by-line. Blank lines are ignored; a malformed or
 * non-object line fails with its 1-based source line so operators can find the
 * exact record. This is the client-side counterpart of the streaming export.
 */
function parseJsonl(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Invalid JSONL at line " + (index + 1) + ".");
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("JSONL line " + (index + 1) + " is not an object.");
    }
    records.push(record);
  }
  return records;
}

function ensureJsonlRegion() {
  const existing = dialogBody.querySelector(".dialog-jsonl");
  if (existing instanceof HTMLElement) {
    existing.hidden = false;
    return existing;
  }
  const region = document.createElement("section");
  region.className = "dialog-jsonl";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  placeDialogRegion(region);
  return region;
}

function renderJsonlSummary(region, records) {
  const counts = new Map();
  let incomplete = false;
  for (const record of records) {
    const type = typeof record.type === "string" ? record.type : "unknown";
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === "export_incomplete") incomplete = true;
  }

  const title = document.createElement("h3");
  title.className = "dialog-jsonl-title";
  title.textContent = "JSONL records";
  const lines = [];
  for (const type of [
    "job",
    "turn",
    "attempt",
    "judge_call",
    "export_incomplete",
  ]) {
    const count = counts.get(type);
    if (count !== undefined) lines.push(type + ": " + count);
  }
  const total = document.createElement("p");
  total.textContent = "Total records: " + records.length + (lines.length > 0 ? " — " + lines.join(", ") : "");
  const body = [title, total];
  if (incomplete) {
    const warning = document.createElement("p");
    warning.className = "error-text";
    warning.textContent = "This stream ended with an export_incomplete marker; records are missing.";
    body.push(warning);
  }
  region.replaceChildren(...body);
  region.dataset.state = incomplete ? "error" : "ok";
}

async function runJsonlInspect(jobId) {
  const region = ensureJsonlRegion();
  region.dataset.state = "";
  region.textContent = "Loading JSONL\u2026";
  region.scrollIntoView({ block: "nearest" });
  try {
    const response = await fetch(
      "/api/jobs/" + encodeURIComponent(jobId) + "/export/jsonl",
    );
    if (!response.ok) {
      region.textContent = "Error: " + (await errorMessage(response));
      region.dataset.state = "error";
      return;
    }
    const records = parseJsonl(await response.text());
    renderJsonlSummary(region, records);
  } catch (error) {
    region.textContent = "Error: " + describeError(error);
    region.dataset.state = "error";
  }
}

async function handleDialogAction(control) {
  if (!(control instanceof HTMLElement)) return;
  const action = control.getAttribute("data-action");
  if (
    action !== "pause-job" &&
    action !== "resume-job" &&
    action !== "retry-turn" &&
    action !== "toggle-pin" &&
    action !== "check-health" &&
    action !== "inspect-jsonl"
  ) {
    return;
  }
  if (dialogActionRunning) return;

  const jobId = control.getAttribute("data-job-id") ?? detailJobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    showDialogActionError("Job identifier is missing.");
    return;
  }

  const button = control instanceof HTMLButtonElement ? control : null;
  dialogActionRunning = true;
  clearDialogActionError();
  if (button !== null) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }

  try {
    if (action === "check-health") {
      await runDialogHealthCheck(jobId);
      return;
    }
    if (action === "inspect-jsonl") {
      await runJsonlInspect(jobId);
      return;
    }

    let response;
    if (action === "pause-job") {
      response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/pause", {
        method: "POST",
      });
    } else if (action === "resume-job") {
      response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/resume", {
        method: "POST",
      });
    } else if (action === "toggle-pin") {
      const rawTurnIndex = control.getAttribute("data-turn-index");
      const turnIndex = Number(rawTurnIndex);
      if (rawTurnIndex === null || !Number.isSafeInteger(turnIndex) || turnIndex <= 0) {
        throw new Error("Turn index is missing or invalid.");
      }
      const pinned = control.getAttribute("data-pinned") !== "true";
      response = await fetch(
        "/api/jobs/" +
          encodeURIComponent(jobId) +
          "/turns/" +
          encodeURIComponent(String(turnIndex)) +
          "/pin",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned }),
        },
      );
    } else {
      const rawTurnIndex = control.getAttribute("data-turn-index");
      const turnIndex = Number(rawTurnIndex);
      if (rawTurnIndex === null || !Number.isSafeInteger(turnIndex) || turnIndex <= 0) {
        throw new Error("Turn index is missing or invalid.");
      }
      response = await fetch(
        "/api/jobs/" +
          encodeURIComponent(jobId) +
          "/turns/" +
          encodeURIComponent(String(turnIndex)) +
          "/retry",
        { method: "POST" },
      );
    }

    if (!response.ok) {
      showDialogActionError(await errorMessage(response));
      return;
    }

    if (detailJobId === jobId) {
      await refreshDetailFragment(jobId, false);
    }
    await refreshJobs();
  } catch (error) {
    showDialogActionError(describeError(error));
  } finally {
    dialogActionRunning = false;
    if (button !== null) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function checkHealth() {
  if (
    !(healthCheckButton instanceof HTMLButtonElement) ||
    !(healthStatus instanceof HTMLElement)
  ) {
    return;
  }

  healthCheckButton.disabled = true;
  healthCheckButton.setAttribute("aria-busy", "true");
  healthStatus.hidden = false;
  healthStatus.dataset.state = "";
  healthStatus.textContent = "Checking providers\u2026";

  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      healthStatus.textContent = "Error: " + (await errorMessage(response));
      healthStatus.dataset.state = "error";
      return;
    }
    let health = null;
    try {
      health = await response.json();
    } catch {
      throw new Error("health response was not JSON.");
    }
    if (health === null || typeof health !== "object") {
      throw new Error("health response was not a JSON object.");
    }

    const summary = healthLines(health)
      .map((line) => line.label + ": " + line.text)
      .join(" \u00b7 ");
    healthStatus.textContent = summary;
    healthStatus.dataset.state = healthState(health);
  } catch (error) {
    healthStatus.textContent = "Error: " + describeError(error);
    healthStatus.dataset.state = "error";
  } finally {
    healthCheckButton.disabled = false;
    healthCheckButton.removeAttribute("aria-busy");
  }
}

document.getElementById("add-turn").addEventListener("click", addTurn);
turnsContainer.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const countButton = event.target.closest(".turn-count");
  if (countButton instanceof HTMLButtonElement) {
    void countTurnTokens(countButton);
    return;
  }
  const removeButton = event.target.closest(".turn-remove");
  if (removeButton !== null) removeTurn(removeButton);
});
judgeEnabledCheckbox.addEventListener("change", updateJudgePanel);
form.addEventListener("submit", createJob);
jobList.addEventListener("click", (event) => {
  const card = event.target instanceof Element ? event.target.closest(".job-card") : null;
  const jobId = card === null ? null : card.getAttribute("data-job-id");
  if (jobId) openJobDetail(jobId);
});

dialogBody.addEventListener("submit", (event) => {
  const formElement = event.target instanceof Element ? event.target.closest(".judge-config-edit") : null;
  if (!(formElement instanceof HTMLFormElement)) return;
  event.preventDefault();
  void saveJudgeConfig(formElement);
});

async function saveJudgeConfig(formElement) {
  const jobId = formElement.getAttribute("data-job-id") ?? detailJobId;
  const status = formElement.querySelector(".judge-config-edit-status");
  const fields = new FormData(formElement);
  const read = (name) => {
    const raw = fields.get(name);
    return typeof raw === "string" ? raw : "";
  };
  const setStatusMessage = (message) => {
    if (status instanceof HTMLElement) status.textContent = message;
  };
  if (typeof jobId !== "string" || jobId.length === 0) {
    setStatusMessage("Error: Job identifier is missing.");
    return;
  }
  const maxGradeThreshold = Number(read("maxGradeThreshold"));
  if (!Number.isFinite(maxGradeThreshold)) {
    setStatusMessage("Error: Minimum grade must be a number.");
    return;
  }
  setStatusMessage("Saving judge config\u2026");
  try {
    const response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/judge-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        provider: read("provider"),
        apiRoot: read("apiRoot"),
        secretName: read("secretName"),
        model: read("model").trim(),
        transport: read("transport"),
        historyMode: read("historyMode"),
        fileDeliveryMode: read("fileDeliveryMode"),
        includePrior: read("includePrior") === "true",
        maxGradeThreshold,
        injectOnFail: read("injectOnFail") === "true",
        injectOnPass: read("injectOnPass") === "true",
        developerPrompt: read("developerPrompt"),
      }),
    });
    if (!response.ok) {
      setStatusMessage("Error: " + (await errorMessage(response)));
      return;
    }
    setStatusMessage("Judge config saved. Future turns will use it.");
    await refreshDetailFragment(jobId, false);
    await refreshJobs();
  } catch (error) {
    setStatusMessage("Error: " + describeError(error));
  }
}
dialogBody.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const toggle = event.target.closest(".expand-toggle");
  if (toggle instanceof HTMLButtonElement) {
    const wrapper = toggle.closest(".expandable");
    const expandId = wrapper?.getAttribute("data-expand-id") ?? null;
    const open = toggle.getAttribute("aria-expanded") !== "true";
    if (expandId !== null) {
      if (open) expandedContentIds.add(expandedKey(expandId));
      else expandedContentIds.delete(expandedKey(expandId));
    }
    if (wrapper instanceof HTMLElement) applyExpandState(wrapper);
    return;
  }
  const control = event.target.closest("[data-action]");
  if (control !== null) void handleDialogAction(control);
});
dialog.addEventListener("close", () => {
  detailJobId = null;
  stopDetailRefresh();
});
if (healthCheckButton instanceof HTMLButtonElement) {
  healthCheckButton.addEventListener("click", () => {
    void checkHealth();
  });
}
document.getElementById("job-dialog-close").addEventListener("click", () => dialog.close());
updateJudgePanel();
renumberTurns();
refreshJobs();
setInterval(refreshJobs, 12000);