// Covers: 10, 24

import { describe, expect, it } from "vitest";

import {
  FALLBACK_POLL_FIRST_DELAY_MS,
  FALLBACK_POLL_SECOND_DELAY_MS,
  FALLBACK_POLL_STEADY_DELAY_MS,
  MAX_FALLBACK_POLL_PROBES,
  PLATFORM_ALARM_MAX_RETRIES,
  PLATFORM_ALARM_MAX_WALL_TIME_MS,
} from "../../src/constants.ts";
import {
  ALARM_RETRY_RESCHEDULE_THRESHOLD,
  ALARM_SAFE_EXECUTION_BUDGET_MS,
  DEFAULT_RETRY_EXHAUSTION_DELAY_MS,
  earliestDeadline,
  ensureAlarmIfNone,
  ensureAlarmNotLaterThan,
  getFallbackPollDelayMs,
  getNextFallbackPollAt,
  hasRemainingFallbackProbes,
  isAlarmWallTimeBudgetExceeded,
  runWithAlarmSafety,
  scheduleEarliestAlarm,
  scheduleNextObligationFromAlarm,
  toEpochMillis,
  type AlarmStorage,
} from "../../src/lib/alarm.ts";

const NOW = 1_700_000_000_000;

type SetAlarmOptions = Parameters<AlarmStorage["setAlarm"]>[1];
type AlarmInfo = NonNullable<Parameters<typeof runWithAlarmSafety>[1]>;

interface SetAlarmCall {
  readonly scheduledTime: number | Date;
  readonly options: SetAlarmOptions;
}

/**
 * In-memory `AlarmStorage` double. Records every call so tests can assert the
 * exact scheduling decisions without real timers or a Durable Object.
 */
class FakeAlarmStorage implements AlarmStorage {
  readonly setAlarmCalls: SetAlarmCall[] = [];
  readonly deleteAlarmCalls: SetAlarmOptions[] = [];
  getAlarmCallCount = 0;
  private alarm: number | null;

  constructor(initialAlarm: number | null = null) {
    this.alarm = initialAlarm;
  }

  async getAlarm(): Promise<number | null> {
    this.getAlarmCallCount += 1;
    return this.alarm;
  }

  async setAlarm(
    scheduledTime: number | Date,
    options?: SetAlarmOptions,
  ): Promise<void> {
    this.setAlarmCalls.push({ scheduledTime, options });
    this.alarm =
      scheduledTime instanceof Date
        ? scheduledTime.getTime()
        : scheduledTime;
  }

  async deleteAlarm(options?: SetAlarmOptions): Promise<void> {
    this.deleteAlarmCalls.push(options);
    this.alarm = null;
  }
}

function makeAlarmInfo(retryCount: number): AlarmInfo {
  return { isRetry: retryCount > 0, retryCount, scheduledTime: NOW };
}

