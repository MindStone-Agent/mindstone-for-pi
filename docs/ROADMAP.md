# MindStone for Pi Roadmap

## v0.1 — scaffold

- Pi package manifest
- global extension
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

## v0.2 — recall-aware onboarding and install

Embedded memory and auto recall must be part of onboarding/install.

- add `/ms-recall-status`
- add embedding provider/key check
- initialize `vectors.db` or explicit degraded mode
- backfill existing memory files during onboarding when embeddings are configured
- show recall state in `/ms-status`
- document text-search fallback vs semantic recall

## v0.3 — checkpoint discipline

- approved LOG append flow
- memory proposal flow
- role-span append flow
- protected-file confirmation for identity/memory edits
- session summary archive
- prevented counter flow during checkpoint

## v0.4 — semantic recall

- vector store decision: reuse MS4CC Python stack first or implement TypeScript stack
- per-prompt memory recall in `before_agent_start`
- transcript chunking/indexing
- hit counter updates

## v0.5 — repeatable onboarding
- polished first-run wizard
- install verification
- migration/import from MS4CC
- project-local vs global setup options

## v1.0 — public usable release
- documented install from GitHub
- stable data layout
- safety guards
- checkpoint and recall working
- examples and screenshots
