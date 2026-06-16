# MS4PI compaction policy

MS4PI uses Pi's native compaction hooks plus a MindStone context watchdog.

This is the Pi/Claude-style **auto checkpoint/handoff/compact** path. It is not MindStone proper's sliding-window pruning model. MindStone-Agent owns both selectable modes: `auto_compact` and `sliding_window`.

## Policy defaults

| Setting | Default | Purpose |
| --- | ---: | --- |
| `checkpointWarningPercent` | `85` | Prompt Slate to draft a checkpoint + rich handoff before compaction danger zone. |
| `compactTargetPercent` | `92` | Target Pi native auto-compaction threshold. |
| `keepRecentTokens` | `20000` | Pi native recent-token retention during compaction. |
| `emergencyAutoHandoff` | `false` | Do not write LOG.md or `.handoff.md` without explicit approval. |

Environment overrides supported by the extension:

```bash
MS4PI_CHECKPOINT_WARNING_PERCENT=85
MS4PI_COMPACT_TARGET_PERCENT=92
MS4PI_KEEP_RECENT_TOKENS=20000
MS4PI_EMERGENCY_AUTO_HANDOFF=false
```

## Native Pi compaction settings

Pi triggers auto-compaction when:

```text
contextTokens > contextWindow - reserveTokens
```

To target a percentage:

```text
reserveTokens = contextWindow * (1 - targetPercent / 100)
```

For the current validated default model:

```text
provider/model: openai-codex/gpt-5.5
contextWindow: 272000 tokens as displayed by `pi list-models`
targetPercent: 92
reserveTokens: 21760
```

Recommended Pi settings fragment:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 21760,
    "keepRecentTokens": 20000
  }
}
```

This fragment is also shipped at:

```text
orchestrator/config/pi-compaction-settings.fragment.json
```

Do not blindly apply the `21760` value to a different model. For a different context window, recompute the reserve token value.

## Runtime sequence

1. During `turn_end`, MS4PI checks `ctx.getContextUsage()`.
2. At or above `85%`, MS4PI:
   - archives the live Pi session if resolvable,
   - refreshes `.handoff.md` recent tail mechanically,
   - injects a user message asking Slate to draft both:
     - an MS4CC-style LOG checkpoint,
     - a rich `.handoff.md` body.
3. Slate must ask Clint for approval before writing memory files.
4. After approval, Slate uses:
   - `mindstone_log_append`
   - `mindstone_handoff_write`
5. Slate then runs `/ms-recall-backfill` or `/ms-end-session` so archive/embed is verified.
6. At the native Pi threshold, Pi compaction runs.
7. `session_before_compact` archives the live transcript and refreshes recent tail one more time.
8. `session_compact` sets the replay flag and runs deferred recall backfill.
9. The next `before_agent_start` injects `.handoff.md` once as critical post-compaction continuity.

## Sliding-window distinction

MindStone proper can keep a long-running active context in range by pruning older messages out of the prompt window while preserving the transcript. That requires a runtime that owns message selection before model calls.

MS4PI runs inside Pi and therefore uses Pi's compaction lifecycle instead of replacing Pi's prompt-window construction. MS4PI should keep this auto checkpoint/handoff/compact policy; sliding-window pruning belongs in MindStone-Agent's Core/Gateway runtime.

## Safety stance

By default, MS4PI does **not** write rich checkpoint/handoff content without approval. Pi has a real `session_before_compact` hook, so the mechanical last-chance path can still archive the session and refresh recent tail before compaction.

If Clint later authorizes emergency auto-write semantics, `MS4PI_EMERGENCY_AUTO_HANDOFF` can become the policy switch, but that behavior should be explicitly designed and tested before claiming parity.
