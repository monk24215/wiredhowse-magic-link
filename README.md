# wiredhowse-magic-link

Free, hosted magic-link authentication. Paste a JS snippet on your site — visitors enter their email, receive a magic link, and get a session. No passwords, no third-party cookie workarounds.

Production: **magic-link.wiredhowse.app**

## Packages

| Package | Description |
|---|---|
| `packages/api` | Fastify API (Railway service) |
| `packages/web` | Next.js 15 dashboard + public pages (Railway service) |
| `packages/snippet` | Browser snippet `<15kb gzipped, served at `/v1/snippet.js` |
| `packages/db` | Drizzle ORM schema + migrations |
| `packages/shared` | Shared TypeScript types + Zod schemas |

## Stack

Node 20 · TypeScript (strict) · Fastify · Next.js 15 · Drizzle ORM · Postgres 16 · Redis · Resend · pnpm workspaces · Biome · Vitest

## Quickstart

```bash
pnpm install
cp .env.example .env   # fill in local values
pnpm dev:api           # :3001
pnpm dev:web           # :3000
```

## CI checks

```bash
pnpm typecheck   # strict tsc across all packages
pnpm lint        # biome
pnpm test        # vitest unit tests
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for full setup and integration test instructions.

## License

MIT
