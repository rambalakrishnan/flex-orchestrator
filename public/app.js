// BrowserClient: job creation, developer context, token preview, fragment polling, and job-detail dialog wiring.
const form = document.getElementById("create-job-form");
const formStatus = document.getElementById("form-status");
const jobList = document.getElementById("job-list");
const dialog = document.getElementById("job-dialog");
const dialogBody = document.getElementById("job-dialog-body");
const turnsContainer = document.getElementById("turns");
const turnTemplate = document.getElementById("turn-template");
const countTokensButton = document.getElementById("count-tokens");
const tokenPreview = document.getElementById("token-preview");
const developerFilesInput = document.getElementById("developer-files");
const judgeEnabledCheckbox = document.getElementById("judge-enabled");
const judgePanel = document.getElementById("judge-panel");

const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1";
const OPENAI_API_ROOT = "https://api.openai.com/v1";
const MAX_AUTO_CONTINUATIONS = 3;
const MAX_AUTO_RETRIES = 1;
const GRADE_THRESHOLDS = Object.freeze({ A: 100, B: 90, C: 80, D: 70, F: 60 });

const value = (id) => document.getElementById(id).value;

function setStatus(message) {
  formStatus.textContent = message;
}

function renderTokenPreview(lines, state) {
  tokenPreview.replaceChildren(
    ...lines.map((line) => {
      const row = document.createElement("div");
      row.textContent = line;
      return row;
    }),
  );
  if (state === "ok" || state === "error") tokenPreview.dataset.state = state;
  else delete tokenPreview.dataset.state;
}

