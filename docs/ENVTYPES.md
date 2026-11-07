## 1. EnvTypes — `src/env.d.ts` / `src/types.ts` (Env interface)

The architecture maps `env.d.ts` to **Contracts — Worker bindings, variables, and secret types**. The trap is that this file should **not** be hand-maintained.

**Trap 1.1 — `wrangler types` owns the Env interface; do not edit the generated file.**

> `worker-configuration.d.ts` is generated and will be overwritten when you rerun `wrangler types`, so do not edit it manually. Define custom environment types in source-owned TypeScript, separate from the generated file. Use declaration merging with the public `Cloudflare.Env` interface. You should then add that file to your `tsconfig.json`'s `compilerOptions.types` array.

> `Bindings` no longer needs to be manually maintained. Run `wrangler types` to generate a `worker-configuration.d.ts` with a `Cloudflare.Env` namespace derived from your `wrangler.toml`.

**Practical consequence:** `env.d.ts` should either (a) be the generated `worker-configuration.d.ts` itself, checked into git as a build artefact, or (b) be a small hand-written augmentation that merges into `Cloudflare.Env`. Do **not** write `interface Env { MY_BINDING: … }` from scratch — it will drift from `wrangler.jsonc` and produce the classic “`ctx.env.BINDING` is undefined / TypeScript errors on `ctx.env`” symptom.

**Trap 1.2 — The generated Env is only as good as the config it reads.**

`wrangler types` includes `Env` types **based on your Worker bindings** and runtime types **based on your Worker’s compatibility date and flags**. If a binding is added to `wrangler.jsonc` but `wrangler types` is not re-run, the Env interface is stale. Add `wrangler types` to the pre-commit or CI step, not just to a developer’s manual workflow.

**Trap 1.3 — RPC bindings need the callee’s config path.**

> You can pass in the path to the config files of the Worker or Durable Object being called so that the generated types include the type parameters for the `Service` and `DurableObjectNamespace` types.

> `npx wrangler types -c ./client/wrangler.jsonc -c ../sum-worker/wrangler.jsonc -c ../counter/wrangler.jsonc`

If the `JOB_DO` / `REGISTRY_DO` / `ROUTER_DO` bindings are typed as bare `DurableObjectNamespace` without a type parameter, every RPC call through the stub loses method typing. The `EnvTypes` task must ensure the type-generation command includes the DO config files, so `DurableObjectNamespace<JobDO>` is emitted rather than `DurableObjectNamespace`.

**Trap 1.4 — `satisfies ExportedHandler<Env>` is the intended shape, and it catches real errors.**

The idiomatic pattern is:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> { … },
} satisfies ExportedHandler<Env>;
```

The `satisfies` operator is preferred because it checks the export **without widening** the inferred type — a plain `: ExportedHandler<Env>` annotation would erase the specific handler type and defeat some inference. If the EnvTypes worker is reviewing `index.ts`, flag any handler that lacks `satisfies ExportedHandler<Env>`.

**Trap 1.5 — Secrets are `string` at the Env boundary; never assume they are pre-imported `CryptoKey`s.**

> Secrets are a type of binding that allow you to attach encrypted text values to your Worker. Secrets are used for storing sensitive information like API keys and auth tokens.

A `CryptoKey` is not JSON-serialisable and workerd will not accept arbitrary globals:

> Injecting arbitrary globals is not supported by workerd. If you’re using a service Worker, bindings will be injected as globals, but these must be JSON-serialisable.

So `env.OPENAI_API_KEY` (or whatever the signature secret is) is a `string`, and `SignatureAuth` must `crypto.subtle.importKey` it at use time. Do not attempt to type the secret as `CryptoKey` in the Env interface.
