/**
 * JobDO (`src/do/job-do.ts`) — per-job execution-state owner.
 *
 * Boot scaffold: migrations run in the constructor so Durable Object SQLite
 * storage is immediately addressable by `runInDurableObject` tests. Execution
 * behavior is implemented by the Phase 4 JobDO work.
 */

import { DurableObject } from "cloudflare:workers";
import { migrateJobDoSchema, type SchemaTransactionalStorage } from "../db/schema.ts";

export class JobDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateJobDoSchema(storage);
  }

  override async fetch(): Promise<Response> {
    return new Response("JobDO not implemented", { status: 501 });
  }
}