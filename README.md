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
- embedded memory and prompt-time semantic recall (planned; text-search fallback exists first)

## Status

Early implementation scaffold. The goal is to keep the file structure and instructions as close to MS4CC as possible while swapping Claude Code hooks for Pi extension events.

Current state:

- identity/user/log file onboarding: scaffolded
- role adoption: scaffolded
- file-backed memory: scaffolded
- text memory search: scaffolded
- embedded semantic recall: scaffolded through the MS4CC Python vector stack and Pi `before_agent_start`; verify with `/ms-recall-status`, `/ms-recall-backfill`, and `/ms-recall-search`
- compaction handoff: scaffolded with `/ms-handoff`, `.handoff.md`, `session_before_compact`, and `session_compact` handlers

Do not claim semantic recall or compaction handoff parity is fully working until live Pi-session tests verify it.

## Install

Public install:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/mindstone-for-pi/main/install.sh | bash
```

The installer clones/updates the framework checkout under:

```text
~/.pi/agent/mindstone-for-pi
```

Then installs it as a Pi package and prepares the Python recall/indexing venv. Private identity/user/log/memory data stays under `~/.pi/agent/mindstone` and is never overwritten.

Install locally while developing:

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

- `/ms4pi-install` — run the package bootstrapper from inside Pi
- `/ms4pi-update` — git pull the package checkout and rerun bootstrap
- `/ms-init` — create data directories and copy onboarding templates, without inventing an identity
- `/ms-onboard` — show the first-run identity invitation
- `/ms-status` — show whether identity/user/log/memory are present
- `/ms-context` — show the context that will be injected
- `/ms-checkpoint` — draft a checkpoint entry for approval, then append/backfill after approval
- `/ms-handoff` — draft a rich `.handoff.md` compaction handoff
- `/ms-end-session` — archive the current Pi session and refresh recall before exit
- `/act-as <role>` — load a role directive for direct work
- `/end-role` — close the adopted role and run attribution audit
- `/ms-recall-status` — recall/vector status check
- `/ms-recall-backfill` — memory/transcript embedding backfill
- `/ms-recall-search <query>` — semantic recall query

## Fresh onboarding vs migration

Recommended default: **fresh onboard**.

For a new Pi substrate, do not copy Cairn as-is. Use MS4CC/Cairn as lineage and reference implementation, but let this Pi instance author its own `IDENTITY.md`.

Migration can be supported later for users who intentionally want to bring an existing identity over.

## MS4CC parity

MS4PI should remain as close to MS4CC as Pi reasonably allows. The parity requirements are tracked in:

```text
docs/MS4CC_PARITY_REQUIREMENTS.md
```

This includes the same memory schema, indexing model, checkpoint structure, `.handoff.md` structure, compaction/handoff behavior, and archive/embed discipline, with Pi extension equivalents where Claude Code hooks do not exist.

## Embedded memory and auto recall

Embedded semantic recall should be part of onboarding/install, not an afterthought.

The intended flow is:

```text
/ms-init
/ms-onboard
/ms-recall-status
/ms-recall-backfill
```

If an embedding provider/key is missing, MS4PI should report degraded mode clearly and fall back to file-backed context plus text search. See:

```text
docs/RECALL_ARCHITECTURE.md
```

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
