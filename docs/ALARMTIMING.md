## 6. AlarmTiming — `src/lib/alarm.ts`

The architecture maps this to **Alarm — earliest-obligation and fallback-poll timing**, and the Decision Log says:

> Each Durable Object uses one alarm scheduled against its earliest obligation or deadline.

This is the most trap-dense module after SchemaDefs.

**Trap 6.1 — `setAlarm()` always overwrites the existing alarm; there is no “set if earlier” primitive.**

> Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`. … If you call `setAlarm` when there is already one scheduled, it will override the existing alarm.

> Each object has one alarm. Calling `setAlarm()` when one is already scheduled overrides it. … The usual periodic pattern is to call `setAlarm()` again from inside `alarm()`.

**Practical consequence:** the “earliest obligation” logic must be implemented in application code:

```ts
const current = await this.ctx.storage.getAlarm();
if (current === null || candidate < current) {
  await this.ctx.storage.setAlarm(candidate);
}
```

This read-modify-write is the **only** way to preserve an earlier pending alarm. A naive `setAlarm(now + delay)` in `fetch()` will overwrite a closer deadline that another request already scheduled.

**Trap 6.2 — Do **not** call `setAlarm()` unconditionally in the constructor.**

> This is not advised because the Durable Object’s constructor will be called before invoking the alarm handler if the alarm wakes the Durable Object up from hibernation. This approach will naively result in the constructor continually extending the TTL without running the alarm handler. If you must call `setAlarm` in the Durable Object class constructor be sure to check that there is no alarm previously set.

> If you wish to call `setAlarm` inside the constructor of a Durable Object, ensure that you are first checking whether an alarm has already been set.

`AlarmTiming` should expose a helper like `ensureAlarmNotLaterThan(deadline)` that does the null-check-and-compare, rather than a bare `setAlarm`. The schema/migration constructor already runs `blockConcurrencyWhile`; do **not** add an unconditional alarm there.

**Trap 6.3 — `getAlarm()` returns `null` while an alarm is running, unless `setAlarm` has been called since it started.**

> If `getAlarm` is called while an alarm is already running, it returns `null` unless `setAlarm` has also been called since the alarm handler started running.

> The alarm is considered to be set if it has not started, or if it has failed and any retry has not begun. If no alarm is set, `getAlarm()` returns `null`.

**Trap for `AlarmTiming`’s “earliest obligation” helper:** if it is called **inside `alarm()`**, `getAlarm()` returns `null` even though the current invocation is in progress. The helper must not interpret that `null` as “no work pending” — it should still schedule the next obligation. The correct pattern is the one the docs show: inside `alarm()`, always call `setAlarm(nextDue)` if there is more work, regardless of `getAlarm()`.

**Trap 6.4 — Alarm execution is at-least-once; `alarm()` can run more than once for the same scheduled time.**

> Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws.

> Alarms have at-least-once execution: Cloudflare retries a failed handler, so the same intended effect may be attempted again.

`AlarmTiming` cannot assume that each alarm fires exactly once. Any side effect performed inside `alarm()` (marking a job failed, sending a webhook, advancing a state machine) must be **idempotent** or fenced by a work-claim/sequence number. The architecture already says “Revision, execution epoch, and work claim sequence serve distinct ordering and fencing purposes” — the alarm handler must use those fences, not a bare `if (job.status === 'pending')`.

**Trap 6.5 — The platform retries up to 6 times with exponential backoff starting at 2 s; you cannot extend that budget, and throwing on the 6th attempt stops retries permanently.**

> Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed.

> The `alarm()` handler has guaranteed at-least-once execution and will be retried upon failure using exponential backoff, starting at two second delays for up to six retries.

> If we’re almost out of retries but still have work to do, schedule a new alarm rather than letting our retries run out to ensure we keep getting invoked.【23†L—】(from the Alarms example in the provided file)

**This is the single most expensive trap in the module.** If `alarm()` throws a transient error (e.g. upstream OpenAI 5xx) and the platform exhausts its 6 retries, the alarm is **gone** — no further wake-up. The handler must catch errors, inspect `alarmInfo.retryCount`, and **schedule a fresh alarm** before rethrowing or returning:

```ts
async alarm(alarmInfo?: AlarmInvocationInfo) {
  try { /* work */ }
  catch (err) {
    if ((alarmInfo?.retryCount ?? 0) >= 5) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return; // do not rethrow
    }
    throw err; // let the platform retry
  }
}
```

`AlarmTiming` should provide this wrapper so individual DOs do not reinvent it. The architecture’s “fallback polling follows the five-minute, one-minute, and five-minute schedule with a 24-probe bound” is the **project-level** poll cadence; it sits **inside** the alarm handler and must be careful not to consume the platform’s 6-retry budget on the first transient error.

**Trap 6.6 — Alarm wall-time is 15 minutes, not unlimited.**

> Durable Object alarm handlers | 15 minutes | Alarm handler invocations have a maximum wall time of 15 minutes.【0†L—】(from the Workers wall-time limits table in the provided docs)

`AlarmTiming` must not schedule a single alarm invocation that is expected to run longer than 15 minutes of wall time. If a polling loop needs to run longer, it should do a bounded amount of work per alarm and reschedule itself — which is exactly the architecture’s “24-probe bound” pattern.

**Trap 6.7 — Alarm tests must use `runDurableObjectAlarm()`, not `setTimeout`.**

This is the same rule as for SchemaDefs, restated because `AlarmTiming` is the module most likely to be tested:

> Use `runDurableObjectAlarm()` to immediately trigger a scheduled alarm without waiting for the timer.【0†L—】(from the Testing Durable Objects docs in the provided file)

> `const alarmRan = await runDurableObjectAlarm(stub);` returns `true` when a scheduled alarm executed and `false` when none was scheduled.【0†L—】

`AlarmTiming` tests must also cover the **retry-budget-exhaustion** path: use `runInDurableObject` to set `alarmInfo.retryCount` to 5, run the alarm, and assert that a new alarm was scheduled rather than a throw escaping.
