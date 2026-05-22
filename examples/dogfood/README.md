# OpenPlaybook dogfood

This folder contains a minimal real-runtime validation scenario for OpenPlaybook production dogfood runs.

Use `scenario.json` as the workflow input, start a workflow with the referenced presets, then fill `dogfood-report.md` with observed runtime behavior. The scenario is intentionally not part of automated CI because it may use paid model providers.
