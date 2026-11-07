/**
 * Worker entrypoint (`src/index.ts`) — hostname routing, DO exports, assets.
 *
 * Boot scaffold: exports the three Durable Object classes so `wrangler.toml`
 * bindings resolve and the test pool can boot. Request routing is implemented
 * by the Phase 4 handlers work.
 */

import { RegistryDO } from "./do/registry-do.ts";
import { JobDO } from "./do/job-do.ts";
import { RouterDO } from "./do/router-do.ts";
import { getRequestHostname } from "./http.ts";

export { JobDO, RegistryDO, RouterDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = getRequestHostname(request);

    if (host === env.HOOKS_HOST) {
      return new Response("Not Found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;