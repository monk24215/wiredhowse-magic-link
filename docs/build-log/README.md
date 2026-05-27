# Build Log

Action-call & response record for the `wiredhowse-magic-link` build.

Each numbered file documents one chunk: the prompt sent to Claude Code, the deliverable summary, files changed, and review notes. Together they form the audit trail of how the service was built.

## Why this exists

1. **Auditability.** If a security question comes up six months from now ("why does the handoff_tokens table store raw session tokens?"), the answer is in the chunk file for 5c.
2. **Resumability.** A fresh Claude Code session can read this directory and pick up the project state without re-reading every commit.
3. **Pattern reuse.** When future wiredHowse apps need similar infrastructure, this log is the template.
4. **Decision history.** The prompts capture not just what was built, but what was considered.

## How it's used

After each chunk completes in Claude Code:

1. The chunk's deliverable summary gets pasted into chat.
2. A build-log file for that chunk gets generated.
3. File goes into `docs/build-log/` in the repo, committed with the chunk's code.

## Status

| #   | Chunk                                          | Status        | Model         | File                         |
|-----|------------------------------------------------|---------------|---------------|------------------------------|
| 1   | Repo skeleton + CI                             | ✅ Complete   | Sonnet 4.6    | `01_repo_skeleton.md`        |
| 2   | `packages/db` schema + first migration         | ✅ Complete   | Sonnet 4.6    | `02_db_schema.md`            |
| 3   | `packages/shared` types                        | ✅ Complete   | Sonnet 4.6    | `03_shared_types.md`         |
| 4a  | api skeleton + middleware                      | ✅ Complete   | Sonnet 4.6    | `04a_api_skeleton.md`        |
| 4b  | Resend wrapper + email templates               | ✅ Complete   | Sonnet 4.6    | `04b_email_wrapper.md`       |
| 4c  | Rate limiter (Redis + Lua)                     | ✅ Complete   | Sonnet 4.6    | `04c_rate_limiter.md`        |
| 5a  | POST /v1/snippet/magic-link/request            | ✅ Complete   | Sonnet 4.6    | `05a_magic_link_request.md`  |
| 5b  | GET /v1/magic/redeem + preflight               | ✅ Complete   | Opus 4.7      | `05b_magic_redeem.md`        |
| 5c  | POST /v1/snippet/handoff/exchange              | ✅ Complete   | Opus 4.7      | `05c_handoff_exchange.md`    |
| 5d  | POST /v1/snippet/session/check                 | ✅ Complete   | Sonnet 4.6    | `05d_session_check.md`       |
| 5e  | POST /v1/snippet/sign-out                      | ✅ Complete   | Sonnet 4.6    | `05e_sign_out.md`            |
| 6a  | Snippet core (storage, API, events)            | ✅ Complete   | Sonnet 4.6    | `06a_snippet_core.md`        |
| 6b  | Iframe UI bundle                               | ✅ Complete   | Opus 4.7      | `06b_iframe_ui.md`           |
| 6c  | Static serving + api integration               | ✅ Complete   | Sonnet 4.6    | `06c_snippet_serving.md`     |
| 7a  | Site Owner auth (api + web)                    | ✅ Complete   | Sonnet 4.6    | `07a_site_owner_auth.md`     |
| 7b  | Sites management (api + web)                   | ✅ Complete   | Sonnet 4.6    | `07b_sites_management.md`    |
| 7c  | End User self-service (`/v1/me/*` + /me page)  | ✅ Complete   | Sonnet 4.6    | `07c_end_user_self_service.md` |
| 7d  | CSRF protection + auth integration tests       | ✅ Complete   | Sonnet 4.6    | `07d_csrf_auth_tests.md`     |
| 8   | Cron service (cleanup + archive purge)         | ✅ Complete   | Sonnet 4.6    | `08_cron_service.md`         |
| 9   | Railway deploy + DNS + DMARC                   | ⚪ Not started | —            | —                            |

Legend: ✅ Complete · 🟡 In progress · 🔴 Blocked · ⚪ Not started

## Milestones reached

- **Backend auth complete** (after chunk 5e): every End User auth endpoint shipped with full lifecycle integration tests.
- **Customer-facing surface complete** (after chunk 6c): a customer site can embed the snippet and run the full magic-link flow against the live api.
- **Site Owner can sign in** (after chunk 7a): signup, email verification, password login, Google OAuth, password reset all working through the dashboard.
- **Site Owner full lifecycle** (after chunk 7b): owners can sign up, verify email, log in, create up to 3 sites, verify domain ownership, manage allowed origins, view live metrics, clear sessions, disable, and delete. Dashboard is functionally complete for the Site Owner role.
- **End User self-service complete** (after chunk 7c): End Users can view their profile, manage active sessions across all sites, revoke individually or all at once, export their data (GDPR), and trigger atomic close-and-archive. The `/v1/identity/me` SSO contract is live for future wiredHowse apps to consume.
- **Chunk 7 closed** (after chunk 7d): every state-changing endpoint is CSRF-protected with double-submit cookies and timing-safe comparison. Auth flows have full integration test coverage. The build is functionally complete; only operational chunks (cron + Railway deploy) remain.
- **Operational infrastructure complete** (after chunk 8): cron service ships 8 cleanup/purge jobs, scheduled via node-cron, with unit + integration tests. Only Railway deploy + DNS (chunk 9) remains before production launch.

## Open follow-ups across chunks

- Decision on shadcn CLI adoption (deferred from 7a; revisit if component count grows past ~8).
- Postgres minor version upgrade available (18.4) — defer until chunk 9 pre-launch testing.

## Conventions

- One file per logical chunk (sub-chunks like 5a-5e get their own files).
- Filename matches the status table.
- Each file follows the structure in `TEMPLATE.md`.
- Spec changes that emerged during a chunk are documented in that chunk's "Notable" section and reflected in the corresponding `spec/*.md` files at the same commit.

## Related documents

- `PROJECT_BRIEF___wiredhowse-magic-link.md` — scope, autonomy rules, model policy
- `CLAUDE.md` — session orientation file for Claude Code
- `spec/` — technical specification (11 files)
