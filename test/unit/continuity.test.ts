// Covers: 8

import { describe, expect, it } from "vitest";

import {
  cachePayload,
  isCacheTtl,
  judgeHistoryToContinuityMode,
  reasoningContinuityPayload,
  resolvePreviousResponseId,
} from "../../src/lib/continuity.ts";
import type {
  CacheTtl,
  ContinuityAnchor,
  ContinuityMode,
} from "../../src/types.ts";
import { ANCHOR_RESPONSE_ID } from "../fixtures/requests.ts";

const OBJECT_ANCHOR: ContinuityAnchor = { previous_response_id: ANCHOR_RESPONSE_ID };

interface ContinuityCase {
  readonly label: string;
  readonly mode: ContinuityMode;
  readonly anchor: ContinuityAnchor | string | null | undefined;
  readonly expectedSerialized: string;
  readonly expectedKeys: readonly string[];
}

const CONTINUITY_CASES: readonly ContinuityCase[] = [
  {
    label: "stateful + object anchor",
    mode: "stateful",
    anchor: OBJECT_ANCHOR,
    expectedSerialized: `{"previous_response_id":"${ANCHOR_RESPONSE_ID}","store":true}`,
    expectedKeys: ["previous_response_id", "store"],
  },
  {
    label: "stateful + string anchor (trimmed)",
    mode: "stateful",
    anchor: `  ${ANCHOR_RESPONSE_ID}\n`,
    expectedSerialized: `{"previous_response_id":"${ANCHOR_RESPONSE_ID}","store":true}`,
    expectedKeys: ["previous_response_id", "store"],
  },
  {
    label: "stateful + absent anchor",
    mode: "stateful",
    anchor: undefined,
    expectedSerialized: '{"store":true}',
    expectedKeys: ["store"],
  },
  {
    label: "stateful + null anchor",
    mode: "stateful",
    anchor: null,
    expectedSerialized: '{"store":true}',
    expectedKeys: ["store"],
  },
  {
    label: "stateless + object anchor",
    mode: "stateless",
    anchor: OBJECT_ANCHOR,
    expectedSerialized:
      '{"store":false,"include":["reasoning.encrypted_content"]}',
    expectedKeys: ["include", "store"],
  },
  {
    label: "stateless + absent anchor",
    mode: "stateless",
    anchor: undefined,
    expectedSerialized:
      '{"store":false,"include":["reasoning.encrypted_content"]}',
    expectedKeys: ["include", "store"],
  },
];

describe("reasoningContinuityPayload", () => {
  it.each(CONTINUITY_CASES)(
    "serializes exactly for $label",
    ({ mode, anchor, expectedSerialized, expectedKeys }) => {
      const payload = reasoningContinuityPayload(mode, anchor);

      expect(JSON.stringify(payload)).toBe(expectedSerialized);
      expect(JSON.parse(expectedSerialized)).toEqual(payload);
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);
    },
  );

  it("anchors stateful continuity only when a non-empty anchor exists", () => {
    const anchored = reasoningContinuityPayload("stateful", OBJECT_ANCHOR);
    expect(
      "previous_response_id" in anchored
        ? anchored.previous_response_id
        : undefined,
    ).toBe(ANCHOR_RESPONSE_ID);
    expect(anchored.store).toBe(true);
    expect("include" in anchored).toBe(false);

    const unanchored = reasoningContinuityPayload("stateful");
    expect("previous_response_id" in unanchored).toBe(false);
    expect(unanchored).toEqual({ store: true });
    expect("include" in unanchored).toBe(false);
  });

  it("never sends include in the stateful branch", () => {
    const payload = reasoningContinuityPayload("stateful", OBJECT_ANCHOR);
    expect(JSON.stringify(payload)).not.toContain("include");
    expect("include" in payload).toBe(false);
  });

  it("always sends encrypted reasoning content and store:false when stateless", () => {
    for (const anchor of [OBJECT_ANCHOR, undefined, null, ANCHOR_RESPONSE_ID]) {
      const payload = reasoningContinuityPayload("stateless", anchor);
      expect(payload).toEqual({
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      expect("previous_response_id" in payload).toBe(false);
      expect(
        JSON.stringify(payload).includes("previous_response_id"),
      ).toBe(false);
    }
  });

  it("ignores whitespace-only and empty anchors even in the stateful branch", () => {
    for (const anchor of ["", "   ", "\n\t ", { previous_response_id: "  " }]) {
      expect(reasoningContinuityPayload("stateful", anchor)).toEqual({
        store: true,
      });
    }
  });
});

describe("resolvePreviousResponseId", () => {
  it("returns trimmed string and object anchors", () => {
    expect(resolvePreviousResponseId(`  ${ANCHOR_RESPONSE_ID}  `)).toBe(
      ANCHOR_RESPONSE_ID,
    );
    expect(resolvePreviousResponseId(OBJECT_ANCHOR)).toBe(ANCHOR_RESPONSE_ID);
  });

  it("ignores undefined, null, empty, and whitespace-only anchors", () => {
    expect(resolvePreviousResponseId()).toBeNull();
    expect(resolvePreviousResponseId(null)).toBeNull();
    expect(resolvePreviousResponseId("")).toBeNull();
    expect(resolvePreviousResponseId("   ")).toBeNull();
    expect(resolvePreviousResponseId({ previous_response_id: "" })).toBeNull();
    expect(resolvePreviousResponseId({ previous_response_id: " \t " })).toBeNull();
  });

  it("ignores a non-string previous_response_id rather than coercing it", () => {
    const malformed = { previous_response_id: 42 } as unknown as ContinuityAnchor;
    expect(resolvePreviousResponseId(malformed)).toBeNull();
  });
});

describe("judgeHistoryToContinuityMode", () => {
  it("maps chained history to stateful continuity", () => {
    expect(judgeHistoryToContinuityMode("chained")).toBe("stateful");
  });

  it("maps stateless history to stateless continuity", () => {
    expect(judgeHistoryToContinuityMode("stateless")).toBe("stateless");
  });

  it("produces continuity payloads through the shared helper for both modes", () => {
    expect(
      reasoningContinuityPayload(judgeHistoryToContinuityMode("chained")),
    ).toEqual({ store: true });
    expect(
      reasoningContinuityPayload(judgeHistoryToContinuityMode("stateless")),
    ).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });
});

describe("cachePayload", () => {
  const cacheCases: readonly CacheTtl[] = ["30m", "12h", "nocache"];

  it.each(cacheCases)("emits current prompt cache options for %s", (cacheTtl) => {
    const payload = cachePayload(cacheTtl);

    expect(payload).toEqual(
      cacheTtl === "nocache"
        ? { prompt_cache_options: { mode: "explicit" } }
        : { prompt_cache_options: { ttl: cacheTtl } },
    );
    expect(Object.keys(payload)).toEqual(["prompt_cache_options"]);
    expect("prompt_cache_retention" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("prompt_cache_retention");
  });

  it("disables caching for nocache with explicit mode and no TTL", () => {
    const payload = cachePayload("nocache");
    expect(payload).toEqual({ prompt_cache_options: { mode: "explicit" } });
    expect(JSON.stringify(payload)).not.toContain("30m");
    expect(JSON.stringify(payload)).not.toContain("12h");
    expect(JSON.stringify(payload)).not.toContain("24h");
  });

  it("recognizes only the four supported cache choices", () => {
    for (const choice of cacheCases) {
      expect(isCacheTtl(choice)).toBe(true);
    }
    expect(isCacheTtl("1h")).toBe(false);
    expect(isCacheTtl("")).toBe(false);
  });
});