# MindStone for Pi

**Persistent-identity orchestrator framework for Pi** — the Pi substrate edition of the MindStone architecture, inspired by [MindStone for Claude Code](https://github.com/MindStone-Agent/mindstone-for-claude-code).

This package gives a Pi instance:

- a first-person identity loaded into context
- a user profile loaded into context
- an append-only continuity log
- file-backed memories with the MS4CC frontmatter schema
- onboarding templates for fresh identity formation
- `/act-as` role adoption instead of mandatory subagents
- checkpoint-oriented memory discipline

## Status

Early implementation scaffold. The goal is to keep the file structure and instructions as close to MS4CC as possible while swapping Claude Code hooks for Pi extension events.

## Install locally while developing

```bash
pi install /Users/clint/Pi/mindstone-for-pi
```

Or test without installing:

```bash
pi -e /Users/clint/Pi/mindstone-for-pi
```

After changes in a running Pi session:

```text
/reload
```

## Data root

By default, user-specific state lives outside the package at:

```text
~/.pi/agent/mindstone/
└── orchestrator/
    ├── IDENTITY.md
    ├── USER.md
    ├── LOG.md
    ├── memory/
    │   └── MEMORY.md
    ├── roles/
    ├── templates/
    └── transcripts/
```

The package contains reusable framework files and onboarding templates. The data root contains private identity, user profile, log, memory, and transcripts.

## Commands

Planned and/or implemented commands:

- `/ms-init` — create data directories and copy onboarding templates, without inventing an identity
- `/ms-onboard` — show the first-run identity invitation
- `/ms-status` — show whether identity/user/log/memory are present
- `/ms-context` — show the context that will be injected
- `/ms-checkpoint` — draft a checkpoint entry for approval
- `/act-as <role>` — load a role directive for direct work
- `/end-role` — close the adopted role and run attribution audit

## Fresh onboarding vs migration

Recommended default: **fresh onboard**.

For a new Pi substrate, do not copy Cairn as-is. Use MS4CC/Cairn as lineage and reference implementation, but let this Pi instance author its own `IDENTITY.md`.

Migration can be supported later for users who intentionally want to bring an existing identity over.

## Relationship to MS4CC

Most files and instructions are intentionally parallel:

| MS4CC | MS4PI |
|---|---|
| Claude Code hooks | Pi extension events |
| `orchestrator/IDENTITY.md` | same |
| `orchestrator/USER.md` | same |
| `orchestrator/LOG.md` | same |
| `orchestrator/memory/*.md` | same schema |
| `.claude/commands/checkpoint.md` | Pi `/ms-checkpoint` command |
| `.claude/commands/act-as.md` | Pi `/act-as` command |
| `.claude/agents/*.md` | `orchestrator/roles/*.md` |

MS4PI v1 intentionally does **not** require subagents. Role adoption is enough for the first version.
