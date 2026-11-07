/**
 * RegistryDO (`src/do/registry-do.ts`) — job index, file catalogue, uploads.
 *
 * Boot scaffold: migrations run in the constructor. Registry behavior is
 * implemented by the Phase 4 RegistryDO work.
 */

import { DurableObject } from "cloudflare:workers";
import { migrateRegistryDoSchema, type SchemaTransactionalStorage } from "../db/schema.ts";

export class RegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateRegistryDoSchema(storage);
  }

  override async fetch(): Promise<Response> {
    return new Response("RegistryDO not implemented", { status: 501 });
  }
}