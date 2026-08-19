# Phase 3 Differentiators Architecture

This branch now includes most of the **Phase 3 / Differentiators** cut of FlowForge. The goal of
this phase is to prove that the platform is more than a workflow runner: behaviour can be shaped by
personas, enriched by memory, and extended by package-level agent design without breaking the
headless kernel contract established in Phase 2.

## What running this phase looks like

The system remains terminal-first, but the behaviour available through that surface is richer:

1. **Run the same workflow with different personas** and compare outcomes in audit.
2. **Run the Coach/Reflection workflow** in the Grade 7 Maths package.
3. **Validate workflow graphs headlessly** before runtime.
4. **Prepare for real vector-backed memory** without changing workflow or agent contracts.

## What this phase proves before Phase 4

Phase 3 proves the claims that make FlowForge distinctive:

1. **Capability and behaviour are separate configuration layers.** Skills define what an agent can
   do; personas define how it behaves or what policy thresholds it applies.
2. **Packages can evolve without platform rewrites.** Coach and Reflection agents, revised workflows
   and memory-write policy land in the package/fixture layer, not by hardcoding new agent types.
3. **Memory is a real subsystem with a stable boundary.** The current store can later be swapped for
   Chroma or another vector backend without rewriting the workflow engine or prompt assembly.
4. **Static workflow analysis belongs in the kernel.** Reachability, dangling-edge and branch-default
   checks run before execution so future tools do not need to re-implement them.
5. **ADR-0010 still governs human actions.** Richer agents and memory do not weaken the requirement
   that every human resume is authenticated, role-checked and audited.

## Architecture at this phase

### Prompt composition and persona layer

- `packages/agents` composes prompts from agent definition, skills, optional persona overlay and
  workflow inputs.
- Audit records capture persona and prompt-version information so behaviour changes remain
  explainable.

This layer keeps style and policy configurable without duplicating capability definitions.

### Memory and reflection layer

- `packages/memory` remains the memory boundary through a `VectorStore`-style abstraction.
- Declarative memory-write policy determines what is remembered after workflow execution.
- Coach and Reflection workflows consume and refine memory without changing engine semantics.

This preserves the state-vs-memory split while increasing the practical value of recall.

### Validation and kernel extension layer

- Graph-level workflow validation is exposed through `KernelApi.validatePackage`.
- CLI commands are still the main proof surface for persona, revision-workflow and graph-validation
  features.

Phase 3 therefore extends the kernel contract rather than routing around it.

## Current execution path

The important path on this branch is:

1. CLI command selects a workflow, persona override or validation mode.
2. `FlowForgeKernel` loads the package and hands agent steps to the runtime.
3. The agent runtime layers skill + persona + memory recall into the prompt.
4. Workflow state, audit output and memory writes remain behind their existing interfaces.
5. Human steps still pause for an authenticated, authorized resume.

## Evidence available on this branch

The branch already has executable proof points:

- `pnpm build`
- `pnpm test`
- `node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment --mock --persona supportive-mentor`
- `node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce revision --mock --answers answers.json`
- `node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce --graph`

These commands demonstrate that differentiator features can ship headlessly and remain compatible
with the Phase 2 kernel surface.

## Further reading

- [Phase 2 headless kernel API architecture](phase-2-headless-kernel-api-architecture.md)
- [Phase 4 ecosystem architecture](phase-4-ecosystem-architecture.md)
- [ADR-0009: Agent skills `SKILL.md` format](adr/0009-agent-skills-skill-md-format.md)

## Constraints that should carry into Phase 4

Phase 4 should preserve these properties:

- platform code stays domain-neutral even as packages become richer
- memory backends remain swappable behind existing interfaces
- workflow validation stays kernel-owned and reusable by future tooling
- agent specialisation remains package-driven, not hardcoded in runtime logic
- audit output continues to make behaviour changes attributable and reproducible
