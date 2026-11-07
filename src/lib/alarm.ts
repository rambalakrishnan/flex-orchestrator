/**
 * AlarmTiming — earliest-obligation scheduling, fallback-poll timing,
 * and retry-budget-safe alarm execution helpers for Durable Objects.
 *
 * Key invariants (per docs/ALARMTIMING.md and docs/ARCHITECTURE.md):
 * 1. `setAlarm()` always overwrites any existing alarm. Preserving an earlier
 *    obligation requires a read-modify-write (`getAlarm()` -> compare -> `setAlarm()`).
 * 2. Durable Object constructors must NEVER call `setAlarm()` unconditionally;
 *    doing so extends the alarm TTL on hibernation wake-up before `alarm()` runs.
 * 3. Inside an active `alarm()` invocation, `getAlarm()` returns `null` unless
 *    `setAlarm()` has already been called during that invocation. Post-alarm
 *    rescheduling must call `setAlarm(nextDue)` directly when work remains.
 * 4. Platform alarm execution is at-least-once with up to 6 automatic retries
 *    (exponential backoff starting at 2s). Throwing when `retryCount >= 5`
 *    permanently drops the alarm; the handler wrapper catches and schedules a
 *    fresh fallback alarm before the retry budget is exhausted.
 * 5. Each alarm invocation has a 15-minute platform wall-time ceiling.
 * 6. Fallback polling follows the 5-minute, 1-minute, and 5-minute schedule
 *    with a 24-probe bound.
 */

/** Minimal storage surface required for Durable Object alarm operations. */
export type AlarmStorage = Pick<
  DurableObjectStorage,
  "getAlarm" | "setAlarm" | "deleteAlarm"
>;

/** Platform maximum automatic retry count for a failing `alarm()` handler. */
export const PLATFORM_ALARM_MAX_RETRIES = 6;

/**
 * Retry count threshold at which `runWithAlarmSafety` intercepts errors and
 * schedules a fresh alarm instead of allowing the final retry to throw and drop
 * the alarm permanently (`retryCount` is 0-indexed on retries or 1..6 depending
 * on platform invocation; `>= 5` protects the 6-retry budget).
 */
export const ALARM_RETRY_RESCHEDULE_THRESHOLD = 5;

/** Default fallback delay (ms) when rescheduling after retry-budget exhaustion. */
export const DEFAULT_RETRY_EXHAUSTION_DELAY_MS = 30_000;

/** Platform maximum wall-clock execution time (ms) per alarm invocation (15 minutes). */
export const ALARM_MAX_WALL_TIME_MS = 15 * 60 * 1_000;

/** Safe per-invocation wall-clock budget (ms) leaving headroom below the 15-minute limit. */
export const ALARM_SAFE_EXECUTION_BUDGET_MS = 14 * 60 * 1_000;

/** Maximum number of fallback poll probes per attempt before stopping automatic polling. */
export const FALLBACK_POLL_MAX_PROBES = 24;

/** First fallback poll delay: 5 minutes (ms). */
export const FALLBACK_POLL_FIRST_DELAY_MS = 5 * 60 * 1_000;

/** Second fallback poll delay: 1 minute (ms). */
export const FALLBACK_POLL_SECOND_DELAY_MS = 1 * 60 * 1_000;

/** Subsequent fallback poll delay (probes 3..24): 5 minutes (ms). */
export const FALLBACK_POLL_STEADY_DELAY_MS = 5 * 60 * 1_000;

/**
 * Normalizes a `number | Date` timestamp to epoch milliseconds and validates finiteness.
 */
export function toEpochMillis(time: number | Date): number {
  const ms = typeof time === "number" ? time : time.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError(`Invalid alarm timestamp: ${String(time)}`);
  }
  return Math.floor(ms);
}

/**
 * Computes the earliest deadline (in epoch ms) from a collection of candidate
 * timestamps (`number | Date | null | undefined`). Returns `null` if no valid
 * finite timestamps are present.
 */
export function earliestDeadline(
  candidates: Iterable<number | Date | null | undefined>,
): number | null {
  let earliest: number | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const ms = toEpochMillis(candidate);
    if (earliest === null || ms < earliest) {
      earliest = ms;
    }
  }
  return earliest;
}

/**
 * Read-modify-write helper for scheduling a Durable Object alarm against its
 * earliest obligation outside of `alarm()` (or safely across concurrent requests).
 *
 * - Reads `storage.getAlarm()`.
 * - Schedules `deadline` ONLY if no alarm is currently set (`current === null`)
 *   or if `deadline < current`.
 * - Never overwrites an earlier pending alarm with a later one.
 *
 * @returns The resulting scheduled alarm timestamp (epoch ms).
 */