describe("toEpochMillis", () => {
  it("normalizes numbers and Dates to floored epoch milliseconds", () => {
    expect(toEpochMillis(NOW)).toBe(NOW);
    expect(toEpochMillis(NOW + 0.9)).toBe(NOW);
    expect(toEpochMillis(new Date(NOW + 123))).toBe(NOW + 123);
  });

  it("rejects non-finite timestamps", () => {
    expect(() => toEpochMillis(Number.NaN)).toThrow(RangeError);
    expect(() => toEpochMillis(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toEpochMillis(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
    expect(() => toEpochMillis(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("earliestDeadline", () => {
  it("returns null for an empty candidate set", () => {
    expect(earliestDeadline([])).toBeNull();
  });

  it("returns null when every candidate is null or undefined", () => {
    expect(earliestDeadline([null, undefined, null])).toBeNull();
  });

  it("returns the earliest finite timestamp across numbers and Dates", () => {
    expect(
      earliestDeadline([NOW + 5_000, new Date(NOW + 1_000), null, undefined]),
    ).toBe(NOW + 1_000);
    expect(earliestDeadline(new Set([NOW + 9, NOW + 3]))).toBe(NOW + 3);
    expect(earliestDeadline([NOW + 4.9, NOW + 7])).toBe(NOW + 4);
  });

  it("skips null/undefined but rejects a NaN candidate via toEpochMillis", () => {
    // Implemented behavior: every non-null candidate is validated by
    // toEpochMillis, so NaN/Infinity throw rather than being skipped.
    expect(() => earliestDeadline([NOW, Number.NaN])).toThrow(RangeError);
    expect(() => earliestDeadline([null, Number.POSITIVE_INFINITY])).toThrow(
      RangeError,
    );
  });
});

describe("fallback poll timing", () => {
  it("exposes the five-minute, one-minute, five-minute schedule", () => {
    expect(MAX_FALLBACK_POLL_PROBES).toBe(24);
    expect(FALLBACK_POLL_FIRST_DELAY_MS).toBe(300_000);
    expect(FALLBACK_POLL_SECOND_DELAY_MS).toBe(60_000);
    expect(FALLBACK_POLL_STEADY_DELAY_MS).toBe(300_000);
  });

  it("maps completed probes 0 and 1 to five and one minutes", () => {
    expect(getFallbackPollDelayMs(0)).toBe(300_000);
    expect(getFallbackPollDelayMs(1)).toBe(60_000);
  });

  it("maps completed probes 2..23 to the steady five-minute delay", () => {
    expect(getFallbackPollDelayMs(2)).toBe(300_000);
    expect(getFallbackPollDelayMs(23)).toBe(300_000);
  });

  it("returns null at the 24-probe bound and for negative/non-integer probes", () => {
    expect(getFallbackPollDelayMs(24)).toBeNull();
    expect(getFallbackPollDelayMs(25)).toBeNull();
    expect(getFallbackPollDelayMs(-1)).toBeNull();
    expect(getFallbackPollDelayMs(1.5)).toBeNull();
    expect(getFallbackPollDelayMs(Number.NaN)).toBeNull();
  });

  it("returns false from hasRemainingFallbackProbes once 24 probes are done", () => {
    expect(hasRemainingFallbackProbes(0)).toBe(true);
    expect(hasRemainingFallbackProbes(23)).toBe(true);
    expect(hasRemainingFallbackProbes(24)).toBe(false);
    expect(hasRemainingFallbackProbes(-1)).toBe(false);
    expect(hasRemainingFallbackProbes(2.5)).toBe(false);
  });

  it("computes the next poll as now plus the schedule delay", () => {
    expect(getNextFallbackPollAt(0, NOW)).toBe(NOW + 300_000);
    expect(getNextFallbackPollAt(1, NOW)).toBe(NOW + 60_000);
    expect(getNextFallbackPollAt(2, NOW)).toBe(NOW + 300_000);
    expect(getNextFallbackPollAt(23, NOW)).toBe(NOW + 300_000);
    expect(getNextFallbackPollAt(24, NOW)).toBeNull();
    expect(getNextFallbackPollAt(-1, NOW)).toBeNull();
  });

  it("defaults the reference timestamp to the current clock", () => {
    const before = Date.now();
    const next = getNextFallbackPollAt(0);
    const after = Date.now();
    expect(next).not.toBeNull();
    expect(next as number).toBeGreaterThanOrEqual(before + 300_000);
    expect(next as number).toBeLessThanOrEqual(after + 300_000);
  });
});

describe("ensureAlarmNotLaterThan", () => {
  it("schedules the deadline when no alarm exists and returns it", async () => {
    const storage = new FakeAlarmStorage(null);

    const scheduled = await ensureAlarmNotLaterThan(storage, NOW + 1_000);

    expect(scheduled).toBe(NOW + 1_000);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_000, options: undefined },
    ]);
  });

  it("replaces a later existing alarm with the earlier deadline", async () => {
    const storage = new FakeAlarmStorage(NOW + 60_000);

    const scheduled = await ensureAlarmNotLaterThan(storage, NOW + 1_000);

    expect(scheduled).toBe(NOW + 1_000);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_000, options: undefined },
    ]);
  });

  it("preserves an earlier existing alarm without calling setAlarm", async () => {
    const storage = new FakeAlarmStorage(NOW + 500);

    const scheduled = await ensureAlarmNotLaterThan(storage, NOW + 9_000);

    expect(scheduled).toBe(NOW + 500);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("does not replace an alarm that is exactly equal", async () => {
    const storage = new FakeAlarmStorage(NOW + 2_000);

    const scheduled = await ensureAlarmNotLaterThan(storage, NOW + 2_000);

    expect(scheduled).toBe(NOW + 2_000);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("accepts Date deadlines and flattens fractional milliseconds", async () => {
    const storage = new FakeAlarmStorage(null);

    const scheduled = await ensureAlarmNotLaterThan(
      storage,
      new Date(NOW + 1_234),
    );

    expect(scheduled).toBe(NOW + 1_234);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_234, options: undefined },
    ]);
  });

  it("forwards setAlarm options", async () => {
    const storage = new FakeAlarmStorage(null);
    const options = { allowConcurrency: true };

    await ensureAlarmNotLaterThan(storage, NOW + 10, options);

    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 10, options },
    ]);
  });

  it("rejects NaN and Infinity deadlines before touching storage", async () => {
    const storage = new FakeAlarmStorage(NOW + 5_000);

    await expect(ensureAlarmNotLaterThan(storage, Number.NaN)).rejects.toThrow(
      RangeError,
    );
    await expect(
      ensureAlarmNotLaterThan(storage, Number.POSITIVE_INFINITY),
    ).rejects.toThrow(RangeError);

    expect(storage.getAlarmCallCount).toBe(0);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("is exported under the scheduleEarliestAlarm alias", () => {
    expect(scheduleEarliestAlarm).toBe(ensureAlarmNotLaterThan);
  });
});

describe("ensureAlarmIfNone", () => {
  it("schedules the deadline when no alarm is set", async () => {
    const storage = new FakeAlarmStorage(null);

    const scheduled = await ensureAlarmIfNone(storage, NOW + 4_000);

    expect(scheduled).toBe(NOW + 4_000);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 4_000, options: undefined },
    ]);
  });

  it("leaves an existing alarm untouched even when it is later", async () => {
    const storage = new FakeAlarmStorage(NOW + 90_000);

    const scheduled = await ensureAlarmIfNone(storage, NOW + 1_000);

    expect(scheduled).toBe(NOW + 90_000);
    expect(storage.setAlarmCalls).toEqual([]);
  });
});

