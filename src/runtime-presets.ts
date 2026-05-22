import { createHash } from "node:crypto";
import { join } from "node:path";
import { getOpenPlaybookAgentDir } from "./agent-dir.ts";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./storage.ts";
import {
	type CommandResult,
	ROLE_IDS,
	type RoleId,
	type RoleModelAssignment,
	type RoleRuntimeConfig,
	type RuntimePreset,
	type RuntimePresetLibrary,
	type RuntimePresetSnapshot,
} from "./types.ts";

export const DEFAULT_RUNTIME_PRESET_ID = "real-default";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"] as const;
const PRESET_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MODEL_REF_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/;

export interface RuntimePresetInput {
	id: string;
	name: string;
	description?: string;
	config: RoleRuntimeConfig;
}

export interface RuntimePresetSelection {
	preset: RuntimePreset;
	snapshot: RuntimePresetSnapshot;
}

function nowIso(): string {
	return new Date().toISOString();
}

export function createDefaultRuntimeConfig(): RoleRuntimeConfig {
	return {
		mode: "real",
		defaultModel: "openai/gpt-5.4",
		roles: {
			orchestrator: { model: "google/gemini-3.1-pro-preview" },
			product_manager: { model: "anthropic/claude-sonnet-4-6" },
			architect: { model: "anthropic/claude-opus-4-7" },
			architecture_reviewer: { model: "openai/gpt-5.5" },
			sql_designer: { model: "openai/gpt-5.4" },
			plan_writer: { model: "openai/gpt-5.5" },
			plan_reviewer: { model: "anthropic/claude-sonnet-4-6" },
			frontend_developer: { model: "google/gemini-3.1-pro-preview" },
			backend_developer: { model: "openai/gpt-5.3-codex" },
			code_reviewer: { model: "openai/gpt-5.4" },
			qa_tester: { model: "openai/gpt-5.4" },
		},
	};
}

function createRealDefaultPreset(): RuntimePreset {
	const now = nowIso();
	return {
		id: DEFAULT_RUNTIME_PRESET_ID,
		name: "Real Default",
		description: "Uses the recommended real role model matrix for production OpenPlaybook workflows.",
		createdAt: now,
		updatedAt: now,
		config: createDefaultRuntimeConfig(),
	};
}

function ensureBuiltInRuntimePresets(library: RuntimePresetLibrary): RuntimePresetLibrary {
	const realDefault = createRealDefaultPreset();
	const presets = library.presets.filter((preset) => preset.config.mode === "real" && preset.id !== "mock-default");
	if (!presets.some((preset) => preset.id === realDefault.id)) {
		presets.push(realDefault);
	}
	const defaultPresetId =
		!presets.some((preset) => preset.id === library.defaultPresetId) || library.defaultPresetId === "mock-default"
			? DEFAULT_RUNTIME_PRESET_ID
			: library.defaultPresetId;
	return { ...library, defaultPresetId, presets };
}

export function resolveRuntimePresetLibraryPath(agentDir = getOpenPlaybookAgentDir()): string {
	return join(agentDir, "openplaybook", "runtime-presets.json");
}

