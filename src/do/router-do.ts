/**
 * RouterDO (`src/do/router-do.ts`) — global response routing and webhook inbox.
 *
 * Boot scaffold: migrations run in the constructor. Routing/delivery behavior is
 * implemented by the Phase 4 RouterDO work.
 */

import { DurableObject } from "cloudflare:workers";
import { migrateRouterDoSchema, type SchemaTransactionalStorage } from "../db/schema.ts";

export class RouterDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateRouterDoSchema(storage);
  }

  override async fetch(): Promise<Response> {
    return new Response("RouterDO not implemented", { status: 501 });
  }
}