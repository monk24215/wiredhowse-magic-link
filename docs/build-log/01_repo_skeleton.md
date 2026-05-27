# Chunk 1: Repo skeleton + CI

**Status:** ✅ Complete
**Model:** Sonnet 4.6
**Spec references:** `spec/10_directory_structure.md`

## Prompt sent to Claude Code

> Repo skeleton + CI first. Full sequence:
>
> 1. Repo skeleton + CI
> 2. `packages/db` schema + first migration
> 3. `packages/shared` types
> 4. `packages/api` skeleton with health/readiness + Resend wrapper + rate limiter
> 5. Auth endpoints (magic-link request → redemption → handoff → session check → sign-out)
> 6. `packages/snippet`
> 7. `packages/web` dashboard
> 8. Cron service
> 9. Railway deploy + DNS + DMARC
>
> Stop after each numbered chunk so I can `/clear`. FAQ PDFs can slot in whenever — low priority, do them last or between chunks if you want a break from code.
>
> Go.

## Deliverable summary

Full pnpm monorepo skeleton, 45 files. All five packages (`api`, `web`, `snippet`, `db`, `shared`) stub out correctly. GitHub Actions CI wired up with the typecheck → lint → unit tests → conditional integration job pipeline.

- `pnpm typecheck` → clean across all 5 packages
- `pnpm lint` → clean (Biome)
- `packages/api` boots with `/v1/health` and `/v1/ready`; env validation crashes cleanly on bad config

## Files

- Workspace setup: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.nvmrc`, `.gitignore`, `LICENSE`
- Five packages scaffolded with their own `package.json` + `tsconfig.json`
- `.github/workflows/ci.yml` — full CI pipeline
- `README.md` — repo readme
- Health + readiness route stubs in `packages/api`

## Tests

- Basic boot test for api
- Workspace-wide typecheck + lint enforced in CI

## Notable

- pnpm workspaces over npm or yarn — chosen for monorepo ergonomics and faster installs.
- Biome over ESLint + Prettier — one tool, faster, simpler config.
- Integration tests wired as a separate CI job, only running when needed (testcontainers are slow).

## Review notes

Clean foundation. The "env validation crashes cleanly on bad config" detail matters — fail-closed at boot prevents the service from running in a broken-but-quiet state. Health/ready endpoints are stubs at this point; they'll be properly wired to DB + Redis checks in 4a.

## Next chunk

Chunk 2: `packages/db` schema + first migration. Needs Railway Postgres provisioned partway through to generate the drizzle snapshot.
