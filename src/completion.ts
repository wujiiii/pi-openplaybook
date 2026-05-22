import { join } from "node:path";
import { appendWorkflowMemory } from "./memory.ts";
import { readJsonFile, writeJsonAtomic } from "./storage.ts";
import { ROLE_IDS, type RoleCompletion, type RoleId, WORKFLOW_PHASES, type WorkflowPhase } from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

export function completionPath(paths: WorkflowPaths, role: RoleId): string {
	return join(paths.sessionsDir, role, "completion.json");
}

export function validateRoleCompletion(value: unknown, phase: WorkflowPhase): RoleCompletion | undefined {
	if (!value || typeof value !== "object") return undefined;
	const parsed = value as Partial<RoleCompletion>;
	if (parsed.status !== "done" && parsed.status !== "failed" && parsed.status !== "blocked") return undefined;
	if (!parsed.phase || !WORKFLOW_PHASES.includes(parsed.phase)) return undefined;
	if (parsed.phase !== phase) return undefined;
	if (!Array.isArray(parsed.artifacts) || !parsed.artifacts.every((item) => typeof item === "string"))
		return undefined;
	if (typeof parsed.needsUserDecision !== "boolean") return undefined;
	if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return undefined;
	if (!Array.isArray(parsed.refs) || !parsed.refs.every((item) => typeof item === "string")) return undefined;
	return {
		status: parsed.status,
		phase: parsed.phase,
		artifacts: parsed.artifacts,
		needsUserDecision: parsed.needsUserDecision,
		summary: parsed.summary,
		refs: parsed.refs,
	};
}

export async function readRoleCompletion(
	paths: WorkflowPaths,
	role: RoleId,
	phase: WorkflowPhase,
): Promise<RoleCompletion | undefined> {
	const parsed = await readJsonFile<unknown>(completionPath(paths, role));
	return validateRoleCompletion(parsed, phase);
}

export async function writeDefaultRoleCompletion(
	paths: WorkflowPaths,
	role: RoleId,
	phase: WorkflowPhase,
): Promise<void> {
	await writeJsonAtomic(completionPath(paths, role), {
		status: "blocked",
		phase,
		artifacts: [],
		needsUserDecision: false,
		summary: `@${role} has not completed ${phase}.`,
		refs: [],
	});
}

export async function readAnyRoleCompletion(paths: WorkflowPaths, role: string): Promise<RoleCompletion | undefined> {
	if (!ROLE_IDS.includes(role as RoleId)) return undefined;
	const parsed = await readJsonFile<unknown>(completionPath(paths, role as RoleId));
	if (!parsed || typeof parsed !== "object") return undefined;
	const phase = (parsed as Partial<RoleCompletion>).phase;
	if (!phase || !WORKFLOW_PHASES.includes(phase)) return undefined;
	return validateRoleCompletion(parsed, phase);
}

export async function rememberCompletionDecision(
	paths: WorkflowPaths,
	role: RoleId,
	completion: RoleCompletion,
): Promise<void> {
	await appendWorkflowMemory(paths, {
		scope: "implementation-notes",
		phase: completion.phase,
		role,
		type: "completion_decision",
		text: completion.summary,
		refs: completion.refs,
		tags: ["completion", "user-decision"],
		importance: 10,
	});
}
