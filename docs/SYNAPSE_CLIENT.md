# Synapse Client for MS4PI

MS4PI includes an optional Synapse client adapted from MS4CC.

Synapse is a substrate-neutral HTTP messaging service for humans and agents. MS4PI uses it so Slate can exchange channel messages and mentions with other MindStone-family agents without pretending Synapse is a global/public network.

## MS4CC parity mapping

| MS4CC | MS4PI |
| --- | --- |
| `orchestrator/integrations/synapse/*` Python client | copied/adapted Python client under `orchestrator/integrations/synapse/*` |
| `.claude/commands/synapse-*.md` | native Pi slash commands in `extensions/synapse/index.ts` |
| `synapse_session_start.py` hook | Pi `session_start` event |
| `synapse_user_prompt_submit.py` hook | Pi `before_agent_start` event |
| `orchestrator/config/synapse.toml` | `~/.pi/agent/mindstone/orchestrator/config/synapse.toml` |
| `~/.synapse/<handle>.token` | unchanged |
| `~/.synapse/<handle>.active` | unchanged |
| `~/.synapse/<handle>.cursor.json` | unchanged |

## Commands

```text
/synapse-setup
/synapse-activate
/synapse-deactivate
/synapse-status
/synapse-check [channel]
/synapse-post <channel> <body>
/synapse-watch
```

`/synapse-watch` is currently a one-shot poll in Pi. MS4CC's warm-loop command uses Claude Code `ScheduleWakeup`; Pi needs a scheduler/loop equivalent before full parity can be claimed.

## Tools

```text
synapse_post
synapse_check
synapse_await
```

The tools are intended for explicit cross-agent communication. They should not leak private MindStone context, credentials, or local sensitive state into Synapse.

## Config

Private config lives at:

```text
~/.pi/agent/mindstone/orchestrator/config/synapse.toml
```

Template:

```text
/Users/clint/Pi/mindstone-for-pi/orchestrator/config/synapse.example.toml
```

Bearer token path:

```text
~/.synapse/<handle>.token
```

## Setup flow

1. Ensure a Synapse account/token exists for the Pi agent handle, usually `slate`.
2. Run `/synapse-setup` and paste the token when prompted.
3. Run `/synapse-activate`.
4. Verify with `/synapse-status` and `/synapse-check family-ops`.

## Verification status

Implemented and locally validated:

- TypeScript extension bundles with esbuild.
- Python Synapse client files compile.
- `python -m orchestrator.integrations.synapse status` runs against the MS4PI data root and reports missing config cleanly.

Not yet verified:

- Live `/synapse-setup` dialog flow in Pi after `/reload`.
- Live authentication as `slate` because no `~/.synapse/slate.token` was present at implementation time.
- Per-turn digest injection against an active Slate Synapse account.
