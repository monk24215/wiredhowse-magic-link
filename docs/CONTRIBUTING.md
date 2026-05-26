# Contributing

## Prerequisites

- Node.js 20 LTS (`nvm use` or check `.nvmrc`)
- pnpm 9+ (`npm install -g pnpm`)
- Docker (for integration tests via testcontainers)

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in .env with local values (see README for Docker Compose tip)
```

## Development

```bash
pnpm dev:api     # Fastify API on :3001
pnpm dev:web     # Next.js dashboard on :3000
```

## Checks (must pass before merge)

```bash
pnpm typecheck   # tsc --noEmit across all packages
pnpm lint        # biome check
pnpm test        # unit tests (vitest)
```

Integration tests require Docker and a running testcontainers environment:

```bash
pnpm --filter @wiredhowse/api test:integration
```

## Commit style

No enforced convention yet. Be descriptive. Reference issue numbers if applicable.
