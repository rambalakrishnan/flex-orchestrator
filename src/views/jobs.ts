/**
 * Job HTML views (`src/views/jobs.ts`) — server-rendered, self-contained HTML
 * fragments for the job list and job detail screens.
 *
 * Every fragment is intended for an `innerHTML` swap. Only accepted deliverable
 * text is inserted through `renderMarkdown`; every other dynamic value flows
 * through `escapeHtml`. Raw prompts, file ids, error details, and credentials
 * are never interpolated here.
 */

import { escapeHtml, renderMarkdown } from "../lib/markdown.ts";
import type { JobStateResponse, JobSummaryItem, TurnIndex, TurnStatus } from "../types.ts";

export interface JobDeliverable {
  readonly turnIndex: TurnIndex;
  readonly status: TurnStatus;
  readonly text: string;
}

function renderStatusBadge(status: string): string {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
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

function renderDeliverable(deliverable: JobDeliverable): string {
  return [
    `<section class="deliverable" data-turn-index="${escapeHtml(String(deliverable.turnIndex))}">`,
    `<header class="deliverable-header">`,
    `<h3 class="deliverable-turn">Turn ${escapeHtml(String(deliverable.turnIndex))}</h3>`,
    renderStatusBadge(deliverable.status),
    `</header>`,
    `<div class="deliverable-content">${renderMarkdown(deliverable.text)}</div>`,
    `</section>`,
  ].join("");
}

/**
 * Renders a job detail fragment. `deliverables` carries accepted turn text
 * because `JobStateResponse.turns` only exposes turn metadata. Deliverables
 * are ordered by `turnIndex`; model-authored text is the only unescaped
 * dynamic content and always passes through `renderMarkdown`.
 */
export function renderJobDetail(
  job: JobStateResponse,
  deliverables: readonly JobDeliverable[],
): string {
  const sorted = [...deliverables].sort((a, b) => a.turnIndex - b.turnIndex);
  const body =
    sorted.length === 0
      ? `<p class="empty-state">No accepted deliverables yet.</p>`
      : sorted.map(renderDeliverable).join("");

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
    `</header>`,
    `<section class="deliverables">`,
    `<h2 class="deliverables-title">Deliverables</h2>`,
    body,
    `</section>`,
    `</article>`,
  ].join("");
}