function setTokenPreview(message, state) {
  renderTokenPreview(message.length === 0 ? [] : [message], state);
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

async function errorMessage(response) {
  try {
    const body = await response.json();
    const message = body?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
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
    specs.push({ turnIndex: specs.length + 1, promptText, files });
  }
  if (specs.length === 0) {
    throw new Error("Add at least one turn prompt before creating the job.");
  }
  return specs;
}

function buildJudgeConfig() {
  if (!judgeEnabledCheckbox.checked) return { enabled: false };

  const model = readRequiredValue("judge-model", "Judge model");
  const secretName = readRequiredValue("judge-secret", "Judge secret name");
  const transport = checkedRadioValue("judge-transport", "judge transport");
  const historyMode = checkedRadioValue("judge-history", "judge history mode");
  const fileDeliveryMode = checkedRadioValue(
    "judge-file-delivery",
    "judge file delivery mode",
  );
  const grade = value("judge-grade");
  const maxGradeThreshold = GRADE_THRESHOLDS[grade];
  if (typeof maxGradeThreshold !== "number") {
    throw new Error("Select a valid pass grade threshold.");
  }

  const openRouter = secretName.startsWith("OPENROUTER");
  return {
    enabled: true,
    provider: openRouter ? "openrouter" : "openai",
    apiRoot: openRouter ? OPENROUTER_API_ROOT : OPENAI_API_ROOT,
    secretName,
    model,
    transport,
    historyMode,
    fileDeliveryMode,
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
  };
}

/**
 * Token preview is first-class across the composer: one unit for the developer
 * context plus one unit per current turn block. Every generation request carries
 * the developer message, so turn units reuse the developer prompt and files.
 */
function collectTokenPreviewUnits() {
  const units = [
    {
      label: "Developer context",
      promptText: "",
      files: developerFilesInput.files,
      uploadTurnIndex: undefined,
    },
  ];
  for (const block of turnBlocks()) {
    const parsedIndex = Number(block.dataset.turnIndex);
    const turnIndex =
      Number.isSafeInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : units.length;
    const prompt = block.querySelector(".turn-prompt");
    const filesInput = block.querySelector(".turn-files");
    units.push({
      label: "Turn " + turnIndex + " (incl. developer context)",
      promptText: prompt === null ? "" : prompt.value,
      files: filesInput === null ? [] : filesInput.files,
      uploadTurnIndex: turnIndex,
    });
  }
  return units;
}

/** Reads and validates the preview options shared by every unit. */
function readTokenPreviewOptions() {
  return {
    model: readRequiredValue("job-model", "Model"),
    developerPrompt: value("developer-prompt"),
    maxOutputTokens: readPositiveInteger("job-max-output-tokens", "Max output tokens"),
    reasoningEffort: value("job-reasoning"),
    webSearch: document.getElementById("job-web-search").checked,
  };
}

/** Posts one unit body and resolves with the validated preview response. */
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

async function countTokens() {
  countTokensButton.disabled = true;
  setTokenPreview("Counting tokens\u2026");
  try {
    const options = readTokenPreviewOptions();
    const units = collectTokenPreviewUnits();

    // Upload every unit's files first; each turn's files carry that turn index.
    const uploads = await Promise.allSettled(
      units.map((unit) => uploadFiles(unit.files, unit.uploadTurnIndex)),
    );
    uploads.forEach((outcome, index) => {
      const unit = units[index];
      if (outcome.status === "fulfilled") unit.uploadedFileIds = outcome.value;
      else unit.errorMessage = describeError(outcome.reason);
    });

    const developerUnit = units[0];
    const developerFileIds = developerUnit.uploadedFileIds ?? [];

    // A turn cannot be counted without the developer message it will carry.
    const countUnits = [];
    for (const unit of units) {
      if (unit.errorMessage !== undefined) continue;
      if (unit !== developerUnit && developerUnit.errorMessage !== undefined) {
        unit.errorMessage = "developer context upload failed: " + developerUnit.errorMessage;
        continue;
      }
      countUnits.push(unit);
    }

    // Every preview request goes out together; units are never serialized.
    const previews = await Promise.allSettled(
      countUnits.map((unit) =>
        requestTokenPreview({
          model: options.model,
          promptText: unit.promptText,
          developerPrompt: options.developerPrompt,
          developerFileIds,
          attachmentFileIds: unit === developerUnit ? [] : (unit.uploadedFileIds ?? []),
          maxOutputTokens: options.maxOutputTokens,
          reasoningEffort: options.reasoningEffort,
          webSearch: options.webSearch,
        }),
      ),
    );

    const outcomes = new Map();
    previews.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") outcomes.set(countUnits[index], outcome.value);
      else countUnits[index].errorMessage = describeError(outcome.reason);
    });

    let anyError = false;
    const lines = units.map((unit) => {
      if (unit.errorMessage !== undefined) {
        anyError = true;
        return unit.label + ": Error: " + unit.errorMessage;
      }
      const preview = outcomes.get(unit);
      if (preview === undefined) {
        anyError = true;
        return unit.label + ": Error: token preview was not requested.";
      }
      if (preview.admission?.kind !== "admitted") anyError = true;
      return unit.label + ": " + describeTokenPreview(preview);
    });
    renderTokenPreview(lines, anyError ? "error" : "ok");
  } catch (error) {
    setTokenPreview("Error: " + describeError(error), "error");
  } finally {
    countTokensButton.disabled = false;
  }
}

let creatingJob = false;

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

    form.reset();
    resetTurns();
    updateJudgePanel();
    setTokenPreview("");
    setStatus("Job created.");
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

async function openJobDetail(jobId) {
  try {
    const response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/fragment");
    if (response.ok) dialogBody.innerHTML = await response.text();
    else dialogBody.textContent = "Error: " + (await errorMessage(response));
  } catch {
    dialogBody.textContent = "Error: network request failed.";
  }
  dialog.showModal();
}

document.getElementById("add-turn").addEventListener("click", addTurn);
turnsContainer.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest(".turn-remove");
  if (button !== null) removeTurn(button);
});
countTokensButton.addEventListener("click", countTokens);
judgeEnabledCheckbox.addEventListener("change", updateJudgePanel);
form.addEventListener("submit", createJob);
jobList.addEventListener("click", (event) => {
  const card = event.target instanceof Element ? event.target.closest(".job-card") : null;
  const jobId = card === null ? null : card.getAttribute("data-job-id");
  if (jobId) openJobDetail(jobId);
});
document.getElementById("job-dialog-close").addEventListener("click", () => dialog.close());
updateJudgePanel();
renumberTurns();
refreshJobs();
setInterval(refreshJobs, 12000);