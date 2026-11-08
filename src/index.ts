/**
 * Worker entrypoint (`src/index.ts`) — hostname routing, Durable Object exports,
 * application handlers, and static assets.
 *
 * Routing contract:
 * - `env.HOOKS_HOST` serves only `POST /openai` (webhook ingress); every other
 *   path on that host is 404.
 * - Every other reachable host serves the application: `/api/jobs*`, `/api/files*`,
 *   `GET /api/health`, `POST /api/tokens/preview`; all remaining paths fall
 *   through to `ASSETS`.
 */

import { RegistryDO } from "./do/registry-do.ts";
import { JobDO } from "./do/job-do.ts";
import { RouterDO } from "./do/router-do.ts";
import { handleFilesRequest } from "./handlers/files.ts";
import { handleHealthRequest } from "./handlers/health.ts";
import { handleJobsRequest } from "./handlers/jobs.ts";
import { handleTokensRequest } from "./handlers/tokens.ts";
import { handleWebhookRequest } from "./handlers/webhook.ts";
import { getRequestHostname, notFound } from "./http.ts";
import { HEALTH_PATH, TOKEN_PREVIEW_PATH, WEBHOOK_OPENAI_PATH } from "./constants.ts";

export { JobDO, RegistryDO, RouterDO };

function isJobsPath(pathname: string): boolean {
  return pathname === "/api/jobs" || pathname.startsWith("/api/jobs/");
}

function isFilesPath(pathname: string): boolean {
  return pathname === "/api/files" || pathname.startsWith("/api/files/");
}

function isTokensPath(pathname: string): boolean {
  return pathname === TOKEN_PREVIEW_PATH;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const host = getRequestHostname(request);
    const pathname = new URL(request.url).pathname;

    if (host === env.HOOKS_HOST) {
      if (pathname === WEBHOOK_OPENAI_PATH) {
        return handleWebhookRequest(request, env);
      }
      return notFound();
    }

    if (pathname === HEALTH_PATH) {
      return handleHealthRequest(request, env);
    }
    if (isJobsPath(pathname)) {
      return handleJobsRequest(request, env);
    }
    if (isFilesPath(pathname)) {
      return handleFilesRequest(request, env);
    }
    if (isTokensPath(pathname)) {
      return handleTokensRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;