export async function ensureAlarmNotLaterThan(
  storage: AlarmStorage,
  deadline: number | Date,
  options?: DurableObjectSetAlarmOptions,
): Promise<number> {
  const candidate = toEpochMillis(deadline);
  const current = await storage.getAlarm();
  if (current === null || candidate < current) {
    await storage.setAlarm(candidate, options);
    return candidate;
  }
  return current;
}

/**
 * Alias for `ensureAlarmNotLaterThan` matching earliest-obligation terminology.
 */
export const scheduleEarliestAlarm = ensureAlarmNotLaterThan;

/**
 * Ensures an alarm is scheduled only if none is currently set.
 * Safe for recovery checks where an existing alarm must never be pushed out.
 * Note: Do NOT call `setAlarm` unconditionally in a Durable Object constructor.
 *
 * @returns The existing alarm timestamp if one was already set, or the newly
 *          scheduled timestamp if `getAlarm()` returned `null`.
 */
export async function ensureAlarmIfNone(
  storage: AlarmStorage,
  deadline: number | Date,
  options?: DurableObjectSetAlarmOptions,
): Promise<number> {
  const candidate = toEpochMillis(deadline);
  const current = await storage.getAlarm();
  if (current === null) {
    await storage.setAlarm(candidate, options);
    return candidate;
  }
  return current;
}

/**
 * Schedules the next obligation from inside an active `alarm()` handler.
 *
 * While `alarm()` is running, `storage.getAlarm()` returns `null` unless
 * `setAlarm()` has already been called during the current invocation (Trap 6.3).
 *
 * - If `nextDue === null | undefined`, no new obligation is scheduled; any alarm
 *   already set earlier during this `alarm()` invocation is preserved.
 * - If `nextDue` is provided, compares against `getAlarm()` (in case `setAlarm`
 *   was already invoked earlier during this `alarm()` execution) and sets the
 *   earlier of the two.
 *
 * @returns The scheduled alarm timestamp (epoch ms), or `null` if no alarm is set.
 */
export async function scheduleNextObligationFromAlarm(
  storage: AlarmStorage,
  nextDue: number | Date | null | undefined,
  options?: DurableObjectSetAlarmOptions,
): Promise<number | null> {
  if (nextDue === null || nextDue === undefined) {
    return await storage.getAlarm();
  }
  const candidate = toEpochMillis(nextDue);
  const current = await storage.getAlarm();
  if (current === null || candidate < current) {
    await storage.setAlarm(candidate, options);
    return candidate;
  }
  return current;
}

/**
 * Computes the fallback polling delay (in milliseconds) for a given probe index
 * or completed probe count under the architecture's fallback poll schedule:
 * - Probe 0 (1st probe): 5 minutes (300,000 ms)
 * - Probe 1 (2nd probe): 1 minute (60,000 ms)
 * - Probes 2..23 (3rd through 24th probe): 5 minutes (300,000 ms)
 * - Probe >= 24: `null` (24-probe bound reached; no further automatic probes)
 *
 * @param completedProbes Number of fallback probes already completed (0-based: 0 before 1st probe).
 * @returns Delay in milliseconds until the next probe, or `null` when the 24-probe bound is reached.
 */
export function getFallbackPollDelayMs(completedProbes: number): number | null {
  if (
    !Number.isInteger(completedProbes) ||
    completedProbes < 0 ||
    completedProbes >= FALLBACK_POLL_MAX_PROBES
  ) {
    return null;
  }
  if (completedProbes === 0) {
    return FALLBACK_POLL_FIRST_DELAY_MS;
  }
  if (completedProbes === 1) {
    return FALLBACK_POLL_SECOND_DELAY_MS;
  }
  return FALLBACK_POLL_STEADY_DELAY_MS;
}

/**
 * Computes the next fallback poll timestamp (epoch ms) given the base reference
 * timestamp (`nowMs`) and the number of probes already completed (`0..23`).
 * Returns `null` if `completedProbes >= 24` or `< 0`.
 */
export function getNextFallbackPollAt(
  completedProbes: number,
  nowMs: number = Date.now(),
): number | null {
  const delayMs = getFallbackPollDelayMs(completedProbes);
  if (delayMs === null) {
    return null;
  }
  return toEpochMillis(nowMs) + delayMs;
}

/**
 * Returns `true` if another fallback poll probe is permitted under the 24-probe bound.
 */
