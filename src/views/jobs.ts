/**
 * Job HTML views (`src/views/jobs.ts`) — server-rendered, self-contained HTML
 * fragments for the job list and job detail screens.
 *
 * Every fragment is intended for an `innerHTML` swap. Only accepted deliverable
 * text is inserted through `renderMarkdown`; every other dynamic value,
 * including raw turn prompts, error codes and messages, response identifiers,
 * provider diagnostics, and file ids, flows through `escapeHtml`. Credentials
 * are never interpolated here.
 */

import type {
  GenerationAttemptSummaryRow,
  JudgeCallSummaryRow,
  TurnSummaryRow,
} from "../db/schema.ts";
import { escapeHtml, renderMarkdown } from "../lib/markdown.ts";
import type { JobStateResponse, JobSummaryItem, TurnIndex, TurnStatus } from "../types.ts";

export interface JobDeliverable {
  readonly turnIndex: TurnIndex;
  readonly status: TurnStatus;
  readonly text: string;
}

function renderStatusBadge(status: string): string {
  return `<span class="status status-${escapeHtml(status.toLowerCase())}">${escapeHtml(status)}</span>`;
}

function renderCount(label: string, value: number): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`;
}

/**
 * Renders the job list as an HTML fragment. Returns an empty-state paragraph
 * when `jobs` is empty.
 */
export function renderJobList(jobs: readonly JobSummaryItem[]): string {
  if (jobs.length === 0) {
    return `<p class="empty-state">No jobs yet.</p>`;
  }

  const cards = jobs.map((job) => {
    const cost =
      job.totalEstimatedCostUsd === null
        ? ""
        : `<p class="job-card-cost">Cost: ${escapeHtml(`$${job.totalEstimatedCostUsd.toFixed(4)}`)}</p>`;

    return [
      `<article class="job-card" data-job-id="${escapeHtml(job.jobId)}">`,
      `<h2 class="job-card-title">${escapeHtml(job.title)}</h2>`,
      `<p class="job-card-meta">`,
      renderStatusBadge(job.status),
      `<span class="job-card-model">${escapeHtml(job.model)}</span>`,
      `</p>`,
      `<dl class="job-card-counters">`,
      renderCount("Current turn", job.currentTurnIndex),
      renderCount("Accepted turns", job.acceptedTurnCount),
      `</dl>`,
      cost,
      `<p class="job-card-timestamps">`,
      `<time class="job-card-created" datetime="${escapeHtml(new Date(job.createdAtMs).toISOString())}">Created ${escapeHtml(new Date(job.createdAtMs).toISOString())}</time>`,
      `<time class="job-card-updated" datetime="${escapeHtml(new Date(job.updatedAtMs).toISOString())}">Updated ${escapeHtml(new Date(job.updatedAtMs).toISOString())}</time>`,
      `</p>`,
      `</article>`,
    ].join("");
  });

  return `<div class="job-list" role="list">${cards.join("")}</div>`;
}

function renderUsageSummary(job: JobStateResponse): string {
  const { usage } = job;
  const costCell = (value: number | null): string =>
    value === null
      ? `<span class="muted">unknown pricing</span>`
      : escapeHtml(`$${value.toFixed(4)}`);

  return [
    `<dl class="usage-summary">`,
    renderCount("Generation calls", usage.generationCalls),
    renderCount("Judge calls", usage.judgeCalls),
    renderCount("Total tokens", usage.totalTokens),
    `<div><dt>Generation cost</dt><dd>${costCell(usage.generationCostUsd)}</dd></div>`,
    `<div><dt>Judge cost</dt><dd>${costCell(usage.judgeCostUsd)}${usage.judgeCalls > 0 ? ` <span class="muted">(${escapeHtml(String(usage.judgeTokens))} tokens)</span>` : ""}</dd></div>`,
    `<div><dt>Combined cost</dt><dd>${costCell(usage.totalEstimatedCostUsd)}</dd></div>`,
    `</dl>`,
  ].join("");
}
/**
 * Wraps long rendered content in a collapsed preview. The body is clamped by
 * CSS to ~10 lines with a fade; the toggle expands it in place. `expandId`
 * must be unique within the fragment so the client can persist open state
 * across fragment refreshes. `innerHtml` is rendered content, never raw model
 * text (deliverables pass through `renderMarkdown`, judge comments through
 * `escapeHtml`).
 */
function renderExpandableContent(expandId: string, innerHtml: string): string {
  return [
    `<div class="expandable" data-expand-id="${escapeHtml(expandId)}">`,
    `<div class="expandable-body">${innerHtml}</div>`,
    `<button type="button" class="expand-toggle" aria-expanded="false">Show more</button>`,
    `</div>`,
  ].join("");
}

function renderDeliverable(
  deliverable: JobDeliverable,
  marginalInputTokens: number | null,
  judgeCalls: readonly JudgeCallSummaryRow[],
  acceptedResponseId: string | null,
  latestProviderResponseId: string | null,
): string {
  const marginal =
    marginalInputTokens === null
      ? ""
      : `<span class="deliverable-tokens">Marginal input tokens: ${escapeHtml(String(marginalInputTokens))}</span>`;

  return [
    `<section class="deliverable" data-turn-index="${escapeHtml(String(deliverable.turnIndex))}">`,
    `<header class="deliverable-header">`,
    `<h3 class="deliverable-turn">Turn ${escapeHtml(String(deliverable.turnIndex))}</h3>`,
    renderStatusBadge(deliverable.status),
    `<span class="deliverable-response-id turn-response">Accepted response: ${renderResponseId(acceptedResponseId)}</span>`,
    `<span class="deliverable-latest-response-id turn-response">Latest provider response: ${renderResponseId(latestProviderResponseId)}</span>`,
    marginal,
    `</header>`,
    renderExpandableContent(
      `deliverable-turn-${deliverable.turnIndex}`,
      `<div class="deliverable-content">${renderMarkdown(deliverable.text)}</div>`,
    ),
    judgeCalls.map(renderTurnJudgeResult).join(""),
    `</section>`,
  ].join("");
}

/**
 * Renders the judge result(s) observed for one accepted turn inside its
 * deliverable card. Verdict and grade are escaped when inserted; a judge
 * comment is model-authored and therefore escaped as plain text.
 */
function renderTurnJudgeResult(judgeCall: JudgeCallSummaryRow): string {
  const verdict =
    judgeCall.verdict === null
      ? `<span class="muted">—</span>`
      : renderStatusBadge(judgeCall.verdict);
  const commentBody =
    judgeCall.comment === null || judgeCall.comment === ""
      ? `<span class="muted">—</span>`
      : escapeHtml(judgeCall.comment);
  const comment =
    judgeCall.comment === null || judgeCall.comment === ""
      ? `<p class="turn-judge-comment">${commentBody}</p>`
      : renderExpandableContent(
          `judge-comment-${judgeCall.judge_call_id}`,
          `<p class="turn-judge-comment">${commentBody}</p>`,
        );

  return [
    `<section class="turn-judge" data-judge-call-id="${escapeHtml(judgeCall.judge_call_id)}">`,
    verdict,
    `<span class="turn-judge-grade">Grade: ${renderOptionalText(judgeCall.grade)}</span>`,
    comment,
    `</section>`,
  ].join("");
}

function renderOptionalText(value: string | number | null): string {
  if (value === null || value === "") {
    return `<span class="muted">—</span>`;
  }
  return escapeHtml(String(value));
}

function renderOptionalCode(value: string | null): string {
  if (value === null || value === "") {
    return `<span class="muted">—</span>`;
  }
  return `<code>${escapeHtml(value)}</code>`;
}

/** Response identifiers stay selectable and escaped; absent values stay muted. */
function renderResponseId(value: string | null): string {
  if (value === null || value === "") {
    return `<span class="muted">—</span>`;
  }
  return `<span class="response-id">${escapeHtml(value)}</span>`;
}

function renderFlag(value: number | null): string {
  if (value === null) {
    return `<span class="muted">—</span>`;
  }
  return value === 1 ? "Yes" : "No";
}

/**
 * Job statuses that accept an operator pause: anything still schedulable.
 * Already-halted or terminal jobs cannot be paused again.
 */
function isPausableJobStatus(
  status: JobStateResponse["job"]["status"],
): boolean {
  return status === "created" || status === "ready" || status === "running";
}

/**
 * Job statuses that accept an in-place resume. `paused_review` deliberately
 * requires a turn retry or an operator review decision instead.
 */
function isResumeJobStatus(
  status: JobStateResponse["job"]["status"],
): boolean {
  return (
    status === "failed" ||
    status === "paused_dispatch" ||
    status === "paused_storage" ||
    status === "paused_operator"
  );
}

/** Statuses where the current turn may be retried manually. */
function isRetryTurnStatus(
  status: JobStateResponse["job"]["status"],
): boolean {
  return isResumeJobStatus(status) || status === "paused_review";
}

/**
 * Renders the persisted job-level failure as an escaped alert. Either the
 * stable `errorCode` or the free-form `errorMessage` may be present alone; the
 * banner only appears when at least one carries content.
 */
function renderJobErrorBanner(job: JobStateResponse): string {
  const errorCode =
    typeof job.job.errorCode === "string" &&
    job.job.errorCode.trim().length > 0
      ? job.job.errorCode
      : null;
  const errorMessage =
    typeof job.job.errorMessage === "string" &&
    job.job.errorMessage.trim().length > 0
      ? job.job.errorMessage
      : null;
  if (errorCode === null && errorMessage === null) {
    return "";
  }

  return [
    `<div class="job-error" role="alert">`,
    errorCode === null
      ? ""
      : `<code class="job-error-code">${escapeHtml(errorCode)}</code>`,
    errorMessage === null
      ? ""
      : `<p class="job-error-message">${escapeHtml(errorMessage)}</p>`,
    `</div>`,
  ].join("");
}

function renderResumeJobButton(jobId: string): string {
  return `<button type="button" class="action-button" data-action="resume-job" data-job-id="${escapeHtml(jobId)}">Resume Job</button>`;
}

function renderPauseJobButton(jobId: string): string {
  return `<button type="button" class="action-button" data-action="pause-job" data-job-id="${escapeHtml(jobId)}">Pause Job</button>`;
}

function renderRetryTurnButton(jobId: string, turnIndex: number): string {
  return `<button type="button" class="action-button" data-action="retry-turn" data-job-id="${escapeHtml(jobId)}" data-turn-index="${escapeHtml(String(turnIndex))}">Retry Turn</button>`;
}

function renderCheckHealthButton(jobId: string): string {
  return `<button type="button" class="action-button" data-action="check-health" data-job-id="${escapeHtml(jobId)}">Check Health</button>`;
}

function renderJsonlDownloadLink(jobId: string): string {
  return `<a class="download-jsonl" href="/api/jobs/${escapeHtml(encodeURIComponent(jobId))}/export/jsonl" download>Download JSONL</a>`;
}

function renderJsonlInspectButton(jobId: string): string {
  return `<button type="button" class="action-button" data-action="inspect-jsonl" data-job-id="${escapeHtml(jobId)}">Inspect JSONL</button>`;
}

interface AttemptProviderError {
  readonly code: string | null;
  readonly message: string | null;
}

/** Diagnostics are JSON text under the storage guard; malformed text is ignored. */
function parseDiagnosticsRecord(
  raw: string,
): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readAttemptProviderError(raw: string): AttemptProviderError {
  const diagnostics = parseDiagnosticsRecord(raw);
  if (diagnostics === null) {
    return { code: null, message: null };
  }
  const rawCode = diagnostics.provider_error_code;
  const rawMessage = diagnostics.provider_error_message;
  return {
    code:
      typeof rawCode === "string" && rawCode.length > 0 ? rawCode : null,
    message:
      typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : null,
  };
}

function renderAttemptProviderError(rawDiagnostics: string): string {
  const { code, message } = readAttemptProviderError(rawDiagnostics);
  if (code === null && message === null) {
    return `<span class="muted">—</span>`;
  }
  return [
    `<div class="provider-error">`,
    code === null
      ? ""
      : `<code class="provider-error-code">${escapeHtml(code)}</code>`,
    message === null
      ? ""
      : `<span class="provider-error-message">${escapeHtml(message)}</span>`,
    `</div>`,
  ].join("");
}

/**
 * Picks the most advanced attempt for each turn. Attempt numbers order full
 * retries; continuation index and the identifier break ties deterministically.
 */
function latestAttemptByTurn(
  attempts: readonly GenerationAttemptSummaryRow[],
): ReadonlyMap<number, GenerationAttemptSummaryRow> {
  const latest = new Map<number, GenerationAttemptSummaryRow>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.turn_index);
    if (current === undefined || attemptIsNewer(attempt, current)) {
      latest.set(attempt.turn_index, attempt);
    }
  }
  return latest;
}

function attemptIsNewer(
  candidate: GenerationAttemptSummaryRow,
  current: GenerationAttemptSummaryRow,
): boolean {
  if (candidate.attempt_number !== current.attempt_number) {
    return candidate.attempt_number > current.attempt_number;
  }
  if (candidate.continuation_index !== current.continuation_index) {
    return candidate.continuation_index > current.continuation_index;
  }
  return candidate.attempt_id > current.attempt_id;
}

function renderTime(value: string): string {
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`;
}

