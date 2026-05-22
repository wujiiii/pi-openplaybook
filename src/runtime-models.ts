import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getOpenPlaybookAgentDir } from "./agent-dir.ts";
import { ROLE_IDS, type RoleId, type RoleRuntimeConfig, type RuntimeModelOption } from "./types.ts";

interface RuntimeModelLike {
	id: string;
	name?: string;
	provider: string;
}

interface RuntimeModelRegistryLike {
	getAvailable(): RuntimeModelLike[];
	getProviderDisplayName(provider: string): string;
}

const ROLE_PROVIDER_PRIORITIES: Record<RoleId, string[]> = {
	orchestrator: ["google", "anthropic", "openai", "deepseek"],
	product_manager: ["google", "anthropic", "openai", "deepseek"],
	architect: ["anthropic", "openai", "google", "deepseek"],
	sql_designer: ["anthropic", "openai", "google", "deepseek"],
	architecture_reviewer: ["anthropic", "openai", "google", "deepseek"],
	plan_writer: ["anthropic", "openai", "google", "deepseek"],
	plan_reviewer: ["anthropic", "openai", "google", "deepseek"],
	frontend_developer: ["openai", "google", "anthropic", "deepseek"],
	backend_developer: ["openai", "google", "anthropic", "deepseek"],
	code_reviewer: ["anthropic", "openai", "google", "deepseek"],
	qa_tester: ["anthropic", "openai", "google", "deepseek"],
};

function modelRef(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function findModel(models: RuntimeModelOption[], ref: string | null | undefined): RuntimeModelOption | undefined {
	if (!ref) return undefined;
	return models.find((model) => model.ref === ref);
}

function pickFirstForProviders(models: RuntimeModelOption[], providers: string[]): RuntimeModelOption | undefined {
	for (const provider of providers) {
		const model = models.find((candidate) => candidate.provider === provider);
		if (model) return model;
	}
	return models[0];
}

export function recommendRuntimeModelForRole(
	role: RoleId,
	models: RuntimeModelOption[],
	currentModel?: string | null,
): RuntimeModelOption | undefined {
	const current = findModel(models, currentModel);
	if (current) return current;
	return pickFirstForProviders(models, ROLE_PROVIDER_PRIORITIES[role]);
}

export function buildRuntimeModelRecommendations(
	models: RuntimeModelOption[],
	config?: RoleRuntimeConfig,
): Record<RoleId, string | null> {
	const recommendations = {} as Record<RoleId, string | null>;
	for (const role of ROLE_IDS) {
		recommendations[role] = recommendRuntimeModelForRole(role, models, config?.roles[role]?.model)?.ref ?? null;
	}
	return recommendations;
}

export function adaptRuntimeConfigToAvailableModels(
	config: RoleRuntimeConfig,
	models: RuntimeModelOption[],
): RoleRuntimeConfig | { ok: false; message: string } {
	if (models.length === 0) {
		return {
			ok: false,
			message: "当前 pi 没有可用模型。请先使用 /login 登录至少一个模型供应商后再启动 OpenPlaybook workflow。",
		};
	}
	const defaultModel = findModel(models, config.defaultModel)?.ref ?? models[0].ref;
	const roles: RoleRuntimeConfig["roles"] = {};
	for (const role of ROLE_IDS) {
		const assignment = config.roles[role];
		if (!assignment) continue;
		const model = recommendRuntimeModelForRole(role, models, assignment.model) ?? models[0];
		roles[role] = {
			...assignment,
			model: model.ref,
		};
	}
	return {
		...config,
		mode: "real",
		defaultModel,
		roles,
	};
}

export function normalizeAvailableRuntimeModels(
	models: RuntimeModelLike[],
	getProviderDisplayName: (provider: string) => string,
): RuntimeModelOption[] {
	return models.map((model) => ({
		ref: modelRef(model.provider, model.id),
		provider: model.provider,
		providerName: getProviderDisplayName(model.provider),
		id: model.id,
		name: model.name ?? model.id,
	}));
}

export async function loadAvailableRuntimeModels(agentDir?: string): Promise<RuntimeModelOption[]> {
	const resolvedAgentDir = agentDir ?? getOpenPlaybookAgentDir();
	const authStorage = AuthStorage.create(join(resolvedAgentDir, "auth.json"));
	const registry = ModelRegistry.create(
		authStorage,
		join(resolvedAgentDir, "models.json"),
	) as unknown as RuntimeModelRegistryLike;
	return normalizeAvailableRuntimeModels(registry.getAvailable(), (provider) =>
		registry.getProviderDisplayName(provider),
	);
}