describe("scheduleNextObligationFromAlarm", () => {
  it("preserves an alarm already set during this invocation when nextDue is null", async () => {
    const storage = new FakeAlarmStorage(NOW + 7_000);

    const scheduled = await scheduleNextObligationFromAlarm(storage, null);

    expect(scheduled).toBe(NOW + 7_000);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("preserves an alarm already set during this invocation when nextDue is undefined", async () => {
    const storage = new FakeAlarmStorage(NOW + 7_000);

    const scheduled = await scheduleNextObligationFromAlarm(
      storage,
      undefined,
    );

    expect(scheduled).toBe(NOW + 7_000);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("returns null and schedules nothing when nextDue is null and no alarm is set", async () => {
    const storage = new FakeAlarmStorage(null);

    const scheduled = await scheduleNextObligationFromAlarm(storage, null);

    expect(scheduled).toBeNull();
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("replaces the current alarm when nextDue is earlier", async () => {
    const storage = new FakeAlarmStorage(NOW + 60_000);

    const scheduled = await scheduleNextObligationFromAlarm(
      storage,
      NOW + 1_000,
    );

    expect(scheduled).toBe(NOW + 1_000);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_000, options: undefined },
    ]);
  });

  it("preserves the current alarm when nextDue is later", async () => {
    const storage = new FakeAlarmStorage(NOW + 1_000);

    const scheduled = await scheduleNextObligationFromAlarm(
      storage,
      NOW + 60_000,
    );

    expect(scheduled).toBe(NOW + 1_000);
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("schedules Date nextDue values when no alarm is set", async () => {
    const storage = new FakeAlarmStorage(null);

    const scheduled = await scheduleNextObligationFromAlarm(
      storage,
      new Date(NOW + 3_210),
    );

    expect(scheduled).toBe(NOW + 3_210);
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 3_210, options: undefined },
    ]);
  });
});

describe("isAlarmWallTimeBudgetExceeded", () => {
  it("exposes a 14-minute safe budget under the 15-minute platform limit", () => {
    expect(PLATFORM_ALARM_MAX_WALL_TIME_MS).toBe(15 * 60 * 1_000);
    expect(ALARM_SAFE_EXECUTION_BUDGET_MS).toBe(14 * 60 * 1_000);
    expect(ALARM_SAFE_EXECUTION_BUDGET_MS).toBeLessThan(PLATFORM_ALARM_MAX_WALL_TIME_MS);
    expect(ALARM_RETRY_RESCHEDULE_THRESHOLD).toBe(5);
    expect(PLATFORM_ALARM_MAX_RETRIES).toBe(6);
    expect(ALARM_RETRY_RESCHEDULE_THRESHOLD).toBeLessThan(
      PLATFORM_ALARM_MAX_RETRIES,
    );
    expect(DEFAULT_RETRY_EXHAUSTION_DELAY_MS).toBe(30_000);
  });

  it("is false below the default budget and true at/over it", () => {
    const startedAt = 0;

    expect(isAlarmWallTimeBudgetExceeded(startedAt, 839_999)).toBe(false);
    expect(isAlarmWallTimeBudgetExceeded(startedAt, 840_000)).toBe(true);
    expect(isAlarmWallTimeBudgetExceeded(startedAt, 900_000)).toBe(true);
  });

  it("honors a custom budget", () => {
    expect(isAlarmWallTimeBudgetExceeded(NOW, NOW + 999, 1_000)).toBe(false);
    expect(isAlarmWallTimeBudgetExceeded(NOW, NOW + 1_000, 1_000)).toBe(true);
  });
});

describe("runWithAlarmSafety", () => {
  it("returns the work value and schedules nothing for void work", async () => {
    const storage = new FakeAlarmStorage(null);
    const info = makeAlarmInfo(0);
    let received: AlarmInfo | undefined;

    const outcome = await runWithAlarmSafety(storage, info, (passed) => {
      received = passed;
      return undefined;
    });

    expect(received).toBe(info);
    expect(outcome).toMatchObject({
      status: "completed",
      nextAlarmAt: null,
    });
    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("schedules a numeric work result as the next obligation", async () => {
    const storage = new FakeAlarmStorage(null);

    const outcome = await runWithAlarmSafety(storage, undefined, () =>
      Promise.resolve(NOW + 5_000),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      value: NOW + 5_000,
      nextAlarmAt: NOW + 5_000,
    });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 5_000, options: undefined },
    ]);
  });

  it("schedules a Date work result as the next obligation", async () => {
    const storage = new FakeAlarmStorage(null);

    const outcome = await runWithAlarmSafety(storage, undefined, async () =>
      new Date(NOW + 2_500),
    );

    expect(outcome).toMatchObject({
      status: "completed",
      nextAlarmAt: NOW + 2_500,
    });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 2_500, options: undefined },
    ]);
  });

  it("does not overwrite an earlier alarm already set by the work", async () => {
    const storage = new FakeAlarmStorage(null);

    const outcome = await runWithAlarmSafety(storage, undefined, async () => {
      await storage.setAlarm(NOW + 1_000);
      return NOW + 60_000;
    });

    expect(outcome).toMatchObject({ nextAlarmAt: NOW + 1_000 });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_000, options: undefined },
    ]);
  });

  it("rethrows the original error while the platform retry budget remains", async () => {
    for (const retryCount of [0, 1, 4]) {
      const storage = new FakeAlarmStorage(null);
      const original = new Error(`transient ${retryCount}`);

      await expect(
        runWithAlarmSafety(storage, makeAlarmInfo(retryCount), async () => {
          throw original;
        }),
      ).rejects.toBe(original);

      expect(storage.setAlarmCalls).toEqual([]);
    }
  });

  it("rethrows when alarmInfo is undefined (retryCount defaults to 0)", async () => {
    const storage = new FakeAlarmStorage(null);
    const original = new Error("first failure");

    await expect(
      runWithAlarmSafety(storage, undefined, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(storage.setAlarmCalls).toEqual([]);
  });

  it("reschedules a fresh alarm once retryCount reaches the threshold", async () => {
    for (const retryCount of [5, 6]) {
      const storage = new FakeAlarmStorage(null);
      const original = new Error(`exhausted ${retryCount}`);

      const outcome = await runWithAlarmSafety(
        storage,
        makeAlarmInfo(retryCount),
        async () => {
          throw original;
        },
        { now: () => NOW },
      );

      expect(outcome).toMatchObject({
        status: "rescheduled_on_retry_limit",
        error: original,
        retryCount,
        nextAlarmAt: NOW + DEFAULT_RETRY_EXHAUSTION_DELAY_MS,
      });
      expect(storage.setAlarmCalls).toEqual([
        { scheduledTime: NOW + DEFAULT_RETRY_EXHAUSTION_DELAY_MS, options: undefined },
      ]);
      expect(outcome.status).toBe("rescheduled_on_retry_limit");
      if (outcome.status === "rescheduled_on_retry_limit") {
        expect(outcome.nextAlarmAt).toBeGreaterThan(NOW);
      }
    }
  });

  it("replaces an existing later alarm with the retry-exhaustion alarm", async () => {
    const storage = new FakeAlarmStorage(NOW + 120_000);

    const outcome = await runWithAlarmSafety(
      storage,
      makeAlarmInfo(5),
      async () => {
        throw new Error("exhausted");
      },
      { now: () => NOW },
    );

    expect(outcome).toMatchObject({
      nextAlarmAt: NOW + DEFAULT_RETRY_EXHAUSTION_DELAY_MS,
    });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + DEFAULT_RETRY_EXHAUSTION_DELAY_MS, options: undefined },
    ]);
  });

  it("preserves an earlier alarm scheduled by the work before it threw", async () => {
    const storage = new FakeAlarmStorage(null);

    const outcome = await runWithAlarmSafety(
      storage,
      makeAlarmInfo(5),
      async () => {
        await storage.setAlarm(NOW + 1_000);
        throw new Error("failed after scheduling");
      },
      { now: () => NOW },
    );

    expect(outcome).toMatchObject({ nextAlarmAt: NOW + 1_000 });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 1_000, options: undefined },
    ]);
  });

  it("honors custom retryThreshold and retryExhaustionDelayMs", async () => {
    const storage = new FakeAlarmStorage(null);
    const original = new Error("custom threshold");

    const outcome = await runWithAlarmSafety(
      storage,
      makeAlarmInfo(2),
      async () => {
        throw original;
      },
      { retryThreshold: 2, retryExhaustionDelayMs: 5_000, now: () => NOW },
    );

    expect(outcome).toMatchObject({
      status: "rescheduled_on_retry_limit",
      retryCount: 2,
      nextAlarmAt: NOW + 5_000,
    });
    expect(storage.setAlarmCalls).toEqual([
      { scheduledTime: NOW + 5_000, options: undefined },
    ]);
  });

  it("invokes onRetryExhausted with the error, retry count, and scheduled time", async () => {
    const storage = new FakeAlarmStorage(null);
    const original = new Error("notify");
    const calls: Array<{
      error: unknown;
      retryCount: number;
      rescheduledAt: number;
    }> = [];

    await runWithAlarmSafety(
      storage,
      makeAlarmInfo(5),
      async () => {
        throw original;
      },
      {
        now: () => NOW,
        onRetryExhausted: (error, retryCount, rescheduledAt) => {
          calls.push({ error, retryCount, rescheduledAt });
        },
      },
    );

    expect(calls).toEqual([
      {
        error: original,
        retryCount: 5,
        rescheduledAt: NOW + DEFAULT_RETRY_EXHAUSTION_DELAY_MS,
      },
    ]);
  });

  it("does not invoke onRetryExhausted when the work succeeds", async () => {
    const storage = new FakeAlarmStorage(null);
    let calls = 0;

    await runWithAlarmSafety(storage, makeAlarmInfo(5), async () => undefined, {
      now: () => NOW,
      onRetryExhausted: () => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
    expect(storage.setAlarmCalls).toEqual([]);
  });
});