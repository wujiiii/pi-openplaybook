import { createHash } from "node:crypto";
import { join } from "node:path";
import { getOpenPlaybookAgentDir } from "./agent-dir.ts";
import { validateArtifactPatterns } from "./artifacts.ts";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./storage.ts";
import { validateToolPattern } from "./tool-policy.ts";
import {
	ARTIFACT_CONTEXT_MODES,
	type ArtifactSpec,
	type CapabilityPreset,
	type CapabilityPresetLibrary,
	type CapabilityPresetSnapshot,
	type CommandResult,
	MEMORY_SCOPES,
	type MemoryScope,
	ROLE_IDS,
	type RoleCapability,
	type RoleCapabilityConfig,
	type RoleId,
	TOOL_RISK_LEVELS,
	WORKFLOW_PHASES,
	type WorkflowPhase,
} from "./types.ts";

export const DEFAULT_CAPABILITY_PRESET_ID = "default-web-app";

const PRESET_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_TEXT_LENGTH = 4000;
const DEFAULT_CONTEXT_POLICY = {
	maxBootstrapTokens: 1600,
	maxRecentMessages: 6,
	includeArtifacts: "refs_only" as const,
	memoryScopes: [
		"decisions",
		"user-preferences",
		"architecture-facts",
		"implementation-notes",
		"role-lessons",
	] satisfies MemoryScope[],
};

export interface CapabilityPresetInput {
	id: string;
	name: string;
	description?: string;
	config: RoleCapabilityConfig;
}

export interface CapabilityPresetSelection {
	preset: CapabilityPreset;
	snapshot: CapabilityPresetSnapshot;
}

function nowIso(): string {
	return new Date().toISOString();
}

function roleCapability(
	persona: string,
	responsibilities: string[],
	skills: string[],
	toolIncludes: string[],
	outputContract: string,
	phasePrompts: Partial<Record<WorkflowPhase, string>>,
	requiredArtifacts: ArtifactSpec[] = [],
	optionalArtifacts: ArtifactSpec[] = [],
	artifactTemplates: Record<string, string> = {},
): RoleCapability {
	return {
		persona,
		responsibilities,
		phasePrompts,
		skills,
		toolPolicy: { include: toolIncludes, exclude: [] },
		requiredArtifacts,
		optionalArtifacts,
		artifactTemplates,
		contextPolicy: DEFAULT_CONTEXT_POLICY,
		outputContract,
	};
}

export function createDefaultCapabilityConfig(): RoleCapabilityConfig {
	return {
		roles: {
			orchestrator: roleCapability(
				"Workflow coordinator responsible for phase progress, role routing, and user gates.",
				["Keep phases moving", "Route short handoff notes", "Ask the user for decisions when blocked"],
				[],
				["shell"],
				"Write short coordination notes and reference files for details.",
				{
					requirements_discussion: "Coordinate product discussion and keep requirements artifacts current.",
					development: "Track milestone gates and keep review or QA blockers visible.",
				},
			),
			product_manager: roleCapability(
				"Product manager focused on concise requirements discovery and acceptance criteria.",
				["Clarify goals", "Capture requirements", "Identify user decisions"],
				["brainstorming"],
				["shell"],
				"Write requirements and acceptance criteria to files; keep channel messages short.",
				{ requirements_discussion: "Drive the requirements conversation and produce product requirements." },
			),
			architect: roleCapability(
				"Software architect responsible for system design, boundaries, and tradeoffs.",
				["Design architecture", "Name tradeoffs", "Reference affected modules"],
				[],
				["shell"],
				"Produce architecture artifacts with decisions, risks, and file refs.",
				{ architecture_design: "Create the architecture design and identify user decisions." },
			),
			sql_designer: roleCapability(
				"Data structure and SQL designer responsible for schema shape and persistence contracts.",
				["Design data structures", "Review SQL implications", "Document migrations"],
				[],
				["shell"],
				"Produce schema notes and migration expectations with concise refs.",
				{ architecture_design: "Design data structures that support the proposed architecture." },
			),
			architecture_reviewer: roleCapability(
				"Architecture reviewer with decision authority over architecture and data design quality.",
				["Review architecture", "Block unsafe designs", "Escalate user decisions"],
				[],
				["shell"],
				"Return approved, rejected, or needs_user_decision with blocking reasons.",
				{ architecture_review: "Review architecture and data design for feasibility and maintainability." },
			),
			plan_writer: roleCapability(
				"Implementation plan writer focused on milestone and subtask decomposition.",
				["Write milestones", "Assign subtasks", "Define review and QA gates"],
				[],
				["shell"],
				"Produce a milestone plan with subtask owners and acceptance criteria.",
				{ planning: "Create the implementation plan from approved requirements and architecture." },
			),
			plan_reviewer: roleCapability(
				"Plan reviewer responsible for completeness, sequencing, and testability.",
				["Review plan", "Find missing gates", "Request revisions when needed"],
				[],
				["shell"],
				"Return concise review findings and required plan fixes.",
				{ planning_review: "Review plan quality before development starts." },
			),
			frontend_developer: roleCapability(
				"Frontend developer for Vue or React user interfaces.",
				["Implement UI tasks", "Follow selected frontend stack", "Verify UI behavior"],
				["vue-best-practices", "vue-testing-best-practices", "ui-ux-pro-max"],
				["shell", "apply_patch"],
				"Implement assigned frontend subtasks and cite changed files and verification.",
				{ development: "Implement frontend subtask using the selected stack conventions." },
			),
			backend_developer: roleCapability(
				"Java backend developer for Spring Boot services and APIs.",
				["Implement backend tasks", "Follow Java standards", "Add focused tests"],
				["springboot-patterns", "springboot-tdd", "java-coding-standards"],
				["shell", "apply_patch"],
				"Implement assigned backend subtasks and cite changed files and verification.",
				{ development: "Implement backend subtask with Spring Boot patterns and focused tests." },
			),
			code_reviewer: roleCapability(
				"Code reviewer with decision authority over correctness, regression risk, and maintainability.",
				["Review code", "Block regressions", "Require tests for risky changes"],
				["verification-before-completion"],
				["shell"],
				"Return approved, rejected, or needs_user_decision with concrete file refs.",
				{ subtask_review: "Review the completed subtask before QA." },
			),
			qa_tester: roleCapability(
				"QA tester with decision authority over acceptance criteria and regression verification.",
				["Verify acceptance criteria", "Run focused tests", "Block failing behavior"],
				["verification-before-completion"],
				["shell"],
				"Return approved, rejected, or needs_user_decision with exact verification evidence.",
				{ subtask_qa: "Test the completed subtask against acceptance criteria." },
			),
		},
	};
}

