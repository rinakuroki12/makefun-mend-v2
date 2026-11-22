# mend — Zero-Dependency AI Patch CLI

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rinakuroki12/makefun-mend-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rinakuroki12/makefun-mend-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Zero-dependency Node.js 22 CLI implementing `mend` for the [make.fun "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

Applies AI-written edits in four formats (unified diffs with drifted line numbers, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls) atomically according to `SPEC.md`.

## Run

```bash
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```
