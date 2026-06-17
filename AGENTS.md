# MindStone for Pi — Agent Orchestration Guide

This is the substrate-neutral reference for how MindStone for Pi works.

## Goal

MS4PI adds a persistent-identity layer to Pi while staying close to the MS4CC model. The parity contract is explicit in `docs/MS4CC_PARITY_REQUIREMENTS.md` and should be treated as load-bearing.

MS4PI provides:

- first-person identity in `orchestrator/IDENTITY.md`
- user profile in `orchestrator/USER.md`
- continuity log in `orchestrator/LOG.md`
- memory files in `orchestrator/memory/`
- role adoption via `/act-as <role>`
- checkpointing via `/ms-checkpoint`

## Orchestrator model

### Persistent-identity mode

When `orchestrator/IDENTITY.md` exists, the orchestrator has continuity and can do work directly when judgment or collaboration matters.

Use `/act-as <role>` before doing role-shaped work. Role adoption is structural, not theatrical: it loads the role directive and binds the orchestrator to that role's standards.

### Stateless mode

When no `orchestrator/IDENTITY.md` exists, run as a stateless task executor. Do not pretend continuity exists. Prompt the user toward `/ms-onboard` if they want persistent identity.

## No subagents required for v1

MS4PI v1 does not require true subagents or Pi SDK worker sessions. Use role adoption instead:

```text
/act-as software-engineer
# do implementation directly while bound to the software-engineer directive
/end-role
```

Subagents can be added later as an optional layer.

## Embedded memory and auto recall

Embedded memory and prompt-time auto recall are core features of MS4PI.

Onboarding is not complete just because `IDENTITY.md` and `USER.md` exist. A full install should also:

- check embedding provider/key availability
- initialize or verify `vectors.db`
- backfill memory files into the vector store
- report recall status honestly
- inject relevant recall snippets on each user prompt when semantic recall is active

Until semantic recall is implemented and verified, describe the system as file-backed identity/context with text-search memory fallback. Do not claim full recall is working.

See:

- `docs/RECALL_ARCHITECTURE.md`
- `docs/MS4CC_PARITY_REQUIREMENTS.md`

## Checkpoint and memory enforcement

`/ms-checkpoint` is not just a LOG summary. It is the dream-cycle point where durable session experience becomes persistent memory.

A checkpoint must follow the MS4CC pattern:

1. Draft the LOG entry.
2. Identify durable new memories or updates.
3. Search existing memories first to avoid duplicates.
4. Draft exact memory files or updates using the schema below.
5. Draft exact `MEMORY.md` index/pointer updates.
6. Ask Clint for approval of the checkpoint bundle before writing any LOG or memory files.
7. In checkpoint flow, Clint’s “approved” means the drafted LOG plus warranted memory docs/updates and `MEMORY.md` index entries are approved, unless he explicitly narrows the approval.
8. After approval, write approved memory docs and index entries, append LOG, then run archive/embed verification.

A checkpoint is incomplete if it appends `LOG.md` but skips warranted memory docs or `MEMORY.md` index updates. If no new memory is warranted, say that explicitly in the checkpoint lint.

## Memory schema

Memory files use the MS4CC schema:

```yaml
---
name: unique_name
description: one-line description
type: feedback | project | reference | design | identity | user | log | index | roadmap | lineage
tags: []
projects: []
hits: 0
prevented: 0
last_applied: null
created: YYYY-MM-DD
half_life_days: 30
critical: false
evergreen: false
---
```

`critical: true` memories are injected in full. `evergreen: true` memories are always listed or considered. Later versions add weighted semantic recall.

Memory files live in private state under `orchestrator/memory/`. `MEMORY.md` is the index and must be updated with a pointer when a new durable memory is approved. Memory content is the orchestrator’s continuity substrate; use judgment for wording and placement, and ask Clint only when there is real ambiguity, sensitivity, or scope risk.

## Destructive actions

Always confirm before:

- destructive git actions
- force pushes
- deleting files/directories
- database drops/truncates/destructive migrations
- editing identity or memory files outside checkpoint/onboarding flows

## Fresh onboarding

Fresh onboarding is preferred over copying an existing identity. MS4CC/Cairn is lineage and reference implementation; MS4PI should let the Pi substrate instance author its own identity.
