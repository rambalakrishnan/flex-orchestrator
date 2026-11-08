// BrowserClient: job creation, fragment polling, and job-detail dialog wiring.
const form = document.getElementById("create-job-form");
const formStatus = document.getElementById("form-status");
const jobList = document.getElementById("job-list");
const dialog = document.getElementById("job-dialog");
const dialogBody = document.getElementById("job-dialog-body");
const value = (id) => document.getElementById(id).value;

function setStatus(message) {
  formStatus.textContent = message;
}

function buildCreateJobCommand() {
  return {
    jobId: "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: value("job-title"),
    config: {
      model: value("job-model"),
      reasoningEffort: "medium",
      maxOutputTokens: Number(value("job-max-output-tokens")),
      cacheTtl: value("job-cache-ttl"),
      webSearch: document.getElementById("job-web-search").checked,
      maxContinuations: 3,
      maxAutoRetries: 1,
      judge: { enabled: false },
    },
    initialTurns: [{ turnIndex: 1, promptText: value("job-prompt"), attachmentFileIds: [] }],
  };
}

async function errorMessage(response) {
  try {
    const message = (await response.json()).error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Non-JSON error bodies use the generic message below.
  }
  return "Request failed with status " + response.status + ".";
}

async function refreshJobs() {
  try {
    const response = await fetch("/api/jobs/fragment");
    if (response.ok) jobList.innerHTML = await response.text();
  } catch {
    // Keep the last rendered list when the fragment request fails.
  }
}

async function createJob(event) {
  event.preventDefault();
  setStatus("Creating job\u2026");
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCreateJobCommand()),
    });
    if (!response.ok) {
      setStatus("Error: " + (await errorMessage(response)));
      return;
    }
    form.reset();
    setStatus("Job created.");
    await refreshJobs();
  } catch {
    setStatus("Error: network request failed.");
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

form.addEventListener("submit", createJob);
jobList.addEventListener("click", (event) => {
  const card = event.target.closest(".job-card");
  const jobId = card ? card.getAttribute("data-job-id") : null;
  if (jobId) openJobDetail(jobId);
});
document.getElementById("job-dialog-close").addEventListener("click", () => dialog.close());
refreshJobs();
setInterval(refreshJobs, 12000);