/**
 * Renders one escaped table. Headings and every cell value are escaped at the
 * point of insertion; callers may only pass already-safe markup such as status
 * badges and `<time>` elements produced by the helpers above.
 */
function renderTable(
  className: string,
  headings: readonly string[],
  rows: readonly string[],
  emptyMessage: string,
): string {
  const head = headings
    .map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`)
    .join("");
  const body =
    rows.length === 0
      ? `<tr class="empty-row"><td colspan="${headings.length}">${escapeHtml(emptyMessage)}</td></tr>`
      : rows.join("");

  return [
    `<div class="table-wrap">`,
    `<table class="${escapeHtml(className)}">`,
    `<thead><tr>${head}</tr></thead>`,
    `<tbody>${body}</tbody>`,
    `</table>`,
    `</div>`,
  ].join("");
}

function renderTableRow(cells: readonly string[]): string {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

function renderTurnsTable(
  turns: readonly TurnSummaryRow[],
  promptTextByTurnIndex: ReadonlyMap<number, string>,
  latestAttempts: ReadonlyMap<number, GenerationAttemptSummaryRow>,
  job: JobStateResponse,
): string {
  const rows = turns.map((turn) => {
    const promptText = promptTextByTurnIndex.get(turn.turn_index);
    const prompt =
      promptText === undefined
        ? escapeHtml(`${turn.prompt_bytes} bytes`)
        : [
            `<details class="prompt-details">`,
            `<summary>Prompt</summary>`,
            `<pre class="prompt-text">${escapeHtml(promptText)}</pre>`,
            `</details>`,
          ].join("");
    const anchor =
      turn.accepted_candidate_id === null && turn.accepted_response_id === null
        ? `<span class="muted">—</span>`
        : [
            `<div class="accepted-candidate">${renderOptionalCode(turn.accepted_candidate_id)}</div>`,
            `<div class="accepted-response">${renderResponseId(turn.accepted_response_id)}</div>`,
          ].join("");
    const latestProviderResponse =
      latestAttempts.get(turn.turn_index)?.provider_response_id ?? null;
    const retryAction =
      isRetryTurnStatus(job.job.status) &&
      turn.turn_index === job.job.currentTurnIndex
        ? renderRetryTurnButton(job.job.jobId, turn.turn_index)
        : `<span class="muted">—</span>`;
    const pinned = turn.pinned_in_replay === 1;
    const pinAction = `<button type="button" class="action-button" data-action="toggle-pin" data-job-id="${escapeHtml(job.job.jobId)}" data-turn-index="${escapeHtml(String(turn.turn_index))}" data-pinned="${pinned ? "true" : "false"}" aria-pressed="${pinned ? "true" : "false"}">${pinned ? "Unpin" : "Pin"}</button>`;

    return renderTableRow([
      escapeHtml(String(turn.turn_index)),
      renderStatusBadge(turn.status),
      prompt,
      anchor,
      renderResponseId(latestProviderResponse),
      renderOptionalText(turn.marginal_input_tokens),
      renderTime(turn.updated_at),
      `<div class="turn-actions">${retryAction}${pinAction}</div>`,
    ]);
  });

  return renderTable(
    "turn-table",
    [
      "Turn",
      "Status",
      "Prompt",
      "Accepted anchor",
      "Latest provider response",
      "Marginal tokens",
      "Updated",
      "Actions",
    ],
    rows,
    "No turns recorded yet.",
  );
}

function renderAttemptsTable(
  attempts: readonly GenerationAttemptSummaryRow[],
): string {
  const rows = attempts.map((attempt) =>
    renderTableRow([
      `<code>${escapeHtml(attempt.attempt_id)}</code>`,
      escapeHtml(String(attempt.turn_index)),
      escapeHtml(attempt.kind),
      renderStatusBadge(attempt.status),
      renderResponseId(attempt.provider_response_id),
      renderAttemptProviderError(attempt.diagnostics_json),
      escapeHtml(String(attempt.capacity_sends)),
      escapeHtml(String(attempt.poll_probes)),
      renderTime(attempt.created_at),
      renderTime(attempt.updated_at),
    ]),
  );

  return renderTable(
    "attempt-table",
    [
      "Attempt",
      "Turn",
      "Kind",
      "Status",
      "Provider response",
      "Provider error",
      "Capacity sends",
      "Poll probes",
      "Created",
      "Updated",
    ],
    rows,
    "No generation attempts recorded yet.",
  );
}

function renderJudgeCallsTable(judgeCalls: readonly JudgeCallSummaryRow[]): string {
  const rows = judgeCalls.map((judgeCall) =>
    renderTableRow([
      escapeHtml(judgeCall.model),
      escapeHtml(judgeCall.transport),
      escapeHtml(judgeCall.history_mode),
      escapeHtml(judgeCall.file_delivery_mode),
      renderStatusBadge(judgeCall.status),
      renderOptionalText(judgeCall.verdict),
      renderOptionalText(judgeCall.grade),
      judgeCall.comment === null
        ? `<span class="muted">—</span>`
        : `<span class="judge-comment">${escapeHtml(judgeCall.comment)}</span>`,
      renderFlag(judgeCall.tag_agreement),
      renderFlag(judgeCall.file_visibility),
      renderTime(judgeCall.created_at),
      renderTime(judgeCall.updated_at),
    ]),
  );

  return renderTable(
    "judge-table",
    [
      "Model",
      "Transport",
      "History",
      "File delivery",
      "Status",
      "Verdict",
      "Grade",
      "Comment",
      "Tag agreement",
      "File visibility",
      "Created",
      "Updated",
    ],
    rows,
    "No judge calls recorded yet.",
  );
}

function renderJudgeConfigSection(job: JobStateResponse): string {
  const config = job.job.config.judge;
  const rows: string[] = [];
  if (!config.enabled) {
    rows.push(`<p class="empty-state">Judging is disabled for this job.</p>`);
  } else {
    const fields: ReadonlyArray<readonly [string, string]> = [
      ["Model", config.model],
      ["Transport", config.transport],
      ["API root", config.apiRoot],
      ["Secret binding", config.secretName],
      ["History mode", config.historyMode],
      ["File delivery", config.fileDeliveryMode],
      ["Minimum grade", String(config.maxGradeThreshold)],
      ["Inject on fail", config.injectOnFail ? "yes" : "no"],
      ["Inject on pass", config.injectOnPass ? "yes" : "no"],
    ];
    rows.push(
      `<dl class="judge-config">`,
      ...fields.map(
        ([label, value]) =>
          `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
      ),
      `</dl>`,
    );
  }
  const halted =
    job.job.status === "failed" ||
    job.job.status === "ready" ||
    job.job.status === "paused_review" ||
    job.job.status === "paused_dispatch" ||
    job.job.status === "paused_storage" ||
    job.job.status === "paused_operator";
  if (halted && config.enabled) {
    rows.push(
      `<form class="judge-config-edit" data-job-id="${escapeHtml(job.job.jobId)}">`,
      `<p class="judge-config-edit-note">Edits apply to future evaluations. Fix the model id, transport, or endpoint, then save.</p>`,
      `<p><label>Model <input name="model" value="${escapeHtml(config.model)}" required /></label></p>`,
      `<p><label>API root <input name="apiRoot" value="${escapeHtml(config.apiRoot)}" required /></label></p>`,
      `<p><label>Secret binding <input name="secretName" value="${escapeHtml(config.secretName)}" required /></label></p>`,
      `<p><label>Transport <select name="transport">`,
      `<option value="responses"${config.transport === "responses" ? " selected" : ""}>responses</option>`,
      `<option value="chat_completions"${config.transport === "chat_completions" ? " selected" : ""}>chat_completions</option>`,
      `</select></label></p>`,
      `<input type="hidden" name="provider" value="${escapeHtml(config.provider)}" />`,
      `<input type="hidden" name="historyMode" value="${escapeHtml(config.historyMode)}" />`,
      `<input type="hidden" name="fileDeliveryMode" value="${escapeHtml(config.fileDeliveryMode)}" />`,
      `<input type="hidden" name="includePrior" value="${config.includePrior ? "true" : "false"}" />`,
      `<input type="hidden" name="maxGradeThreshold" value="${escapeHtml(String(config.maxGradeThreshold))}" />`,
      `<input type="hidden" name="injectOnFail" value="${config.injectOnFail ? "true" : "false"}" />`,
      `<input type="hidden" name="injectOnPass" value="${config.injectOnPass ? "true" : "false"}" />`,
      `<input type="hidden" name="developerPrompt" value="${escapeHtml(config.developerPrompt)}" />`,
      `<p><button type="submit">Save judge config</button></p>`,
      `<p class="judge-config-edit-status" role="status"></p>`,
      `</form>`,
    );
  }
  return [
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Judge configuration</h3>`,
    ...rows,
    `</section>`,
  ].join("");
}

/**
 * Renders a job detail fragment. `deliverables` carries accepted turn text
 * because `JobStateResponse.turns` only exposes turn metadata. Deliverables
 * are ordered by `turnIndex`; model-authored deliverable text is the only
 * unescaped dynamic content and always passes through `renderMarkdown`. Each
 * deliverable card also carries the judge result(s) recorded for its turn and
 * the frozen marginal input token count when one is stored. Turn prompts come
 * from the job state (`TurnRecord.promptText`) because summary rows carry only
 * prompt byte counts; every prompt, table cell, judge comment, and identifier
 * is escaped. Failed and paused jobs render an escaped error banner with
 * recovery controls, and every job links to its JSONL export.
 */
export function renderJobDetail(
  job: JobStateResponse,
  deliverables: readonly JobDeliverable[],
  turns: readonly TurnSummaryRow[],
  attempts: readonly GenerationAttemptSummaryRow[],
  judgeCalls: readonly JudgeCallSummaryRow[],
): string {
  const promptTextByTurnIndex = new Map<number, string>();
  const marginalTokensByTurnIndex = new Map<number, number>();
  const acceptedResponseByTurnIndex = new Map<number, string | null>();
  for (const turn of job.turns) {
    promptTextByTurnIndex.set(turn.turnIndex, turn.promptText);
    acceptedResponseByTurnIndex.set(
      turn.turnIndex,
      turn.acceptedResponseId,
    );
    if (turn.marginalInputTokens !== null) {
      marginalTokensByTurnIndex.set(turn.turnIndex, turn.marginalInputTokens);
    }
  }
  for (const turn of turns) {
    const knownResponseId = acceptedResponseByTurnIndex.get(turn.turn_index);
    if (
      (knownResponseId === undefined || knownResponseId === null) &&
      turn.accepted_response_id !== null
    ) {
      acceptedResponseByTurnIndex.set(
        turn.turn_index,
        turn.accepted_response_id,
      );
    }
  }

  const latestAttempts = latestAttemptByTurn(attempts);

  const judgeCallsByTurnIndex = new Map<number, JudgeCallSummaryRow[]>();
  for (const judgeCall of judgeCalls) {
    const existing = judgeCallsByTurnIndex.get(judgeCall.turn_index);
    if (existing === undefined) {
      judgeCallsByTurnIndex.set(judgeCall.turn_index, [judgeCall]);
    } else {
      existing.push(judgeCall);
    }
  }

  const sorted = [...deliverables].sort((a, b) => a.turnIndex - b.turnIndex);
  const body =
    sorted.length === 0
      ? `<p class="empty-state">No accepted deliverables yet.</p>`
      : sorted
          .map((deliverable) =>
            renderDeliverable(
              deliverable,
              marginalTokensByTurnIndex.get(deliverable.turnIndex) ?? null,
              judgeCallsByTurnIndex.get(deliverable.turnIndex) ?? [],
              acceptedResponseByTurnIndex.get(deliverable.turnIndex) ?? null,
              latestAttempts.get(deliverable.turnIndex)?.provider_response_id ??
                null,
            ),
          )
          .join("");

  const downloadFinal =
    job.job.status === "completed"
      ? `<a class="button download-final" href="/api/jobs/${escapeHtml(encodeURIComponent(job.job.jobId))}/export/markdown" download>Download Final Markdown</a>`
      : "";
  const jobActions = [
    isPausableJobStatus(job.job.status)
      ? renderPauseJobButton(job.job.jobId)
      : "",
    isResumeJobStatus(job.job.status)
      ? renderResumeJobButton(job.job.jobId)
      : "",
    renderCheckHealthButton(job.job.jobId),
    renderJsonlDownloadLink(job.job.jobId),
    renderJsonlInspectButton(job.job.jobId),
    downloadFinal,
  ].join("");

  const responseAnchors: string[] = [];
  if (
    job.job.acceptedTurnCount === 0 &&
    job.job.lastAcceptedResponseId !== null
  ) {
    responseAnchors.push(
      `<p class="job-detail-anchor">Initial response: ${renderResponseId(job.job.lastAcceptedResponseId)}</p>`,
    );
  }
  const activeResponseId = job.activeAttempt?.responseId ?? null;
  if (activeResponseId !== null) {
    responseAnchors.push(
      `<p class="job-detail-anchor">Active response: ${renderResponseId(activeResponseId)}</p>`,
    );
  }

  return [
    `<article class="job-detail" data-job-id="${escapeHtml(job.job.jobId)}">`,
    renderJobErrorBanner(job),
    `<header class="job-detail-header">`,
    `<h1 class="job-detail-title">${escapeHtml(job.job.title)}</h1>`,
    `<p class="job-detail-meta">`,
    renderStatusBadge(job.job.status),
    `<span class="job-detail-model">${escapeHtml(job.job.config.model)}</span>`,
    `<span class="job-detail-id">${escapeHtml(job.job.jobId)}</span>`,
    `</p>`,
    responseAnchors.join(""),
    `<dl class="job-detail-counters">`,
    renderCount("Turn count", job.turns.length),
    renderCount("Accepted turns", job.job.acceptedTurnCount),
    `</dl>`,
    renderUsageSummary(job),
    `<div class="job-actions">${jobActions}</div>`,
    `</header>`,
    `<section class="deliverables">`,
    `<h2 class="deliverables-title">Deliverables</h2>`,
    body,
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Turns</h3>`,
    renderTurnsTable(turns, promptTextByTurnIndex, latestAttempts, job),
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Attempts</h3>`,
    renderAttemptsTable(attempts),
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Judge calls</h3>`,
    renderJudgeCallsTable(judgeCalls),
    `</section>`,
    renderJudgeConfigSection(job),
    `</article>`,
  ].join("");
}