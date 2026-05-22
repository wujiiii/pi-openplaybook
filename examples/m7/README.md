# OpenPlaybook M7 Validation Assets

This folder contains reproducible validation assets for M7:

- `run-scenarios.mjs`: creates deterministic snapshot files for six key paths.
- `snapshots/*.json`: generated scenario snapshots.

Scenarios:

1. happy-path
2. review-rejected
3. qa-rejected
4. revise-blocked
5. close-then-new-workflow
6. rollback-preview

Run:

```bash
node packages/openplaybook/examples/m7/run-scenarios.mjs
```