export function hasRemainingFallbackProbes(completedProbes: number): boolean {
  return (
    Number.isInteger(completedProbes) &&
    completedProbes >= 0 &&
    completedProbes < FALLBACK_POLL_MAX_PROBES
  );
}

/**
 * Returns `true` if the elapsed wall time of an `alarm()` invocation has reached
 * or exceeded the safe execution budget (default 14 minutes, staying safely under
 * the 15-minute platform limit in Trap 6.6).
 */
export function isAlarmWallTimeBudgetExceeded(
  startedAtMs: number,
  nowMs: number = Date.now(),
  budgetMs: number = ALARM_SAFE_EXECUTION_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs >= budgetMs;
}

/** Options for `runWithAlarmSafety`. */
export interface AlarmSafetyOptions {
  /**
   * Delay in ms used to schedule a fresh recovery alarm when `retryCount`
   * reaches `retryThreshold` (default: 30,000 ms).
   */
  readonly retryExhaustionDelayMs?: number;
  /**
   * Retry count threshold at which errors are caught and converted into a
   * scheduled alarm rather than rethrowing (default: 5).
   */
  readonly retryThreshold?: number;
  /**
   * Optional callback invoked when the retry budget is about to be exhausted
   * and a fresh alarm is scheduled instead of rethrowing.
   */
  readonly onRetryExhausted?: (
    error: unknown,
    retryCount: number,
    rescheduledAt: number,
  ) => void | Promise<void>;
  /**
   * Optional clock override for deterministic testing (default: `Date.now`).
   */
  readonly now?: () => number;
}

/** Result of `runWithAlarmSafety`. */
export type AlarmExecutionOutcome<T> =
  | {
      readonly status: "completed";
      readonly value: T;
      readonly nextAlarmAt: number | null;
    }
  | {
      readonly status: "rescheduled_on_retry_limit";
      readonly error: unknown;
      readonly retryCount: number;
      readonly nextAlarmAt: number;
    };

/**
 * Executes a Durable Object `alarm()` body with platform retry-budget protection
 * (Trap 6.5) and earliest-obligation rescheduling (Trap 6.3).
 *
 * - Runs `work(alarmInfo)`. If `work` returns a `number | Date`, ensures an
 *   alarm is scheduled no later than that timestamp before returning.
 * - If `work` throws:
 *   - When `(alarmInfo?.retryCount ?? 0) >= retryThreshold` (default 5), schedules
 *     a fresh alarm at `now + retryExhaustionDelayMs` (or preserves an even earlier
 *     alarm if `work` scheduled one before throwing) and returns without rethrowing
 *     so the obligation is never lost to the platform's 6-retry cap.
 *   - When `retryCount < retryThreshold`, rethrows the error so the platform
 *     performs its native exponential-backoff retry.
 */
export async function runWithAlarmSafety<
  T extends number | Date | null | undefined | void = void,
>(
  storage: AlarmStorage,
  alarmInfo: AlarmInvocationInfo | undefined,
  work: (info: AlarmInvocationInfo | undefined) => Promise<T> | T,
  options?: AlarmSafetyOptions,
): Promise<AlarmExecutionOutcome<T>> {
  const retryThreshold =
    options?.retryThreshold ?? ALARM_RETRY_RESCHEDULE_THRESHOLD;
  const retryExhaustionDelayMs =
    options?.retryExhaustionDelayMs ?? DEFAULT_RETRY_EXHAUSTION_DELAY_MS;
  const nowFn = options?.now ?? Date.now;

  try {
    const result = await work(alarmInfo);
    let nextAlarmAt: number | null;
    if (typeof result === "number" || result instanceof Date) {
      nextAlarmAt = await scheduleNextObligationFromAlarm(storage, result);
    } else {
      nextAlarmAt = await storage.getAlarm();
    }
    return {
      status: "completed",
      value: result,
      nextAlarmAt,
    };
  } catch (err) {
    const retryCount = alarmInfo?.retryCount ?? 0;
    if (retryCount >= retryThreshold) {
      const fallbackDeadline = toEpochMillis(nowFn()) + retryExhaustionDelayMs;
      const nextAlarmAt = await ensureAlarmNotLaterThan(
        storage,
        fallbackDeadline,
      );
      if (options?.onRetryExhausted !== undefined) {
        await options.onRetryExhausted(err, retryCount, nextAlarmAt);
      }
      return {
        status: "rescheduled_on_retry_limit",
        error: err,
        retryCount,
        nextAlarmAt,
      };
    }
    throw err;
  }
}
