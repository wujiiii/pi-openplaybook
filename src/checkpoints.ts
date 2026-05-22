import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendJsonlAtomic, pathExists, readJsonFile, writeJsonAtomic } from "./storage.ts";
import type { ChannelMessage, CheckpointMetadata, CommandResult, RollbackPlan, WorkflowState } from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

const execFileAsync = promisify(execFile);

interface GitSnapshot {
	branch: string | null;
	commit: string | null;
	isClean: boolean;
}

async function runGit(projectRoot: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

async function readGitSnapshot(projectRoot: string): Promise<GitSnapshot> {
	const branch = (await runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? null;
	const commit = (await runGit(projectRoot, ["rev-parse", "HEAD"])) ?? null;
	const status = await runGit(projectRoot, ["status", "--porcelain"]);
	const isClean = status !== undefined ? status.length === 0 : false;
	return { branch, commit, isClean };
}

function checkpointFileName(name: string): string {
	return `${name}.json`;
}

export async function createCheckpoint(
	paths: WorkflowPaths,
	state: WorkflowState,
	name: string,
	operator: string,
): Promise<CheckpointMetadata> {
	const snapshot = await readGitSnapshot(paths.projectRoot);
	const checkpoint: CheckpointMetadata = {
		name,
		phase: state.phase,
		commit: snapshot.commit,
		branch: snapshot.branch,
		stateSnapshot: state,
		createdAt: new Date().toISOString(),
		operator,
	};
	await writeJsonAtomic(join(paths.checkpointsDir, checkpointFileName(name)), checkpoint);
	return checkpoint;
}

export async function listCheckpointNames(paths: WorkflowPaths): Promise<string[]> {
	if (!(await pathExists(paths.checkpointsDir))) return [];
	const files = await readdir(paths.checkpointsDir);
	return files
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.sort();
}

export async function loadCheckpoint(paths: WorkflowPaths, name: string): Promise<CheckpointMetadata | undefined> {
	const file = join(paths.checkpointsDir, checkpointFileName(name));
	return readJsonFile<CheckpointMetadata>(file);
}

export async function buildRollbackPlan(_paths: WorkflowPaths, checkpoint: CheckpointMetadata): Promise<RollbackPlan> {
	const gitActions: string[] = [];
	if (checkpoint.commit) {
		gitActions.push(`git reset --hard ${checkpoint.commit}`);
	}
	return {
		checkpoint: checkpoint.name,
		phase: checkpoint.phase,
		commit: checkpoint.commit,
		branch: checkpoint.branch,
		requiresCleanWorktree: true,
		gitActions,
		stateAction: `restore state from checkpoint '${checkpoint.name}'`,
	};
}

export async function applyRollback(
	paths: WorkflowPaths,
	checkpoint: CheckpointMetadata,
	operator: string,
): Promise<CommandResult> {
	const git = await readGitSnapshot(paths.projectRoot);
	if (!git.isClean) {
		return {
			ok: false,
			message: "Working tree is not clean. Commit or stash changes before rollback.",
		};
	}
	if (checkpoint.commit) {
		try {
			await execFileAsync("git", ["reset", "--hard", checkpoint.commit], { cwd: paths.projectRoot });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { ok: false, message: `Failed to reset git to checkpoint commit: ${detail}` };
		}
	}
	const nextState: WorkflowState = {
		...checkpoint.stateSnapshot,
		status: "closed",
		awaitingUserApproval: false,
		blockedBy: {
			reason: `Rollback '${checkpoint.name}' executed by ${operator}.`,
			source: "system",
		},
	};
	await writeJsonAtomic(paths.stateFile, nextState);
	const audit: ChannelMessage = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		channel: "control",
		from: "orchestrator",
		to: ["user"],
		type: "system",
		text: `Rollback '${checkpoint.name}' applied.`,
		refs: [join("checkpoints", checkpointFileName(checkpoint.name)).replace(/\\/g, "/")],
	};
	await appendJsonlAtomic(join(paths.channelsDir, "control.jsonl"), audit);
	return { ok: true, message: `Rollback '${checkpoint.name}' applied.` };
}