function createDefaultPreset(): CapabilityPreset {
	const now = nowIso();
	return {
		id: DEFAULT_CAPABILITY_PRESET_ID,
		name: "Default Web App",
		description:
			"Default OpenPlayBook roles for product, architecture, planning, Vue/React frontend, and Java backend work.",
		createdAt: now,
		updatedAt: now,
		config: createDefaultCapabilityConfig(),
	};
}

export function resolveCapabilityPresetLibraryPath(agentDir = getOpenPlaybookAgentDir()): string {
	return join(agentDir, "openplaybook", "role-capability-presets.json");
}

function normalizePreset(input: CapabilityPresetInput, existing?: CapabilityPreset): CapabilityPreset {
	const now = nowIso();
	return {
		id: input.id,
		name: input.name,
		description: input.description,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		config: input.config,
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isArtifactArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((item) => {
			if (!item || typeof item !== "object") return false;
			const candidate = item as { path?: unknown; owner?: unknown; phase?: unknown; description?: unknown };
			return (
				typeof candidate.path === "string" &&
				candidate.path.trim().length > 0 &&
				typeof candidate.owner === "string" &&
				ROLE_IDS.includes(candidate.owner as RoleId) &&
				typeof candidate.phase === "string" &&
				WORKFLOW_PHASES.includes(candidate.phase as WorkflowPhase) &&
				typeof candidate.description === "string" &&
				candidate.description.trim().length > 0
			);
		})
	);
}

function hasUniqueItems(items: string[]): boolean {
	return new Set(items).size === items.length;
}

function validateText(value: unknown, field: string, allowEmpty = false): CommandResult | undefined {
	if (typeof value !== "string") return { ok: false, message: `${field} must be a string.` };
	if (!allowEmpty && !value.trim()) return { ok: false, message: `${field} is required.` };
	if (value.length > MAX_TEXT_LENGTH) return { ok: false, message: `${field} is too long.` };
	return undefined;
}

