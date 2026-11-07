/**
 * Contracts — Worker bindings, variables, and secret types (`src/env.d.ts`).
 *
 * Single source of truth for the Worker `Env` contract derived from `wrangler.toml`
 * and runtime secrets. Merges into `Cloudflare.Env` and declares the global `Env`
 * interface so ambient references (`env: Env`, `ExportedHandler<Env>`, and
 * `DurableObject<Env>` / `Cloudflare.Env`) resolve identically without drift.
 *
 * Note:
 * - Secrets (`HOOKS_HOST`, `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, and dynamic
 *   judge secrets resolved via `getEnvSecret`) are raw `string` bindings at the
 *   Worker boundary; never `CryptoKey`s (which must be imported inside handlers
 *   because Durable Objects evict in-memory state).
 * - No separate application-host binding is defined: the webhook ingress is served
 *   only on `env.HOOKS_HOST` (`POST /openai`), and any other valid custom domain
 *   attached in the Cloudflare Dashboard serves the Access-protected application and assets.
 */

declare namespace Cloudflare {
  interface Env {
    /** Static asset fetcher bound to `./public` (`run_worker_first = true`). */
    readonly ASSETS: Fetcher;

    /** Per-job SQLite-backed Durable Object namespace (`JobDO`). */
    readonly JOB_DO: DurableObjectNamespace;

    /** Global response-routing and webhook-inbox SQLite Durable Object namespace (`RouterDO`). */
    readonly ROUTER_DO: DurableObjectNamespace;

    /** Global job-index, file-catalogue, upload, and retention SQLite Durable Object namespace (`RegistryDO`). */
    readonly REGISTRY_DO: DurableObjectNamespace;

    /** Public webhook hostname configured as a secret/variable (only `POST /openai` is served on this host). */
    readonly HOOKS_HOST: string;

    /** Retention window in seconds (decimal string, e.g. `"604800"`) for unreferenced catalogued files. */
    readonly FILE_RETENTION_SECONDS: string;

    /** Default model identifier seeding the judge configuration panel. */
    readonly JUDGE_DEFAULT_MODEL: string;

    /** OpenAI API key secret used for Responses and Files API operations. */
    readonly OPENAI_API_KEY: string;

    /** Standard Webhooks signing secret used to verify OpenAI webhook deliveries. */
    readonly OPENAI_WEBHOOK_SECRET: string;

    /**
     * Dynamic secret lookup for job-declared judge credentials (`judge.secret_name`).
     * Credentials remain server-side secrets and are never serialized or exported.
     */
    readonly [secretName: string]:
      | string
      | Fetcher
      | DurableObjectNamespace
      | undefined;
  }
}

/**
 * Global `Env` binding contract shared across the Worker entrypoint, HTTP route
 * handlers (`satisfies ExportedHandler<Env>`), and Durable Object classes.
 */
interface Env extends Cloudflare.Env {
  readonly ASSETS: Fetcher;
  readonly JOB_DO: DurableObjectNamespace;
  readonly ROUTER_DO: DurableObjectNamespace;
  readonly REGISTRY_DO: DurableObjectNamespace;
  readonly HOOKS_HOST: string;
  readonly FILE_RETENTION_SECONDS: string;
  readonly JUDGE_DEFAULT_MODEL: string;
  readonly OPENAI_API_KEY: string;
  readonly OPENAI_WEBHOOK_SECRET: string;
}
