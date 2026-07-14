# 0009. Adopt the Agent Skills SKILL.md format for skills

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

Phase 1 shipped skills as a folder containing a `skill.json` manifest plus a free-form `skills.md`
instructions document referenced by the manifest's `instructions` field. Meanwhile the community
converged on the [Agent Skills](https://agentskills.io) convention: a single `SKILL.md` file per
skill folder, with YAML frontmatter (`name`, `description`, and optional fields such as `version`,
`license` and `metadata`) and the instructions as the Markdown body. Skills in that format are
portable across Claude Code, GitHub Copilot and other agent runtimes.

Our two-file split bought us nothing that the convention does not also provide: frontmatter can be
parsed to a plain object and validated against the very same JSON Schema (design rule "schemas
first" is about validation, not file format), and FlowForge-specific fields (`prompts`, `tools`,
`embeddings`, `dependencies`, `compatibleAgents`) fit under the spec's open `metadata` key. The
split also hid a bug: the runtime only injected `skill.description` into system prompts and never
loaded `skills.md` at all.

## Decision

Skills are authored as a single `SKILL.md` per skill folder, following the Agent Skills convention:

- YAML frontmatter carries the manifest: required `name` (lowercase letters, digits and hyphens,
  matching the skill folder name — this is the id agents reference) and `description`; optional
  `version`, `license` and `metadata`.
- FlowForge-specific fields live under `metadata`: `displayName`, `prompts`, `tools`, `embeddings`,
  `dependencies`, `compatibleAgents`.
- The Markdown body is the skill's instructions and is injected into the system prompt of every
  agent equipped with the skill.
- `skill.schema.json` remains the source of truth and now validates the parsed frontmatter object.
- The `workforce.json` manifest's `skills` array lists relative paths to `SKILL.md` files.
- This is a clean break: the legacy `skill.json` + `skills.md` split is not loaded any more (the
  only existing package was the reference fixture, which is migrated in the same change).

This supersedes the skill file layout described in ADR-0003's package structure; the package
concept itself is unchanged.

## Consequences

- Skills are interoperable with the wider Agent Skills ecosystem in both directions, and authoring
  drops from two files to one.
- The loader gains a YAML frontmatter parse step (`yaml` dependency) and enforces that the
  frontmatter `name` matches the skill folder name, per the spec.
- The runtime now composes system prompts from the actual skill instructions (the SKILL.md body),
  fixing the Phase 1 bug where only the description was used. Prompt versions (hashes) of existing
  runs change accordingly.
- Renaming the identifier field from `id` to `name` means agent definitions reference skills by the
  folder-unique `name` (e.g. `algebra`) rather than a path-like id (`maths/algebra`).