function normalizePreset(input: RuntimePresetInput, existing?: RuntimePreset): RuntimePreset {
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

function validateModelRef(model: string | null | undefined, field: string): CommandResult | undefined {
	if (model == null) return undefined;
	if (!MODEL_REF_PATTERN.test(model)) {
		return { ok: false, message: `${field} must be a provider/model string.` };
	}
	return undefined;
}

function validateAssignment(role: string, assignment: RoleModelAssignment): CommandResult | undefined {
	const modelError = validateModelRef(assignment.model, `Role '${role}' model`);
	if (modelError) return modelError;
	if (assignment.thinkingLevel && !THINKING_LEVELS.includes(assignment.thinkingLevel)) {
		return { ok: false, message: `Role '${role}' has invalid thinkingLevel '${assignment.thinkingLevel}'.` };
	}
	return undefined;
}

export function validateRuntimePreset(input: RuntimePresetInput): CommandResult {
	if (!PRESET_ID_PATTERN.test(input.id)) {
		return { ok: false, message: "Preset id must use only letters, numbers, ., _, -." };
	}
	if (!input.name.trim()) {
		return { ok: false, message: "Preset name is required." };
	}
	if (input.config.mode !== "real") {
		return { ok: false, message: "Runtime mode must be 'real'. Mock runtime presets are not user-visible." };
	}
	const defaultModelError = validateModelRef(input.config.defaultModel, "defaultModel");
	if (defaultModelError) return defaultModelError;
	for (const role of Object.keys(input.config.roles)) {
		if (!ROLE_IDS.includes(role as RoleId)) {
			return { ok: false, message: `Unknown role '${role}'.` };
		}
		const assignment = input.config.roles[role as RoleId];
		if (!assignment) continue;
		const assignmentError = validateAssignment(role, assignment);
		if (assignmentError) return assignmentError;
	}
	return { ok: true, message: "Preset is valid." };
}

export function hashRuntimeConfig(config: RoleRuntimeConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function loadRuntimePresetLibrary(agentDir?: string): Promise<RuntimePresetLibrary> {
	const libraryPath = resolveRuntimePresetLibraryPath(agentDir);
	const loaded = await readJsonFile<RuntimePresetLibrary>(libraryPath);
	if (loaded?.version === 1 && loaded.presets.some((preset) => preset.id === loaded.defaultPresetId)) {
		const migrated = ensureBuiltInRuntimePresets(loaded);
		if (JSON.stringify(migrated) !== JSON.stringify(loaded)) {
			await writeJsonAtomic(libraryPath, migrated).catch(() => undefined);
		}
		return migrated;
	}
	const fallback: RuntimePresetLibrary = {
		version: 1,
		defaultPresetId: DEFAULT_RUNTIME_PRESET_ID,
		presets: [createRealDefaultPreset()],
	};
	await ensureDir(join(agentDir ?? getOpenPlaybookAgentDir(), "openplaybook"));
	await writeJsonAtomic(libraryPath, fallback).catch(() => undefined);
	return fallback;
}

export async function saveRuntimePresetLibrary(
	agentDir: string | undefined,
	library: RuntimePresetLibrary,
): Promise<void> {
	await writeJsonAtomic(resolveRuntimePresetLibraryPath(agentDir), library);
}

export async function createOrUpdateRuntimePreset(
	agentDir: string | undefined,
	input: RuntimePresetInput,
): Promise<CommandResult> {
	const validation = validateRuntimePreset(input);
	if (!validation.ok) return validation;
	const library = await loadRuntimePresetLibrary(agentDir);
	const existingIndex = library.presets.findIndex((preset) => preset.id === input.id);
	const existing = existingIndex === -1 ? undefined : library.presets[existingIndex];
	const preset = normalizePreset(input, existing);
	const presets = [...library.presets];
	if (existingIndex === -1) {
		presets.push(preset);
	} else {
		presets[existingIndex] = preset;
	}
	await saveRuntimePresetLibrary(agentDir, { ...library, presets });
	return { ok: true, message: `Runtime preset '${input.id}' saved.` };
}

export async function setDefaultRuntimePreset(agentDir: string | undefined, presetId: string): Promise<CommandResult> {
	const library = await loadRuntimePresetLibrary(agentDir);
	if (!library.presets.some((preset) => preset.id === presetId)) {
		return { ok: false, message: `Runtime preset '${presetId}' does not exist.` };
	}
	await saveRuntimePresetLibrary(agentDir, { ...library, defaultPresetId: presetId });
	return { ok: true, message: `Default runtime preset set to '${presetId}'.` };
}

export async function deleteRuntimePreset(agentDir: string | undefined, presetId: string): Promise<CommandResult> {
	const library = await loadRuntimePresetLibrary(agentDir);
	if (library.defaultPresetId === presetId) {
		return { ok: false, message: "Cannot delete the default runtime preset." };
	}
	const presets = library.presets.filter((preset) => preset.id !== presetId);
	if (presets.length === library.presets.length) {
		return { ok: false, message: `Runtime preset '${presetId}' does not exist.` };
	}
	await saveRuntimePresetLibrary(agentDir, { ...library, presets });
	return { ok: true, message: `Runtime preset '${presetId}' deleted.` };
}

export async function selectRuntimePreset(
	agentDir: string | undefined,
	presetId?: string,
): Promise<RuntimePresetSelection | CommandResult> {
	const library = await loadRuntimePresetLibrary(agentDir);
	const selectedId = presetId ?? library.defaultPresetId;
	const preset = library.presets.find((candidate) => candidate.id === selectedId);
	if (!preset) {
		return { ok: false, message: `Runtime preset '${selectedId}' does not exist.` };
	}
	return {
		preset,
		snapshot: {
			presetId: preset.id,
			name: preset.name,
			selectedAt: nowIso(),
			configHash: hashRuntimeConfig(preset.config),
		},
	};
}
