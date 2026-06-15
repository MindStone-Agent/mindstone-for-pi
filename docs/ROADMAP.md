# MindStone for Pi Roadmap

## v0.1 — scaffold

- Pi package manifest
- global extension
- public install script
- `/ms4pi-install` and `/ms4pi-update`
- MS4CC-style data root
- onboarding templates
- `/ms-init`
- `/ms-onboard`
- `/ms-status`
- `/ms-context`
- `/ms-checkpoint`
- `/act-as`
- `/end-role`
- simple memory read/search tools

## v0.2 — MS4CC parity foundation

- keep MS4PI as close to MS4CC as Pi allows
- maintain `docs/MS4CC_PARITY_REQUIREMENTS.md`
- preserve memory schema, indexing structure, checkpoint structure, handoff structure, compaction/handoff semantics, and archive/embed discipline
- use Pi equivalents only where Claude Code hook surfaces do not exist

## v0.3 — recall-aware onboarding and install

Embedded memory and auto recall must be part of onboarding/install.

- add `/ms-recall-status`
- add embedding provider/key check
- initialize `vectors.db` or explicit degraded mode
- backfill existing memory files during onboarding when embeddings are configured
- show recall state in `/ms-status`
- document text-search fallback vs semantic recall

## v0.4 — checkpoint discipline
- approved LOG append flow
- memory proposal flow
- role-span append flow
- protected-file confirmation for identity/memory edits
- session summary archive
- prevented counter flow during checkpoint

## v0.5 — semantic recall
- vector store decision: reuse MS4CC Python stack first or implement TypeScript stack
- per-prompt memory recall in `before_agent_start`
- transcript chunking/indexing
- hit counter updates

## v0.6 — repeatable onboarding- polished first-run wizard
- install verification
- migration/import from MS4CC
- project-local vs global setup options

## v1.0 — public usable release
- documented install from GitHub
- stable data layout
- safety guards
- checkpoint and recall working
- examples and screenshots
