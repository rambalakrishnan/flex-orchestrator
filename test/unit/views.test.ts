// Covers: view contract for collapsed long-form previews in the job detail.

import { describe, expect, it } from "vitest";

import type {
  GenerationAttemptSummaryRow,
  JudgeCallSummaryRow,
  TurnSummaryRow,
} from "../../src/db/schema.ts";
import type { JobStateResponse } from "../../src/types.ts";
import { renderJobDetail, type JobDeliverable } from "../../src/views/jobs.ts";

const NOW_ISO = "2026-11-09T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function jobState(overrides: Partial<JobStateResponse> = {}): JobStateResponse {
  return {
    job: {
      jobId: "job_views",
      title: "Views fixture job",
      status: "completed",
      revision: 3,
      config: {
        model: "gpt-5",
        reasoningEffort: "medium",
        maxOutputTokens: 4096,
        cacheTtl: "nocache",
        webSearch: false,
        developerPrompt: "",
        developerFileIds: [],
        maxContinuations: 3,
        maxAutoRetries: 1,
        judge: { enabled: false },
      },
      currentTurnIndex: 1,
      continuationsUsed: 0,
      autoRetriesUsed: 0,
      acceptedTurnCount: 1,
      lastAcceptedResponseId: "resp_accepted",
      lastJudgeResponseId: null,
      branchProvenance: null,
      supersededByJobId: null,
      warningMessages: [],
      errorMessage: null,
      errorCode: null,
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    },
    turns: [
      {
        jobId: "job_views",
        turnIndex: 1,
        status: "accepted",
        promptText: "Write the first section.",
        attachmentFileIds: [],
        continuationsUsed: 0,
        activeAttemptId: null,
        acceptedAttemptId: "job_views:t1:a1",
        acceptedDeliverableBytes: 64,
        marginalInputTokens: 12,
        acceptedResponseId: "resp_accepted",
        judgeCallId: "job_views:t1:a1:judge",
        warningMessages: [],
        revision: 3,
        createdAtMs: NOW_MS,
        updatedAtMs: NOW_MS,
      },
    ],
    activeAttempt: null,
    usage: {
      generationCalls: 1,
      judgeCalls: 1,
      missingUsageCalls: 0,
      unknownPricingCalls: 0,
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 8,
      reasoningTokens: 0,
      totalTokens: 20,
      totalEstimatedCostUsd: null,
    },
    pollIntervalMs: 12_000,
    ...overrides,
  };
}

function turnRow(overrides: Partial<TurnSummaryRow> = {}): TurnSummaryRow {
  return {
    turn_index: 1,
    status: "accepted",
    prompt_bytes: 24,
    row_bytes: 128,
    attachment_file_ids_json: "[]",
    accepted_candidate_id: "job_views:t1:a1:candidate",
    accepted_attempt_id: "job_views:t1:a1",
    accepted_response_id: "resp_accepted",
    accepted_with_warning: 0,
    marginal_input_tokens: 12,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function judgeRow(overrides: Partial<JudgeCallSummaryRow> = {}): JudgeCallSummaryRow {
  return {
    judge_call_id: "job_views:t1:a1:judge",
    turn_index: 1,
    candidate_id: "job_views:t1:a1:candidate",
    attempt_id: "job_views:t1:a1",
    transport: "responses",
    history_mode: "stateless",
    file_delivery_mode: "passthrough",
    model: "gpt-6.1-sol",
    provider_response_id: "resp_judge",
    previous_judge_response_id: null,
    status: "completed",
    verdict: "PASS",
    grade: 92,
    comment: "Tight structure and faithful coverage of the turn prompt.",
    tag_agreement: 1,
    file_visibility: 1,
    manifest_json: "[]",
    request_bytes: 512,
    row_bytes: 640,
    usage_json: null,
    diagnostics_json: "{}",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function attempts(): readonly GenerationAttemptSummaryRow[] {
  return [];
}

function deliverables(text: string): readonly JobDeliverable[] {
  return [{ turnIndex: 1, status: "accepted", text }];
}

describe("long-form preview expanders", () => {
  it("wraps deliverable bodies and judge comments in collapsed expanders", () => {
    const longText = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n");
    const html = renderJobDetail(
      jobState(),
      deliverables(longText),
      [turnRow()],
      attempts(),
      [judgeRow()],
    );

    expect(html).toContain('data-expand-id="deliverable-turn-1"');
    expect(html).toContain('data-expand-id="judge-comment-job_views:t1:a1:judge"');
    expect(html).toContain('class="expandable-body"');
    expect(html).toContain(
      '<button type="button" class="expand-toggle" aria-expanded="false">Show more</button>',
    );
    expect(html).not.toContain('data-open="true"');
    // Full content stays in the DOM; the preview is purely presentational.
    expect(html).toContain("Line 40");
    expect(html).toContain("Tight structure and faithful coverage");
  });

  it("leaves muted judge comments unwrapped", () => {
    const html = renderJobDetail(
      jobState(),
      deliverables("Short deliverable."),
      [turnRow()],
      attempts(),
      [judgeRow({ comment: null })],
    );

    expect(html).toContain('data-expand-id="deliverable-turn-1"');
    expect(html).not.toContain('data-expand-id="judge-comment-');
    expect(html).toContain('<span class="muted">—</span>');
  });
});
