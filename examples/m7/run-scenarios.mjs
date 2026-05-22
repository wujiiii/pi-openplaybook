import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const snapshotDir = join(root, "snapshots");

const scenarios = [
	{
		name: "happy-path",
		result: "approved",
		phases: ["requirements_discussion", "requirements_approval", "architecture_design", "done"],
	},
	{
		name: "review-rejected",
		result: "blocked",
		phase: "architecture_review",
		reason: "review_gate",
	},
	{
		name: "qa-rejected",
		result: "blocked",
		phase: "subtask_qa",
		reason: "qa_gate",
	},
	{
		name: "revise-blocked",
		result: "blocked",
		phase: "blocked",
		reason: "user_revise",
	},
	{
		name: "close-then-new-workflow",
		result: "ok",
		events: ["workflow_closed", "workflow_started"],
	},
	{
		name: "rollback-preview",
		result: "preview",
		actions: ["git reset --hard <commit>", "restore state snapshot"],
	},
];

await mkdir(snapshotDir, { recursive: true });
for (const scenario of scenarios) {
	await writeFile(
		join(snapshotDir, `${scenario.name}.json`),
		`${JSON.stringify({ generatedAt: new Date().toISOString(), ...scenario }, null, 2)}\n`,
		"utf8",
	);
}

console.log(`Generated ${scenarios.length} snapshots in ${snapshotDir}`);
