# 0003. All domain behaviour ships in installable workforce packages

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

FlowForge's premise is that the *platform* is separate from the *knowledge and process*. Education
(Grade 7 Maths) is the flagship use case, but the same software must become a corporate-onboarding
workforce — or anything else — without code changes. If agents, prompts, workflows or rubrics were
hardcoded, every new domain would be a fork.

## Decision

We will ship all domain behaviour — agents, skills, personas, workflows, rubrics, knowledge,
permissions, branding — in versioned, validatable `.workforce` packages loaded by
`@flowforge/packages`. The platform installs empty and knows nothing until a package is installed.
No platform code may branch on a specific domain, agent name or package id.

## Consequences

- Swapping the curriculum (or the whole domain) is a content change, not a code change; the
  reference package `fixtures/Grade7-Maths.workforce` is content, not platform.
- Missing capabilities must be fixed in the package format/schemas, never with special cases in
  platform code — if an agent can't be expressed as package data, the format is incomplete.
- The abstraction is only proven when a second package exists (planned: Corporate-Onboarding in
  Phase 4), so domain leaks must be actively audited until then.
- Packages become an ecosystem artefact, which motivates Phase 4 export/signing work.
