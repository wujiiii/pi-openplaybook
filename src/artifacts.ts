import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { ensureDir, pathExists, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./storage.ts";
import {
	type ArtifactManifest,
	type ArtifactManifestItem,
	type ArtifactSpec,
	REVIEW_DECISIONS,
	type RoleArtifactGateResult,
	type RoleCapability,
	type RoleId,
	type WorkflowState,
} from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

function placeholderValue(state: WorkflowState, role: RoleId, key: string): string {
	if (key === "workflow") return state.workflow;
	if (key === "phase") return state.phase;
	if (key === "role") return role;
	if (key === "milestone") return state.currentMilestone ?? "none";
	if (key === "task") return state.currentTask ?? "none";
	return `{${key}}`;
}

function isSafeRelativePath(path: string): boolean {
	if (!path.trim()) return false;
	if (isAbsolute(path)) return false;
	const normalized = normalize(path);
	if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
		return false;
	}
	return true;
}

export function expandArtifactPattern(pattern: string, state: WorkflowState, role: RoleId): string {
	return pattern.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => placeholderValue(state, role, key));
}

export function expandArtifactSpec(artifact: ArtifactSpec, state: WorkflowState, role: RoleId): ArtifactSpec {
	return {
		...artifact,
		path: expandArtifactPattern(artifact.path, state, role),
	};
}

export function expandRequiredArtifacts(
	capability: RoleCapability | undefined,
	state: WorkflowState,
	role: RoleId,
): string[] {
	return (capability?.requiredArtifacts ?? []).map((artifact) => expandArtifactSpec(artifact, state, role).path);
}

export function expandRequiredArtifactSpecs(
	capability: RoleCapability | undefined,
	state: WorkflowState,
	role: RoleId,
): ArtifactSpec[] {
	return (capability?.requiredArtifacts ?? []).map((artifact) => expandArtifactSpec(artifact, state, role));
}

export function hasStructuredRequiredArtifacts(capability: RoleCapability | undefined): boolean {
	return (capability?.requiredArtifacts ?? []).length > 0;
}

export function validateArtifactPatterns(capability: RoleCapability, role: string): string | undefined {
	for (const artifact of [...(capability.requiredArtifacts ?? []), ...(capability.optionalArtifacts ?? [])]) {
		const path = artifact.path;
		if (!isSafeRelativePath(path))
			return `Role '${role}' artifact path '${path}' must be relative and stay in workflow.`;
		if (!artifact.description.trim()) return `Role '${role}' artifact '${path}' description is required.`;
		if (artifact.owner !== role) return `Role '${role}' artifact '${path}' owner must match role.`;
		if (!artifact.schema?.required) continue;
		if (
			!Array.isArray(artifact.schema.required) ||
			!artifact.schema.required.every((item) => typeof item === "string")
		) {
			return `Role '${role}' artifact '${path}' schema.required must be a string array.`;
		}
	}
	for (const [name, artifact] of Object.entries(capability.artifactTemplates ?? {})) {
		if (!name.trim()) return `Role '${role}' artifact template names must not be empty.`;
		if (!isSafeRelativePath(artifact)) {
			return `Role '${role}' artifact template '${name}' path '${artifact}' must be relative and stay in workflow.`;
		}
	}
	return undefined;
}

function requiresDecisionStatus(role: RoleId, relativePath: string): boolean {
	const name = basename(relativePath).toLowerCase();
	return role === "code_reviewer" || role === "qa_tester" || name.includes("review") || name.includes("qa");
}

async function validateJsonArtifact(
	absolutePath: string,
	relativePath: string,
	role: RoleId,
	spec?: ArtifactSpec,
): Promise<string | undefined> {
	try {
		const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as Record<string, unknown> & { status?: string };
		if (requiresDecisionStatus(role, relativePath) && !REVIEW_DECISIONS.includes(parsed.status as never)) {
			return "missing approved, rejected, or needs_user_decision status";
		}
		for (const key of spec?.schema?.required ?? []) {
			if (!(key in parsed)) return `missing required key '${key}'`;
		}
		return undefined;
	} catch {
		return "invalid JSON";
	}
}

export async function readArtifactManifest(paths: WorkflowPaths): Promise<ArtifactManifest> {
	const loaded = await readJsonFile<ArtifactManifest>(join(paths.artifactsDir, "manifest.json"));
	if (loaded?.version === 1 && Array.isArray(loaded.items)) return loaded;
	return { version: 1, items: [] };
}

async function writeArtifactManifest(paths: WorkflowPaths, manifest: ArtifactManifest): Promise<void> {
	await writeJsonAtomic(join(paths.artifactsDir, "manifest.json"), manifest);
}

