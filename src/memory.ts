import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendJsonlAtomic, ensureDir, pathExists, readJsonlFile, writeTextAtomic } from "./storage.ts";
import {
	MEMORY_SCOPES,
	type MemoryScope,
	ROLE_IDS,
	type RoleId,
	WORKFLOW_PHASES,
	type WorkflowMemoryEntry,
	type WorkflowMemoryInput,
	type WorkflowMemorySearch,
	type WorkflowPhase,
} from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

export const MEMORY_FILES: Record<MemoryScope, string> = {
	decisions: "decisions.jsonl",
	"user-preferences": "user-preferences.jsonl",
	"architecture-facts": "architecture-facts.jsonl",
	"implementation-notes": "implementation-notes.jsonl",
	"role-lessons": "role-lessons.jsonl",
};

function now(): string {
	return new Date().toISOString();
}

function memoryPath(paths: WorkflowPaths, scope: MemoryScope): string {
	return join(paths.memoryDir, MEMORY_FILES[scope]);
}

export function isMemoryScope(value: string): value is MemoryScope {
	return MEMORY_SCOPES.includes(value as MemoryScope);
}

export async function ensureWorkflowMemory(paths: WorkflowPaths): Promise<void> {
	await ensureDir(paths.memoryDir);
	for (const scope of MEMORY_SCOPES) {
		const file = memoryPath(paths, scope);
		if (!(await pathExists(file))) {
			await writeTextAtomic(file, "");
		}
	}
}

export function validateWorkflowMemoryInput(input: WorkflowMemoryInput): string | undefined {
	if (!MEMORY_SCOPES.includes(input.scope)) return `Unknown memory scope '${input.scope}'.`;
	if (!WORKFLOW_PHASES.includes(input.phase)) return `Unknown memory phase '${input.phase}'.`;
	if (!ROLE_IDS.includes(input.role)) return `Unknown memory role '${input.role}'.`;
	if (typeof input.type !== "string" || !input.type.trim()) return "Memory type is required.";
	if (typeof input.text !== "string" || !input.text.trim()) return "Memory text is required.";
	if (input.refs && !input.refs.every((item) => typeof item === "string")) return "Memory refs must be strings.";
	if (input.tags && !input.tags.every((item) => typeof item === "string")) return "Memory tags must be strings.";
	if (
		input.importance !== undefined &&
		(!Number.isInteger(input.importance) || input.importance < 0 || input.importance > 10)
	) {
		return "Memory importance must be an integer from 0 to 10.";
	}
	return undefined;
}

export async function appendWorkflowMemory(
	paths: WorkflowPaths,
	input: WorkflowMemoryInput,
): Promise<WorkflowMemoryEntry> {
	const validationError = validateWorkflowMemoryInput(input);
	if (validationError) throw new Error(validationError);
	await ensureWorkflowMemory(paths);
	const entry: WorkflowMemoryEntry = {
		id: randomUUID(),
		ts: now(),
		scope: input.scope,
		phase: input.phase,
		role: input.role,
		type: input.type.trim(),
		text: input.text.trim(),
		refs: input.refs ?? [],
		tags: input.tags ?? [],
		importance: input.importance ?? 5,
	};
	await appendJsonlAtomic(memoryPath(paths, entry.scope), entry);
	return entry;
}

export async function readWorkflowMemory(
	paths: WorkflowPaths,
	scopes: MemoryScope[] = [...MEMORY_SCOPES],
): Promise<WorkflowMemoryEntry[]> {
	await ensureWorkflowMemory(paths);
	const results = await Promise.all(
		scopes.map((scope) => readJsonlFile<WorkflowMemoryEntry>(memoryPath(paths, scope))),
	);
	const entries: WorkflowMemoryEntry[] = results.flat();
	return entries.sort((left, right) => {
		if (right.importance !== left.importance) return right.importance - left.importance;
		return right.ts.localeCompare(left.ts);
	});
}

export async function searchWorkflowMemory(
	paths: WorkflowPaths,
	search: WorkflowMemorySearch = {},
): Promise<WorkflowMemoryEntry[]> {
	const scopes = search.scopes?.length ? search.scopes : [...MEMORY_SCOPES];
	const tags = new Set(search.tags ?? []);
	const entries = await readWorkflowMemory(paths, scopes);
	const filtered = entries.filter((entry) => {
		if (search.role && entry.role !== search.role) return false;
		if (search.phase && entry.phase !== search.phase) return false;
		if (tags.size > 0 && !entry.tags.some((tag) => tags.has(tag))) return false;
		return true;
	});
	return filtered.slice(0, search.limit ?? 50);
}

export function parseMemoryScopeList(raw: string | null): MemoryScope[] | undefined {
	if (!raw) return undefined;
	const scopes = raw
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (scopes.length === 0) return undefined;
	return scopes.filter(isMemoryScope);
}

export function isMemoryRole(value: string): value is RoleId {
	return ROLE_IDS.includes(value as RoleId);
}

export function isMemoryPhase(value: string): value is WorkflowPhase {
	return WORKFLOW_PHASES.includes(value as WorkflowPhase);
}