function validateRoleCapability(role: string, capability: RoleCapability): CommandResult | undefined {
	const personaError = validateText(capability.persona, `Role '${role}' persona`);
	if (personaError) return personaError;
	const outputError = validateText(capability.outputContract, `Role '${role}' outputContract`);
	if (outputError) return outputError;
	if (!isStringArray(capability.responsibilities)) {
		return { ok: false, message: `Role '${role}' responsibilities must be a string array.` };
	}
	if (!isStringArray(capability.skills)) {
		return { ok: false, message: `Role '${role}' skills must be a string array.` };
	}
	if (!capability.toolPolicy) {
		return { ok: false, message: `Role '${role}' toolPolicy is required.` };
	}
	if (!isStringArray(capability.toolPolicy.include) || !hasUniqueItems(capability.toolPolicy.include)) {
		return { ok: false, message: `Role '${role}' toolPolicy.include must be a unique non-empty string array.` };
	}
	if (
		!Array.isArray(capability.toolPolicy.exclude) ||
		!capability.toolPolicy.exclude.every((item) => typeof item === "string")
	) {
		return { ok: false, message: `Role '${role}' toolPolicy.exclude must be a unique string array.` };
	}
	if (!hasUniqueItems(capability.toolPolicy.exclude)) {
		return { ok: false, message: `Role '${role}' toolPolicy.exclude must be unique.` };
	}
	for (const entry of [...capability.toolPolicy.include, ...capability.toolPolicy.exclude]) {
		const patternError = validateToolPattern(entry);
		if (patternError) return { ok: false, message: patternError };
	}
	if (capability.requiredArtifacts && !isArtifactArray(capability.requiredArtifacts)) {
		return { ok: false, message: `Role '${role}' requiredArtifacts must be artifact objects.` };
	}
	if (capability.optionalArtifacts && !isArtifactArray(capability.optionalArtifacts)) {
		return { ok: false, message: `Role '${role}' optionalArtifacts must be artifact objects.` };
	}
	if (
		capability.artifactTemplates &&
		(!capability.artifactTemplates ||
			typeof capability.artifactTemplates !== "object" ||
			!Object.values(capability.artifactTemplates).every((item) => typeof item === "string"))
	) {
		return { ok: false, message: `Role '${role}' artifactTemplates must map names to strings.` };
	}
	const artifactError = validateArtifactPatterns(capability, role);
	if (artifactError) return { ok: false, message: artifactError };
	if (capability.contextPolicy) {
		const { maxBootstrapTokens, maxRecentMessages, includeArtifacts, memoryScopes } = capability.contextPolicy;
		if (!Number.isInteger(maxBootstrapTokens) || maxBootstrapTokens < 100) {
			return { ok: false, message: `Role '${role}' contextPolicy.maxBootstrapTokens must be at least 100.` };
		}
		if (!Number.isInteger(maxRecentMessages) || maxRecentMessages < 0) {
			return { ok: false, message: `Role '${role}' contextPolicy.maxRecentMessages must be zero or greater.` };
		}
		if (!ARTIFACT_CONTEXT_MODES.includes(includeArtifacts)) {
			return { ok: false, message: `Role '${role}' contextPolicy.includeArtifacts is invalid.` };
		}
		if (!Array.isArray(memoryScopes) || !memoryScopes.every((scope) => MEMORY_SCOPES.includes(scope))) {
			return { ok: false, message: `Role '${role}' contextPolicy.memoryScopes is invalid.` };
		}
	}
	for (const [phase, prompt] of Object.entries(capability.phasePrompts ?? {})) {
		if (!WORKFLOW_PHASES.includes(phase as WorkflowPhase)) {
			return { ok: false, message: `Role '${role}' has unknown phase '${phase}'.` };
		}
		const promptError = validateText(prompt, `Role '${role}' phase prompt '${phase}'`);
		if (promptError) return promptError;
	}
	return undefined;
}

export function validateCapabilityPreset(input: CapabilityPresetInput): CommandResult {
	if (!PRESET_ID_PATTERN.test(input.id)) {
		return { ok: false, message: "Preset id must use only letters, numbers, ., _, -." };
	}
	if (!input.name.trim()) {
		return { ok: false, message: "Preset name is required." };
	}
	for (const [tool, definition] of Object.entries(input.config.toolDefinitions ?? {})) {
		const toolError = validateToolPattern(tool);
		if (toolError) return { ok: false, message: toolError };
		const descriptionError = validateText(definition.description, `Tool '${tool}' description`);
		if (descriptionError) return descriptionError;
		const categoryError = validateText(definition.category, `Tool '${tool}' category`);
		if (categoryError) return categoryError;
		const usageError = validateText(definition.usage, `Tool '${tool}' usage`);
		if (usageError) return usageError;
		if (!TOOL_RISK_LEVELS.includes(definition.riskLevel)) {
			return { ok: false, message: `Tool '${tool}' riskLevel is invalid.` };
		}
		if (
			definition.roles &&
			(!isStringArray(definition.roles) || !definition.roles.every((role) => ROLE_IDS.includes(role as RoleId)))
		) {
			return { ok: false, message: `Tool '${tool}' roles are invalid.` };
		}
		if (
			definition.phases &&
			(!isStringArray(definition.phases) ||
				!definition.phases.every((phase) => WORKFLOW_PHASES.includes(phase as WorkflowPhase)))
		) {
			return { ok: false, message: `Tool '${tool}' phases are invalid.` };
		}
	}
	for (const role of Object.keys(input.config.roles)) {
		if (!ROLE_IDS.includes(role as RoleId)) {
			return { ok: false, message: `Unknown role '${role}'.` };
		}
		const capability = input.config.roles[role as RoleId];
		if (!capability) continue;
		const capabilityError = validateRoleCapability(role, capability);
		if (capabilityError) return capabilityError;
	}
	return { ok: true, message: "Capability preset is valid." };
}

