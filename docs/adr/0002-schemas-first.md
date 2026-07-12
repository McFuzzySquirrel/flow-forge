# 0002. JSON Schemas are the source of truth for every format

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge consumes many author-provided documents: workforce package manifests, agent definitions,
skills, personas, workflows and audit records. These are written by package authors, not platform
developers, so malformed input is the normal case, not the exception. Without a single definition
of "valid", every consumer would re-implement (and disagree on) validation.

## Decision

We will define every format the platform consumes as a JSON Schema in `packages/core/schemas/`
(currently six: workforce-package, agent, skill, persona, workflow, audit-record). Nothing may
parse or consume a format that does not have a validating schema, and validation happens at the
boundary (package load / install) so downstream code can trust well-formed data. TypeScript types
in `@flowforge/core` mirror the schemas.

## Consequences

- One authoritative contract per format; the CLI (`flowforge validate`), loader and future UI all
  reuse the same validator.
- Package authors get precise, early error messages instead of runtime failures mid-workflow.
- Schema evolution becomes a deliberate act: new capabilities (e.g. persona decision policies,
  memory write policies planned in Phase 3) must land in the schema first, with validator tests.
- Duplication between schemas and TypeScript types must be kept in sync manually (accepted cost;
  could be generated later).
