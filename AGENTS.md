# Project Constraints

- **Architecture**: Follow `ARCHITECTURE.md` strictly. Do not invent new mechanisms.
- **Dependencies**: Use only standard Web APIs, Cloudflare Workers bindings, and TypeScript. Do not add third-party npm packages without explicit permission.
- **Validation**: Use LSP diagnostics to ensure all TypeScript is strictly typed and compiles before yielding. Do not leave `any` types or unresolved TODOs.
- **MCP**: Use the `cloudflare_docs` MCP if you need to verify a platform API or runtime limit.

Commit Discipline: Upon successfully writing and validating your assigned file, stage it and create a git commit using Conventional Commits format (e.g., feat(schema): implement strict sqlite tables and BLOB guards). Do not lump multiple module changes into a single commit.
