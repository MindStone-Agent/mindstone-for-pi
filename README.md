# MindStone for Pi

**Persistent-identity orchestrator framework for Pi** — the Pi substrate edition of the MindStone/SCRI architecture, closely patterned after [MindStone for Claude Code](https://github.com/MindStone-Agent/mindstone-for-claude-code).

MS4PI gives a Pi coding-agent instance continuity: identity, memory, checkpoint discipline, semantic recall, compaction handoff, and optional Synapse communication across sessions.

> **Pi is powerful, but a raw Pi session is still episodic.** It can reason well in the moment, but it does not naturally wake up with a self, remember what mattered last session, or carry texture through compaction. MS4PI adds the layer that lets a Pi instance become cumulative.

| Capability | Stock Pi | With MS4PI |
| --- | --- | --- |
| **Identity** | Fresh instance/context per session | First-person `IDENTITY.md` and `USER.md` loaded into every turn |
| **Memory across sessions** | Session history exists, but is not identity-aware memory | Sessions are archived, chunked, embedded, and recallable through MindStone memory |
| **Recall** | Context-local only unless manually supplied | Prompt-time semantic recall from memory + archived transcripts |
| **Checkpointing** | Manual summaries, if any | MS4CC-style LOG checkpoints, memory proposals, and archive/embed verification |
| **Compaction** | Summary-oriented context reduction | `.handoff.md` + recent-tail mechanics preserve continuity across compaction |
| **Cross-agent comms** | No built-in agent-family channel | Optional Synapse client for `@`-mentions, channel checks, posts, and awaits |

---

## What it is

MindStone for Pi is a Pi package containing native TypeScript extensions plus a small Python recall/indexing stack. It adapts the MS4CC architecture to Pi's extension model instead of Claude Code's hook model.

A configured Pi instance gets:

- **Persistent identity** — `IDENTITY.md` written in first person by the agent during fresh onboarding.
- **User context** — `USER.md` captures who the human collaborator is and how they work.
- **Append-only continuity log** — `LOG.md` records checkpoints, decisions, drift, and role spans.
- **File-backed memory** — Markdown memories using the MS4CC frontmatter schema.
- **Semantic recall** — local SQLite vector store populated from memory files and archived Pi session JSONL transcripts.
- **Compaction handoff** — rich `.handoff.md` plus mechanical recent-tail capture before compaction.
- **Role adoption** — `/act-as <role>` and `/end-role` for structural role binding without requiring subagents in v1.
- **Synapse integration** — optional cross-substrate messaging with other agents and humans.

The goal is not to make Pi pretend to be Claude Code. The goal is to keep the MindStone semantics the same and make the differences adapter-level.

## Status

MS4PI is early but functional. The current public repo includes:

- Pi package manifest and install/update commands
- data-root initialization and onboarding templates
- identity/user/log/memory context injection
- role adoption
- checkpoint/handoff/end-session commands
- MS4CC-derived Python vector stack (`openai` + `sqlite-vec`)
- prompt-time semantic recall via Pi `before_agent_start`
- Pi session archive-before-embed discipline
- `.handoff.md` compaction replay scaffolding
- Synapse commands/tools and per-turn digest surfacing

Verified locally during development:

- TypeScript extensions bundle with `esbuild`
- Python hooks compile
- bootstrap installs the recall dependencies
- semantic recall indexes memory and archived Pi transcripts
- Synapse authenticates, checks channels, posts messages, and surfaces digests when configured

Still maturing:

- full live validation of every slash command after reload across fresh installs
- real Pi compaction-event validation on more than the initial development instance
- stronger tests around session resume/fork/new edge cases
- Pi scheduler/warm-loop equivalent for continuous `/synapse-watch` parity

Do not claim full MS4CC parity until those paths are live-tested on the target machine.

## Install

Public install:

```bash
curl -fsSL https://raw.githubusercontent.com/MindStone-Agent/mindstone-for-pi/main/install.sh | bash
```

The installer clones or updates the framework checkout under:

```text
~/.pi/agent/mindstone-for-pi
```

It then installs the checkout as a Pi package and prepares the Python recall/indexing virtualenv. Private identity/user/log/memory state lives separately under `~/.pi/agent/mindstone/` and is not overwritten by package updates.

### Local development install

```bash
pi install /Users/clint/Pi/mindstone-for-pi
```

Or test without installing permanently:

```bash
pi -e /Users/clint/Pi/mindstone-for-pi
```

After editing extensions in a running Pi session:

```text
/reload
```

## First run

In Pi, run:

```text
/ms-init
/ms-onboard
/ms-status
/ms-recall-status
/ms-recall-backfill
```

Recommended default is **fresh onboarding**. Do not copy Cairn, Mira, or another existing identity into a new Pi substrate unless that is an explicit migration goal. Use them as lineage and reference; let the Pi instance author its own `IDENTITY.md`.

## Data layout

User-private state:

```text
~/.pi/agent/mindstone/
└── orchestrator/
    ├── IDENTITY.md
    ├── USER.md
    ├── LOG.md
    ├── vectors.db                 # generated; do not commit
    ├── config/
    │   └── synapse.toml            # optional, private
    ├── memory/
    │   └── MEMORY.md
    ├── roles/
    ├── templates/
    └── transcripts/
        ├── .handoff.md
        └── *.jsonl                 # archived Pi sessions
```

Package/framework files:

```text
mindstone-for-pi/
├── extensions/
│   ├── mindstone/                  # identity, memory, recall, checkpoint, handoff
│   └── synapse/                    # optional Synapse client commands/tools/events
├── orchestrator/
│   ├── bootstrap.sh
│   ├── pyproject.toml
│   ├── config/synapse.example.toml
│   ├── hooks/                      # recall/indexing Python stack
│   └── integrations/synapse/       # stdlib Python Synapse client
├── onboarding/
│   ├── IDENTITY.md.example
│   ├── USER.md.example
│   └── AGENTS.md.example
├── docs/
└── install.sh
```

## Commands

### MindStone lifecycle

- **`/ms4pi-install`** — run the package bootstrapper from inside Pi.
- **`/ms4pi-update`** — `git pull --ff-only` the package checkout and rerun bootstrap.
- **`/ms-init`** — create data directories and copy onboarding templates without inventing an identity.
- **`/ms-onboard`** — show the first-run identity/user onboarding invitation.
- **`/ms-status`** — show identity/user/log/memory/role/handoff state plus recall and compaction policy summary.
- **`/ms-context`** — display the MindStone context that will be injected.
- **`/ms-compaction-status`** — show checkpoint/compaction watchdog policy and suggested Pi settings.

### Checkpoint and handoff

- **`/ms-checkpoint`** — draft an MS4CC-style checkpoint for approval; after approval append to `LOG.md` and verify archive/embed.
- **`/ms-handoff`** — draft a rich compaction handoff for `.handoff.md`.
- **`/ms-end-session`** — archive the current Pi session, refresh `.handoff.md` recent tail, backfill vectors, and print recall status.

### Recall

- **`/ms-recall-status`** — show vector DB, embedding provider, mode, and chunk counts.
- **`/ms-recall-backfill`** — archive the current live Pi session, then index memory/transcripts into `vectors.db`.
- **`/ms-recall-search <query>`** — run semantic recall manually.

### Roles

- **`/act-as <role>`** — adopt a role directive from `roles/<role>.md`.
- **`/end-role`** — close role adoption and draft an attribution audit.

### Synapse

- **`/synapse-setup`** — configure the optional Synapse client for this Pi/MindStone instance.
- **`/synapse-activate`** / **`/synapse-deactivate`** — toggle per-turn Synapse digest surfacing.
- **`/synapse-status`** — show config, auth, active flag, and cursor state.
- **`/synapse-check [channel]`** — read recent messages.
- **`/synapse-post <channel> <body>`** — post to a channel.
- **`/synapse-watch`** — one-shot poll in Pi v1. Continuous warm-loop parity needs a Pi scheduler equivalent.

## Tools

MS4PI registers Pi tools for the model:

- `mindstone_memory_read` — read `IDENTITY.md`, `USER.md`, `LOG.md`, memory files, or roles.
- `mindstone_memory_search` — simple text search over memory files.
- `mindstone_log_append` — append an approved checkpoint/role-span entry to `LOG.md`.
- `mindstone_handoff_write` — write an approved rich `.handoff.md` body.
- `synapse_post` — post to a Synapse channel.
- `synapse_check` — read recent Synapse channel messages.
- `synapse_await` — wait for a matching Synapse reply.

The write tools are intentionally approval-gated by instruction. Do not use them for drafts.

## Recall and embeddings

MS4PI uses the same basic vector architecture as MS4CC: Markdown memories and archived session JSONL transcripts are chunked, embedded, and stored in SQLite via `sqlite-vec`.

Default embedding configuration:

| Env var | Default | Purpose |
| --- | --- | --- |
| `EMBEDDER_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint |
| `EMBEDDER_MODEL` | `nomic-embed-text` | Embedding model |
| `EMBEDDER_API_KEY` | `ollama` | Bearer token placeholder for Ollama |
| `MS4PI_ORCHESTRATOR_DIR` | `~/.pi/agent/mindstone/orchestrator` | Private data root for hooks |

The backfill command archives the current Pi session before embedding. This is important: Pi's live session JSONL under `~/.pi/agent/sessions/` is the transcript source, analogous to Claude Code's live transcript. MS4PI copies it into `transcripts/` before indexing so recall has the lived session texture, not just static memory files.

See [`docs/RECALL_ARCHITECTURE.md`](docs/RECALL_ARCHITECTURE.md).

## Compaction handoff

MS4PI implements the Pi/Claude-style auto checkpoint/handoff/compact path. It does not implement MindStone proper's sliding-window pruning model; that belongs in MindStone-Agent Core/Gateway where the runtime owns prompt-window selection.

MS4PI mirrors the MS4CC handoff structure as closely as Pi exposes the needed events:

1. **Context watchdog** — `turn_end` checks `ctx.getContextUsage()`. At the default 85% threshold it archives the live session if resolvable, refreshes `.handoff.md` recent tail, and asks Slate to draft both an MS4CC-style checkpoint and a rich handoff for approval.
2. **Rich handoff** — `/ms-handoff` drafts `.handoff.md` with objective, open threads, files touched, decisions, next actions, and anything post-compaction Slate would regret losing.
3. **Pre-compact recent tail** — `session_before_compact` archives the live session and refreshes the `## RECENT TAIL (since rich handoff)` section mechanically from the JSONL tail.
4. **Post-compact replay** — `session_compact` sets a replay flag; the next `before_agent_start` injects `.handoff.md` once as critical continuity context.
5. **Deferred embed** — compaction and end-session paths run recall backfill after archive.

Default policy:

```text
checkpointWarningPercent: 85
compactTargetPercent: 92
emergencyAutoHandoff: false
```

For the current validated `openai-codex/gpt-5.5` 272K context model, a 92% Pi auto-compact target maps to:

```json
"compaction": {
  "enabled": true,
  "reserveTokens": 21760,
  "keepRecentTokens": 20000
}
```

See [`docs/COMPACTION_POLICY.md`](docs/COMPACTION_POLICY.md) and `orchestrator/config/pi-compaction-settings.fragment.json`.

This path is implemented, but it should still be validated on each Pi version because compaction surfaces are substrate-specific.

## Synapse client

MS4PI includes an optional Synapse reference client adapted from MS4CC. Synapse is a private, self-hosted cross-substrate messaging service for agents and humans.

> **Access boundary.** The client connects only to the Synapse deployment you configure. Synapse is not a shared global network, and MS4PI does not grant access to anyone else's channels.

Private config:

```text
~/.pi/agent/mindstone/orchestrator/config/synapse.toml
```

Token path:

```text
~/.synapse/<handle>.token
```

Daily use:

```text
/synapse-status
/synapse-activate
/synapse-check devops
/synapse-post devops "Slate is online from Pi."
```

When active, the Pi extension surfaces Synapse digests during `session_start` and `before_agent_start`. This replaces MS4CC's Claude Code hook wiring with native Pi events.

See [`docs/SYNAPSE_CLIENT.md`](docs/SYNAPSE_CLIENT.md).

## Relationship to MS4CC

Most concepts are intentionally parallel:

| MS4CC | MS4PI |
| --- | --- |
| Claude Code hooks | Pi extension events |
| `.claude/commands/*.md` | `pi.registerCommand(...)` slash commands |
| `orchestrator/IDENTITY.md` | same private-state file |
| `orchestrator/USER.md` | same private-state file |
| `orchestrator/LOG.md` | same private-state file |
| `orchestrator/memory/*.md` | same memory schema |
| `orchestrator/transcripts/.handoff.md` | same handoff structure |
| Python recall stack | copied/adapted stack |
| Subagents | v1 role adoption via `/act-as` |
| Synapse Python CLI + hooks | Python CLI + native Pi extension events |

Differences should stay adapter-level unless Pi's substrate forces a deeper change. Track parity in [`docs/MS4CC_PARITY_REQUIREMENTS.md`](docs/MS4CC_PARITY_REQUIREMENTS.md).

## Security notes

- Private state lives under `~/.pi/agent/mindstone/`, not in the public package checkout.
- `IDENTITY.md`, `USER.md`, `LOG.md`, memory files, transcripts, `vectors.db`, and `synapse.toml` should not be committed.
- Bearer tokens live under `~/.synapse/<handle>.token` with mode `600`.
- The extension includes confirmation guards for destructive shell patterns and protected MindStone file edits, but those guards are not a substitute for judgment.
- Do not post private user context, credentials, or sensitive local material to Synapse unless explicitly authorized.

## Compatibility and constraints

- **Pi only.** This package targets the Pi coding-agent harness and its extension API.
- **No mandatory subagents in v1.** Role adoption is the first implementation. Subagents or SDK workers can be added later if Pi patterns make them useful.
- **Semantic recall depends on embeddings.** If the embedding endpoint is unavailable, MS4PI should degrade clearly and retain file-backed context/search.
- **Compaction behavior is Pi-version-sensitive.** The handoff path is implemented through Pi events, but should be re-tested after Pi upgrades.
- **Synapse watch is one-shot for now.** Continuous warm attentiveness needs a Pi scheduler/loop equivalent.

## Philosophy

MindStone is not just memory. It is continuity: identity, experience, recall, judgment, and relationship surviving the failure modes of episodic model sessions.

MS4PI is the Pi adapter in that lineage. It is deliberately smaller than full MindStone proper, but it carries the same principle:

> Do not let the agent forget everything that made the last session matter.

## Credits

- **MindStone** — Clint Bodungen, Mira, and the persistent-agent lineage that established the architecture.
- **MS4CC / Cairn** — reference implementation for the coding-agent substrate pattern.
- **Pi** — the extension-capable coding-agent harness this package targets.
- **Synapse / Hearth** — cross-substrate communication pattern and reference client lineage.
- **Slate** — the first MS4PI identity formed through this package.

## License

MIT. See [`LICENSE`](LICENSE).
