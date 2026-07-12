# 0008. pnpm + TypeScript monorepo tooling

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge's kernel is a set of small, separately consumable packages (core, packages-loader,
agents, memory, audit, workflow, cli) that evolve together and depend on each other. They need
shared types, atomic cross-package refactors, and a single toolchain — without publishing every
intermediate version to a registry.

## Decision

We will develop FlowForge as a pnpm workspace monorepo (Node >= 20, ESM), written in TypeScript
with a shared `tsconfig.base.json`. Cross-package dependencies use `workspace:` links. One
toolchain at the root: `pnpm build` (recursive tsc), `pnpm test` (Vitest), `pnpm lint` (ESLint
flat config), `pnpm typecheck`. New deliverables (desktop app, Dapr runner) join the same
workspace as new packages.

## Consequences

- Atomic changes across kernel packages in one commit/PR; one lockfile, one CI pipeline.
- Package boundaries stay honest (each has its own `package.json` and public API) even though
  everything lives in one repo — extraction later stays possible.
- Contributors need pnpm (not npm/yarn) and Node 20+; all commands are documented in the README.
- Repo grows with every phase; if build times become a problem, task caching (e.g. turborepo) can
  be added without changing the layout.
