/**
 * Job HTML views (`src/views/jobs.ts`) — server-rendered, self-contained HTML
 * fragments for the job list and job detail screens.
 *
 * Every fragment is intended for an `innerHTML` swap. Only accepted deliverable
 * text is inserted through `renderMarkdown`; every other dynamic value,
 * including raw turn prompts, flows through `escapeHtml`. File ids, error
 * details, and credentials are never interpolated here.
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
  const cost =
    usage.totalEstimatedCostUsd === null
      ? ""
      : `<div><dt>Cost</dt><dd>${escapeHtml(`$${usage.totalEstimatedCostUsd.toFixed(4)}`)}</dd></div>`;

  return [
    `<dl class="usage-summary">`,
    renderCount("Generation calls", usage.generationCalls),
    renderCount("Judge calls", usage.judgeCalls),
    renderCount("Total tokens", usage.totalTokens),
    cost,
    `</dl>`,
  ].join("");
}

function renderDeliverable(
  deliverable: JobDeliverable,
  marginalInputTokens: number | null,
  judgeCalls: readonly JudgeCallSummaryRow[],
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
    marginal,
    `</header>`,
    `<div class="deliverable-content">${renderMarkdown(deliverable.text)}</div>`,
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
  const comment =
    judgeCall.comment === null || judgeCall.comment === ""
      ? `<span class="muted">—</span>`
      : escapeHtml(judgeCall.comment);

  return [
    `<section class="turn-judge" data-judge-call-id="${escapeHtml(judgeCall.judge_call_id)}">`,
    verdict,
    `<span class="turn-judge-grade">Grade: ${renderOptionalText(judgeCall.grade)}</span>`,
    `<p class="turn-judge-comment">${comment}</p>`,
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

function renderFlag(value: number | null): string {
  if (value === null) {
    return `<span class="muted">—</span>`;
  }
  return value === 1 ? "Yes" : "No";
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
            `<div class="accepted-response">${renderOptionalCode(turn.accepted_response_id)}</div>`,
          ].join("");

    return renderTableRow([
      escapeHtml(String(turn.turn_index)),
      renderStatusBadge(turn.status),
      prompt,
      anchor,
      renderOptionalText(turn.marginal_input_tokens),
      renderTime(turn.updated_at),
    ]);
  });

  return renderTable(
    "turn-table",
    ["Turn", "Status", "Prompt", "Accepted anchor", "Marginal tokens", "Updated"],
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
      renderOptionalCode(attempt.provider_response_id),
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

/**
 * Renders a job detail fragment. `deliverables` carries accepted turn text
 * because `JobStateResponse.turns` only exposes turn metadata. Deliverables
 * are ordered by `turnIndex`; model-authored deliverable text is the only
 * unescaped dynamic content and always passes through `renderMarkdown`. Each
 * deliverable card also carries the judge result(s) recorded for its turn and
 * the frozen marginal input token count when one is stored. Turn prompts come
 * from the job state (`TurnRecord.promptText`) because summary rows carry only
 * prompt byte counts; every prompt, table cell, judge comment, and identifier
 * is escaped. A completed job links to its final-markdown download.
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
  for (const turn of job.turns) {
    promptTextByTurnIndex.set(turn.turnIndex, turn.promptText);
    if (turn.marginalInputTokens !== null) {
      marginalTokensByTurnIndex.set(turn.turnIndex, turn.marginalInputTokens);
    }
  }

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
            ),
          )
          .join("");

  const downloadFinal =
    job.job.status === "completed"
      ? `<a class="button download-final" href="/api/jobs/${escapeHtml(encodeURIComponent(job.job.jobId))}/export/markdown" download>Download Final Markdown</a>`
      : "";

  return [
    `<article class="job-detail" data-job-id="${escapeHtml(job.job.jobId)}">`,
    `<header class="job-detail-header">`,
    `<h1 class="job-detail-title">${escapeHtml(job.job.title)}</h1>`,
    `<p class="job-detail-meta">`,
    renderStatusBadge(job.job.status),
    `<span class="job-detail-model">${escapeHtml(job.job.config.model)}</span>`,
    `<span class="job-detail-id">${escapeHtml(job.job.jobId)}</span>`,
    `</p>`,
    `<dl class="job-detail-counters">`,
    renderCount("Turn count", job.turns.length),
    renderCount("Accepted turns", job.job.acceptedTurnCount),
    `</dl>`,
    renderUsageSummary(job),
    downloadFinal,
    `</header>`,
    `<section class="deliverables">`,
    `<h2 class="deliverables-title">Deliverables</h2>`,
    body,
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Turns</h3>`,
    renderTurnsTable(turns, promptTextByTurnIndex),
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Attempts</h3>`,
    renderAttemptsTable(attempts),
    `</section>`,
    `<section class="detail-section">`,
    `<h3 class="detail-section-title">Judge calls</h3>`,
    renderJudgeCallsTable(judgeCalls),
    `</section>`,
    `</article>`,
  ].join("");
}