# MS4CC Parity Requirements for MS4PI

MS4PI should stay as close to MS4CC as Pi reasonably allows. Differences should be adapter-level, not architectural.

## Required structure

User/private state lives in:

```text
~/.pi/agent/mindstone/orchestrator/
├── IDENTITY.md
├── USER.md
├── LOG.md
├── memory/
│   ├── MEMORY.md
│   └── *.md
├── roles/
├── templates/
├── transcripts/
│   └── .handoff.md
├── vectors.db
└── .memory-index-state.json
```

The public package repo ships framework code, templates, role examples, docs, and hook/adapter code. It must not ship a real user's identity, user profile, log, transcripts, vector DB, or accumulated private memories.

## Memory files

Use the MS4CC frontmatter schema exactly unless a change is explicitly versioned:

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

Rules:

- `critical: true` is full-context injection.
- `evergreen: true` never decays and should at minimum appear as a pointer.
- New memories are proposed during checkpoint, not silently created.
- Before creating a new memory, semantic-search existing memory for duplicates.
- Tags/projects are inferred; do not make Clint manually tag.

## Indexing and vector structure

MS4PI uses the MS4CC Python vector stack first:

```text
orchestrator/hooks/embedder.py
orchestrator/hooks/vectorstore.py
orchestrator/hooks/indexer.py
orchestrator/hooks/recall.py
```

The vector DB remains:

```text
orchestrator/vectors.db
```

Tables and chunk model should remain MS4CC-compatible:

- `chunks`
- `vec_chunks`
- source types: `memory`, `transcript`, `identity`
- chunk fields: `source_path`, `start_line`, `end_line`, `text`, metadata

MS4PI currently uses the same local-Ollama default as the current MS4CC stack:

```text
EMBEDDER_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDER_MODEL=nomic-embed-text
```

OpenAI-compatible embedding endpoints remain supported by env override.

## Recall

Prompt-time semantic recall is required.

Pi equivalent:

| MS4CC | MS4PI |
|---|---|
| `UserPromptSubmit` | `before_agent_start` using `event.prompt` |
| `recall.py` | same Python recall utility, called by extension |
| `<semantic-recall>` block | same block appended to Pi system prompt |

Recall block wording should preserve the MS4CC caveat:

> Use if relevant; ignore if not. Recall is probabilistic, not authoritative.

## Checkpoint structure

`/ms-checkpoint` must preserve the MS4CC `/checkpoint` structure.

Required LOG entry shape:

```markdown
## YYYY-MM-DD — short title

**Project(s):** [list]
**Scope:** one-line summary

### What happened
- ...

### Decisions made
- ...

### Memories cited
- filename.md — why it was useful

### Prevented confirmations
- filename.md — confirmed by Clint

### New memories proposed
- ...

### Drift flagged
- ...

### Lint
- ...
```

Rules:

- Draft first; ask user approval before appending.
- Option D prevented-confirmation remains.
- Semantic duplicate check before new memories remains.
- Drift checks remain:
  - role-shaped work without `/act-as`
  - non-trivial decisions without canonical attribution
  - memory contradictions
  - artifact skips
- Checkpoint is not complete unless archive/embed verification succeeds.

## Handoff structure

MS4PI should retain MS4CC's `.handoff.md` concept:

```text
orchestrator/transcripts/.handoff.md
```

It has two layers:

1. **Rich handoff** — model-authored, written before compaction danger zone.
2. **Recent tail** — mechanical capture written immediately before compaction.

The recent-tail marker stays the same:

```markdown
## RECENT TAIL (since rich handoff)
```

The handoff should capture:

- current objective
- open threads
- files/projects touched
- decisions made
- active role state
- what to do immediately after compaction
- anything post-compaction self would regret losing

## Compact / auto-compact structure

Pi has compaction and exposes extension events around compaction. MS4PI should map MS4CC's flow as closely as possible:

| MS4CC | MS4PI equivalent |
|---|---|
| danger-zone handoff trigger | prompt/tool/turn/context sampling where Pi exposes enough usage info; until then explicit `/ms-handoff` + compaction reminder |
| `PreCompact` | Pi `session_before_compact` |
| `SessionStart(source=compact)` handoff replay | Pi `session_compact`/next `before_agent_start` replay |
| auto-compact threshold env | Pi settings/compaction options if available; otherwise document no equivalent |

Required behavior:

- Before compaction, archive the live Pi session file if resolvable.
- Refresh `.handoff.md` with recent tail.
- After compaction, replay `.handoff.md` into context.
- Kick deferred embed of the archived pre-compaction session.
- If Pi does not expose a direct equivalent, state the limitation honestly and implement the closest event-driven fallback.

## Auto archive and auto embed

MS4CC current rule should carry over:

- cheap transcript archive can happen often
- expensive embedding should happen at checkpoint and post-compaction, not every turn
- `/ms-checkpoint` runs archive + embed explicitly
- post-compaction runs deferred embed of the archived pre-compaction transcript

MS4PI should not claim a checkpoint is complete unless the embed path prints/verifies success.

## Commands required

MS4PI command set should include:

```text
/ms-init
/ms-onboard
/ms-status
/ms-context
/ms-checkpoint
/ms-end-session
/ms-handoff
/ms-recall-status
/ms-recall-backfill
/ms-recall-search <query>
/act-as <role>
/end-role
```

## Current status

Implemented/scaffolded:

- MS4CC-style data root
- identity/user/log/memory files
- role adoption skeleton
- Python vector stack copied and env-rooted for MS4PI
- `/ms-recall-status`
- `/ms-recall-backfill`
- `/ms-recall-search`
- prompt-time semantic recall attempt in `before_agent_start` when `vectors.db` exists

Still to complete:

- robust Pi session archive resolution
- `.handoff.md` rich handoff command
- mechanical recent-tail capture from Pi JSONL
- post-compaction handoff replay/deferred embed
- fully verified `/ms-checkpoint` append + archive/embed flow
- `/ms-end-session`
- safety guards for identity/memory/destructive actions