function mergeManifestItems(existing: ArtifactManifestItem[], next: ArtifactManifestItem[]): ArtifactManifestItem[] {
	const byKey = new Map<string, ArtifactManifestItem>();
	for (const item of existing) byKey.set(`${item.owner}:${item.phase}:${item.path}`, item);
	for (const item of next) byKey.set(`${item.owner}:${item.phase}:${item.path}`, item);
	return [...byKey.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function prepareRoleArtifacts(
	paths: WorkflowPaths,
	state: WorkflowState,
	role: RoleId,
	capability: RoleCapability | undefined,
): Promise<void> {
	const specs = expandRequiredArtifactSpecs(capability, state, role).filter((spec) =>
		(capability?.requiredArtifacts ?? []).some(
			(artifact) => expandArtifactSpec(artifact, state, role).path === spec.path,
		),
	);
	if (specs.length === 0) return;
	const now = new Date().toISOString();
	const items: ArtifactManifestItem[] = [];
	for (const spec of specs) {
		const absolute = join(paths.workflowDir, spec.path);
		await ensureDir(dirname(absolute));
		if (spec.template !== undefined) {
			if (!(await pathExists(absolute))) {
				await writeTextAtomic(absolute, spec.template);
			}
		}
		items.push({
			path: spec.path,
			owner: spec.owner,
			phase: spec.phase,
			description: spec.description,
			status: "missing",
			optional: spec.optional ?? false,
			refs: [spec.path],
			updatedAt: now,
		});
	}
	const manifest = await readArtifactManifest(paths);
	await writeArtifactManifest(paths, { version: 1, items: mergeManifestItems(manifest.items, items) });
}

export async function preparePhaseArtifacts(
	paths: WorkflowPaths,
	state: WorkflowState,
	capabilities: Partial<Record<RoleId, RoleCapability>>,
	roles: RoleId[],
): Promise<void> {
	for (const role of roles) {
		await prepareRoleArtifacts(paths, state, role, capabilities[role]);
	}
}

async function updateManifestItems(paths: WorkflowPaths, items: ArtifactManifestItem[]): Promise<void> {
	const manifest = await readArtifactManifest(paths);
	await writeArtifactManifest(paths, { version: 1, items: mergeManifestItems(manifest.items, items) });
}

export async function validateRoleArtifacts(
	paths: WorkflowPaths,
	state: WorkflowState,
	role: RoleId,
	capability: RoleCapability | undefined,
): Promise<RoleArtifactGateResult> {
	const requiredArtifacts = expandRequiredArtifacts(capability, state, role);
	const requiredSpecs = expandRequiredArtifactSpecs(capability, state, role);
	const missingArtifacts: string[] = [];
	const invalidArtifacts: Array<{ path: string; reason: string }> = [];
	const manifestItems: ArtifactManifestItem[] = [];
	const workflowRoot = resolve(paths.workflowDir);
	for (const spec of requiredSpecs) {
		const relativePath = spec.path;
		let status: ArtifactManifestItem["status"] = spec.optional ? "optional" : "valid";
		let validation: string | undefined;
		if (!isSafeRelativePath(relativePath)) {
			invalidArtifacts.push({ path: relativePath, reason: "artifact path must stay in workflow" });
			status = "invalid";
			validation = "artifact path must stay in workflow";
			continue;
		}
		const absolutePath = resolve(join(paths.workflowDir, relativePath));
		if (absolutePath !== workflowRoot && !absolutePath.startsWith(`${workflowRoot}${sep}`)) {
			invalidArtifacts.push({ path: relativePath, reason: "artifact path must stay in workflow" });
			status = "invalid";
			validation = "artifact path must stay in workflow";
			continue;
		}
		if (!(await pathExists(absolutePath))) {
			missingArtifacts.push(relativePath);
			status = spec.optional ? "optional" : "missing";
			validation = "missing";
			manifestItems.push({
				path: relativePath,
				owner: spec.owner,
				phase: spec.phase,
				description: spec.description,
				status,
				optional: spec.optional ?? false,
				refs: [relativePath],
				validation,
				updatedAt: new Date().toISOString(),
			});
			continue;
		}
		if (relativePath.toLowerCase().endsWith(".json")) {
			const jsonError = await validateJsonArtifact(absolutePath, relativePath, role, spec);
			if (jsonError) {
				invalidArtifacts.push({ path: relativePath, reason: jsonError });
				status = "invalid";
				validation = jsonError;
			}
		}
		if (spec.template !== undefined && (await readFile(absolutePath, "utf8")) === spec.template) {
			missingArtifacts.push(relativePath);
			status = "missing";
			validation = "template not completed";
		}
		manifestItems.push({
			path: relativePath,
			owner: spec.owner,
			phase: spec.phase,
			description: spec.description,
			status,
			optional: spec.optional ?? false,
			refs: [relativePath],
			validation,
			updatedAt: new Date().toISOString(),
		});
	}
	if (manifestItems.length > 0) await updateManifestItems(paths, manifestItems);
	return {
		ok: missingArtifacts.length === 0 && invalidArtifacts.length === 0,
		role,
		requiredArtifacts,
		missingArtifacts,
		invalidArtifacts,
		manifestItems,
	};
}
