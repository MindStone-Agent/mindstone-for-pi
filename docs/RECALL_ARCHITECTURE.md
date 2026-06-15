# Embedded Memory and Auto Recall

Embedded memory and auto recall are core MS4PI features, not optional extras.

MS4PI should follow the same basic discipline as MS4CC:

1. identity and user context are always loaded
2. critical memories are always injected
3. memory and transcript content are embedded into a local vector store
4. each user prompt triggers semantic recall
5. relevant memory/transcript snippets are injected into the next model call
6. checkpoints update LOG.md and propose new memories
7. session/archive hooks keep the vector store fresh

## Install/onboarding requirement

A successful onboarding should not stop at `IDENTITY.md` and `USER.md`.

The onboarding/install process should also configure recall:

```text
/ms-init
├── create data root
├── copy onboarding templates
├── copy default role templates
├── create LOG.md and memory/MEMORY.md
└── initialize recall scaffolding

/ms-onboard
├── author IDENTITY.md
├── author USER.md
├── verify memory schema
├── check embedding provider/key
├── initialize vectors.db
├── backfill existing memory files
└── report recall status
```

If embeddings are not configured, onboarding should say so plainly and leave recall in degraded mode rather than pretending it works.

## Data layout

```text
~/.pi/agent/mindstone/orchestrator/
├── IDENTITY.md
├── USER.md
├── LOG.md
├── memory/
│   ├── MEMORY.md
│   └── *.md
├── transcripts/
├── vectors.db
└── recall-status.json
```

## Recall modes

### Degraded mode: text search

Available immediately. Uses filename/frontmatter/body matching.

Current tool:

```text
mindstone_memory_search
```

This is useful, but it is not SCRI-style semantic recall.

### Full mode: embedded semantic recall

Requires:

- embedding provider configured
- vector store initialized
- memory files backfilled
- prompt-time recall enabled

Default provider should probably match MS4CC initially:

```text
OpenAI text-embedding-3-small
```

But the design should allow other embedding providers later.

## Pi event mapping

| MS4CC hook | MS4PI implementation |
|---|---|
| `SessionStart` | Pi `session_start` + `before_agent_start` baseline context injection |
| `UserPromptSubmit` | Pi `before_agent_start` semantic recall based on `event.prompt` |
| `Stop` | Pi `agent_end`, `turn_end`, `session_shutdown`, and/or explicit `/ms-checkpoint` archive path |
| `PreCompact` | Pi `session_before_compact` reminder/checkpoint hook |

## Prompt-time recall

On every user prompt, MS4PI should:

1. read the prompt from `before_agent_start`
2. embed the prompt
3. query `vectors.db`
4. retrieve top memory and transcript chunks
5. apply similarity threshold and diversification
6. inject a block like:

```text
<semantic-recall>
# Semantic recall for this prompt

Use if relevant; ignore if not. Recall is probabilistic, not authoritative.

## From memory files
...

## From past session transcripts
...
</semantic-recall>
```

## Bootstrap checks

`/ms-status` should eventually show:

```text
Recall mode: text | semantic | unavailable
Embedding provider: openai/text-embedding-3-small
Embedding key: present | missing
Vector DB: present | missing
Indexed memory chunks: N
Indexed transcript chunks: N
Last backfill: timestamp
```

## Commands to add

```text
/ms-recall-status
/ms-recall-backfill
/ms-recall-search <query>
/ms-recall-disable
/ms-recall-enable
```

## Safety and honesty rule

Never say memory/recall is working unless it has been tested.

Acceptable language:

- "Identity and file-backed context are active."
- "Text memory search is available."
- "Semantic recall is not configured yet."
- "Semantic recall initialized and backfill indexed N chunks."

Unacceptable language:

- "Memory works" when only files exist.
- "Recall is active" before a prompt-time vector lookup has been verified.

## First implementation recommendation

Reuse the MS4CC Python vector stack first:

- `embedder.py`
- `vectorstore.py`
- `indexer.py`
- `recall.py`

Adapt paths to MS4PI's data root and call the scripts from the Pi extension. Once behavior is proven, decide whether to keep the Python stack or port it to TypeScript.
