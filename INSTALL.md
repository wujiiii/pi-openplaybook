# Installing OpenPlaybook in pi Coding Agent

OpenPlaybook is a pi package for pi Coding Agent. It bundles an extension at `./src/openplaybook/index.ts`; after installation, pi registers these commands:

- `/opb`
- `/openplaybook`

## Requirements

- Node.js `>=22.19.0`
- pi Coding Agent installed from npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` matches pi's official npm install guidance and disables dependency lifecycle scripts during install.

## Recommended: Install from Git

Pi's official package flow supports installing packages directly from git:

```bash
pi install git:github.com/wujiiii/pi-openplaybook
```

To pin a release tag or commit:

```bash
pi install git:github.com/wujiiii/pi-openplaybook@v0.1.0
```

This writes the package entry to user settings at `~/.pi/agent/settings.json`, so it is available in every project.

## Published npm Install

After the package is published to npm:

```bash
pi install npm:pi-openplaybook
```

Use an explicit version when you want a pinned workflow environment:

```bash
pi install npm:pi-openplaybook@0.1.0
```

## Update, List, or Remove

```bash
pi list
pi update --extensions
pi remove git:github.com/wujiiii/pi-openplaybook
```

Use `pi config` to enable or disable installed package features.

## Local Development Install

Use a local path only while developing this package:

```bash
npm install --ignore-scripts
npm run build
pi install E:/Development/pi-openplaybook
```

Local path installs load the TypeScript extension source directly. Run the build first when you want `/opb serve` to include the Vue WebUI assets.

## Verify Installation

Start pi in any project and run:

```text
/opb status
```

If no workflow exists yet, OpenPlaybook should return a clear "No active workflow" style message instead of "unknown command".

Then create a workflow:

```text
/opb start demo
/opb status
```

OpenPlaybook stores workflow files under:

```text
.openplaybook/demo/
```

## Start the WebUI

Inside pi:

```text
/opb serve
```

The server binds to `127.0.0.1`, defaults to port `4717`, and automatically tries the next available ports in that range.

## Runtime and Capability Presets

Global presets are stored under the pi agent directory:

```text
<agentDir>/openplaybook/runtime-presets.json
<agentDir>/openplaybook/role-capability-presets.json
```

By default, `<agentDir>` is:

```text
~/.pi/agent
```

You can override it with:

```bash
PI_CODING_AGENT_DIR=/path/to/agent-dir pi
```

Workflow startup snapshots the selected presets into:

```text
.openplaybook/<workflow>/roles/runtime-config.json
.openplaybook/<workflow>/roles/runtime-preset.json
.openplaybook/<workflow>/roles/capability-config.json
.openplaybook/<workflow>/roles/capability-preset.json
```

Running workflows do not hot-load preset edits. Close or complete the current workflow, then start a new workflow to use changed presets.

## Common Commands

```text
/opb start <workflow> [--runtime-preset <id>] [--capability-preset <id>]
/opb status
/opb next
/opb approve
/opb revise <reason>
/opb message @role <message>
/opb artifacts
/opb completion @role
/opb serve
/opb close
```

## Troubleshooting

If `/opb` is unknown:

- Confirm `pi install git:github.com/wujiiii/pi-openplaybook` or `pi install npm:pi-openplaybook` was run.
- Run `pi list` and confirm `pi-openplaybook`, the git package, or the local path is listed.
- Restart pi, or use `/reload` after changing installed package files.
- Confirm `src/openplaybook/index.ts` exists in the installed package.
- If `/opb serve` shows the missing-WebUI page, run `npm run build` in a local checkout before serving the UI.

If the WebUI does not start:

- Check whether ports `4717` through `4816` are occupied.
- Verify no local firewall rule blocks `127.0.0.1`.
- Re-run `/opb serve` and use the exact URL it prints.

If real role runtime does not start:

- Confirm your runtime preset uses `mode: "real"`.
- Confirm each selected model is available to pi Coding Agent.
- Confirm provider credentials are configured in pi before starting the workflow.
