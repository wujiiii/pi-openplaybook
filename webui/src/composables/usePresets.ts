import { ref } from "vue";
import {
	getCapabilityPresets,
	getRuntimeModels,
	getRuntimePresets,
	saveCapabilityPreset,
	saveRuntimePreset,
	setDefaultCapabilityPreset,
	setDefaultRuntimePreset,
} from "../api";
import { ROLE_IDS } from "../constants";
import type {
	CapabilityPreset,
	CapabilityPresetLibrary,
	RoleId,
	RuntimeModelOption,
	RuntimePreset,
	RuntimePresetLibrary,
	RuntimeModelsResponse,
} from "../types";

const PRESETS_CACHE_TTL_MS = 3 * 60 * 1000;
let presetsCache: {
	runtime: RuntimePresetLibrary;
	capability: CapabilityPresetLibrary;
	models: RuntimeModelsResponse;
	loadedAt: number;
} | null = null;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function usePresets() {
	const runtimeLibrary = ref<RuntimePresetLibrary | null>(null);
	const capabilityLibrary = ref<CapabilityPresetLibrary | null>(null);
	const runtimeModels = ref<RuntimeModelOption[]>([]);
	const runtimeRecommendations = ref<Record<RoleId, string | null>>({} as Record<RoleId, string | null>);
	const runtimeDraftAdjusted = ref(false);
	const selectedRuntimePresetId = ref("");
	const selectedCapabilityPresetId = ref("");
	const runtimeDraft = ref<RuntimePreset | null>(null);
	const capabilityDraft = ref<CapabilityPreset | null>(null);

	function applyRuntimeRecommendations(): void {
		if (!runtimeDraft.value || runtimeModels.value.length === 0) return;
		const available = new Set(runtimeModels.value.map((model) => model.ref));
		let adjusted = false;
		if (!runtimeDraft.value.config.defaultModel || !available.has(runtimeDraft.value.config.defaultModel)) {
			runtimeDraft.value.config.defaultModel = runtimeModels.value[0]?.ref ?? null;
			adjusted = true;
		}
		for (const role of ROLE_IDS) {
			const fallback = runtimeRecommendations.value[role] ?? runtimeDraft.value.config.defaultModel ?? runtimeModels.value[0]?.ref ?? "";
			const assignment = runtimeDraft.value.config.roles[role];
			if (!assignment) {
				runtimeDraft.value.config.roles[role] = { model: fallback };
				adjusted = true;
				continue;
			}
			if (!available.has(assignment.model)) {
				assignment.model = fallback;
				adjusted = true;
			}
		}
		runtimeDraft.value.config.mode = "real";
		runtimeDraftAdjusted.value = adjusted;
	}

	function selectRuntimePreset(id: string): void {
		selectedRuntimePresetId.value = id;
		const preset = runtimeLibrary.value?.presets.find((item) => item.id === id);
		runtimeDraft.value = preset ? clone(preset) : null;
		applyRuntimeRecommendations();
	}

	function selectCapabilityPreset(id: string): void {
		selectedCapabilityPresetId.value = id;
		const preset = capabilityLibrary.value?.presets.find((item) => item.id === id);
		capabilityDraft.value = preset ? clone(preset) : null;
	}

	async function refresh(force = false): Promise<void> {
		const now = Date.now();
		let runtimePayload: RuntimePresetLibrary;
		let capabilityPayload: CapabilityPresetLibrary;
		let modelPayload: RuntimeModelsResponse;
		if (!force && presetsCache && now - presetsCache.loadedAt < PRESETS_CACHE_TTL_MS) {
			runtimePayload = presetsCache.runtime;
			capabilityPayload = presetsCache.capability;
			modelPayload = presetsCache.models;
		} else {
			[runtimePayload, capabilityPayload, modelPayload] = await Promise.all([
				getRuntimePresets(),
				getCapabilityPresets(),
				getRuntimeModels(),
			]);
			presetsCache = { runtime: runtimePayload, capability: capabilityPayload, models: modelPayload, loadedAt: now };
		}
		runtimeLibrary.value = runtimePayload;
		capabilityLibrary.value = capabilityPayload;
		runtimeModels.value = modelPayload.models;
		runtimeRecommendations.value = modelPayload.recommendations;
		if (!selectedRuntimePresetId.value) {
			selectRuntimePreset(runtimePayload.defaultPresetId);
		} else {
			selectRuntimePreset(selectedRuntimePresetId.value);
		}
		if (!selectedCapabilityPresetId.value) {
			selectCapabilityPreset(capabilityPayload.defaultPresetId);
		} else {
			selectCapabilityPreset(selectedCapabilityPresetId.value);
		}
	}

	async function saveRuntime(): Promise<void> {
		if (!runtimeDraft.value) return;
		applyRuntimeRecommendations();
		await saveRuntimePreset(runtimeDraft.value);
		presetsCache = null;
		await refresh(true);
		selectRuntimePreset(runtimeDraft.value.id);
	}

	async function saveCapability(): Promise<void> {
		if (!capabilityDraft.value) return;
		await saveCapabilityPreset(capabilityDraft.value);
		presetsCache = null;
		await refresh(true);
		selectCapabilityPreset(capabilityDraft.value.id);
	}

	async function makeRuntimeDefault(): Promise<void> {
		if (!runtimeDraft.value) return;
		await setDefaultRuntimePreset(runtimeDraft.value.id);
		presetsCache = null;
		await refresh(true);
	}

	async function makeCapabilityDefault(): Promise<void> {
		if (!capabilityDraft.value) return;
		await setDefaultCapabilityPreset(capabilityDraft.value.id);
		presetsCache = null;
		await refresh(true);
	}

	return {
		applyRuntimeRecommendations,
		capabilityDraft,
		capabilityLibrary,
		makeCapabilityDefault,
		makeRuntimeDefault,
		refresh,
		runtimeDraft,
		runtimeDraftAdjusted,
		runtimeLibrary,
		runtimeModels,
		runtimeRecommendations,
		saveCapability,
		saveRuntime,
		selectCapabilityPreset,
		selectRuntimePreset,
		selectedCapabilityPresetId,
		selectedRuntimePresetId,
	};
}