export function hashCapabilityConfig(config: RoleCapabilityConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function loadCapabilityPresetLibrary(agentDir?: string): Promise<CapabilityPresetLibrary> {
	const libraryPath = resolveCapabilityPresetLibraryPath(agentDir);
	const loaded = await readJsonFile<CapabilityPresetLibrary>(libraryPath);
	if (loaded?.version === 1 && loaded.presets.some((preset) => preset.id === loaded.defaultPresetId)) {
		return loaded;
	}
	const fallback: CapabilityPresetLibrary = {
		version: 1,
		defaultPresetId: DEFAULT_CAPABILITY_PRESET_ID,
		presets: [createDefaultPreset()],
	};
	await ensureDir(join(agentDir ?? getOpenPlaybookAgentDir(), "openplaybook"));
	await writeJsonAtomic(libraryPath, fallback);
	return fallback;
}

export async function saveCapabilityPresetLibrary(
	agentDir: string | undefined,
	library: CapabilityPresetLibrary,
): Promise<void> {
	await writeJsonAtomic(resolveCapabilityPresetLibraryPath(agentDir), library);
}

export async function createOrUpdateCapabilityPreset(
	agentDir: string | undefined,
	input: CapabilityPresetInput,
): Promise<CommandResult> {
	const validation = validateCapabilityPreset(input);
	if (!validation.ok) return validation;
	const library = await loadCapabilityPresetLibrary(agentDir);
	const existingIndex = library.presets.findIndex((preset) => preset.id === input.id);
	const existing = existingIndex === -1 ? undefined : library.presets[existingIndex];
	const preset = normalizePreset(input, existing);
	const presets = [...library.presets];
	if (existingIndex === -1) {
		presets.push(preset);
	} else {
		presets[existingIndex] = preset;
	}
	await saveCapabilityPresetLibrary(agentDir, { ...library, presets });
	return { ok: true, message: `Capability preset '${input.id}' saved.` };
}

export async function setDefaultCapabilityPreset(
	agentDir: string | undefined,
	presetId: string,
): Promise<CommandResult> {
	const library = await loadCapabilityPresetLibrary(agentDir);
	if (!library.presets.some((preset) => preset.id === presetId)) {
		return { ok: false, message: `Capability preset '${presetId}' does not exist.` };
	}
	await saveCapabilityPresetLibrary(agentDir, { ...library, defaultPresetId: presetId });
	return { ok: true, message: `Default capability preset set to '${presetId}'.` };
}

export async function deleteCapabilityPreset(agentDir: string | undefined, presetId: string): Promise<CommandResult> {
	const library = await loadCapabilityPresetLibrary(agentDir);
	if (library.defaultPresetId === presetId) {
		return { ok: false, message: "Cannot delete the default capability preset." };
	}
	const presets = library.presets.filter((preset) => preset.id !== presetId);
	if (presets.length === library.presets.length) {
		return { ok: false, message: `Capability preset '${presetId}' does not exist.` };
	}
	await saveCapabilityPresetLibrary(agentDir, { ...library, presets });
	return { ok: true, message: `Capability preset '${presetId}' deleted.` };
}

export async function selectCapabilityPreset(
	agentDir: string | undefined,
	presetId?: string,
): Promise<CapabilityPresetSelection | CommandResult> {
	const library = await loadCapabilityPresetLibrary(agentDir);
	const selectedId = presetId ?? library.defaultPresetId;
	const preset = library.presets.find((candidate) => candidate.id === selectedId);
	if (!preset) {
		return { ok: false, message: `Capability preset '${selectedId}' does not exist.` };
	}
	return {
		preset,
		snapshot: {
			presetId: preset.id,
			name: preset.name,
			selectedAt: nowIso(),
			configHash: hashCapabilityConfig(preset.config),
		},
	};
}
