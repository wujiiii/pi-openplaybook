import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RoleId, WorkflowPhase } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Display name and synthetic email used for git commit attribution per role.
 * Keep emails on a fixed domain so commits are obviously workflow-driven.
 */
export const ROLE_COMMIT_IDENTITY: Record<RoleId, { name: string; email: string }> = {
	orchestrator: { name: "OpenPlaybook Orchestrator", email: "orchestrator@openplaybook.local" },
	product_manager: { name: "OpenPlaybook Product Manager", email: "product_manager@openplaybook.local" },
	architect: { name: "OpenPlaybook Architect", email: "architect@openplaybook.local" },
	sql_designer: { name: "OpenPlaybook SQL Designer", email: "sql_designer@openplaybook.local" },
	architecture_reviewer: {
		name: "OpenPlaybook Architecture Reviewer",
		email: "architecture_reviewer@openplaybook.local",
	},
	plan_writer: { name: "OpenPlaybook Plan Writer", email: "plan_writer@openplaybook.local" },
	plan_reviewer: { name: "OpenPlaybook Plan Reviewer", email: "plan_reviewer@openplaybook.local" },
	frontend_developer: { name: "OpenPlaybook Frontend Developer", email: "frontend_developer@openplaybook.local" },
	backend_developer: { name: "OpenPlaybook Backend Developer", email: "backend_developer@openplaybook.local" },
	code_reviewer: { name: "OpenPlaybook Code Reviewer", email: "code_reviewer@openplaybook.local" },
	qa_tester: { name: "OpenPlaybook QA Tester", email: "qa_tester@openplaybook.local" },
};

export interface CommitResult {
	committed: boolean;
	commit?: string;
	reason?: string;
}

async function gitOk(projectRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("git", args, { cwd: projectRoot });
}

async function isInsideGitRepo(projectRoot: string): Promise<boolean> {
	try {
		await gitOk(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
		return true;
	} catch {
		return false;
	}
}

async function hasDirtyWorktree(projectRoot: string): Promise<boolean> {
	const { stdout } = await gitOk(projectRoot, ["status", "--porcelain"]);
	return stdout.trim().length > 0;
}

/**
 * If the worktree has uncommitted changes, stage everything and commit with
 * the given role as the author. Returns `{ committed: false, reason }` for any
 * non-error skip (clean tree, not a git repo). Throws only on unexpected errors.
 */
export async function commitWorktreeIfDirty(
	projectRoot: string,
	args: { role: RoleId; phase: WorkflowPhase; message: string },
): Promise<CommitResult> {
	if (!(await isInsideGitRepo(projectRoot))) {
		return { committed: false, reason: "not_a_git_repo" };
	}
	if (!(await hasDirtyWorktree(projectRoot))) {
		return { committed: false, reason: "clean" };
	}
	const identity = ROLE_COMMIT_IDENTITY[args.role];
	if (!identity) {
		return { committed: false, reason: `unknown_role:${args.role}` };
	}
	try {
		await gitOk(projectRoot, ["add", "-A"]);
		await gitOk(projectRoot, [
			"-c",
			`user.name=${identity.name}`,
			"-c",
			`user.email=${identity.email}`,
			"commit",
			"-m",
			args.message,
			"--author",
			`${identity.name} <${identity.email}>`,
		]);
		const { stdout: hash } = await gitOk(projectRoot, ["rev-parse", "HEAD"]);
		return { committed: true, commit: hash.trim() };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { committed: false, reason: `git_failed: ${detail}` };
	}
}
