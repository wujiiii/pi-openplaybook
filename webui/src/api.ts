import type {
	CapabilityPreset,
	CapabilityPresetLibrary,
	ChannelId,
	ChannelMessage,
	CheckpointMetadata,
	OpenPlaybookApiCreateWorkflowRequest,
	OpenPlaybookApiPhaseContextResponse,
	OpenPlaybookApiWorkflowsResponse,
	RoleCompletion,
	RoleId,
	RoleResponse,
	RuntimePreset,
	RuntimePresetLibrary,
	RuntimeModelsResponse,
	WorkflowMemoryEntry,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const contentType = response.headers.get("content-type") ?? "";
	const looksLikeJson = contentType.includes("application/json");
	if (!response.ok) {
		const payload = looksLikeJson
			? ((await response.json().catch(() => undefined)) as { error?: string } | undefined)
			: undefined;
		throw new Error(payload?.error ?? `请求失败：${response.status}`);
	}
	if (!looksLikeJson) {
		throw new Error(
			`后端 API 未就绪（${path} 返回了非 JSON 响应）。请确认 openplaybook 服务器已启动；如使用 vite dev，请检查 vite.config.ts 的 server.proxy 指向后端端口。`,
		);
	}
	return (await response.json()) as T;
}

export function getWorkflows(): Promise<OpenPlaybookApiWorkflowsResponse> {
	return request<OpenPlaybookApiWorkflowsResponse>("/api/workflows");
}

export function createWorkflow(payload: OpenPlaybookApiCreateWorkflowRequest): Promise<unknown> {
	return request("/api/workflows", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function getChannel(workflowId: string, channel: ChannelId): Promise<{ items: ChannelMessage[] }> {
	return request<{ items: ChannelMessage[] }>(`/api/workflows/${workflowId}/channels/${channel}?cursor=0&limit=200`);
}

export function getPhaseContext(workflowId: string): Promise<OpenPlaybookApiPhaseContextResponse> {
	return request<OpenPlaybookApiPhaseContextResponse>(`/api/workflows/${workflowId}/phase-context`);
}

export function sendMessage(workflowId: string, message: string, channel?: ChannelId): Promise<unknown> {
	return request(`/api/workflows/${workflowId}/messages`, {
		method: "POST",
		body: JSON.stringify({ message, channel }),
	});
}

export function runAction(workflowId: string, action: "approve" | "next" | "close" | "revise", reason?: string): Promise<unknown> {
	return request(`/api/workflows/${workflowId}/actions`, {
		method: "POST",
		body: JSON.stringify({ action, reason }),
	});
}

export function getRole(
	workflowId: string,
	role: RoleId,
	cursor?: number,
	limit?: number,
): Promise<RoleResponse> {
	const params = new URLSearchParams();
	if (cursor != null) params.set("cursor", String(cursor));
	if (limit != null) params.set("limit", String(limit));
	const qs = params.toString();
	return request<RoleResponse>(`/api/workflows/${workflowId}/roles/${role}${qs ? `?${qs}` : ""}`);
}

export function getRoleCompletion(workflowId: string, role: RoleId): Promise<RoleCompletion | null> {
	return request<RoleCompletion | null>(`/api/workflows/${workflowId}/roles/${role}/completion`);
}

export function getRuntimePresets(): Promise<RuntimePresetLibrary> {
	return request<RuntimePresetLibrary>("/api/runtime-presets");
}

export function getRuntimeModels(): Promise<RuntimeModelsResponse> {
	return request<RuntimeModelsResponse>("/api/runtime-models");
}

export function saveRuntimePreset(preset: RuntimePreset): Promise<unknown> {
	return request("/api/runtime-presets", {
		method: "POST",
		body: JSON.stringify({
			id: preset.id,
			name: preset.name,
			description: preset.description,
			config: preset.config,
		}),
	});
}

export function setDefaultRuntimePreset(presetId: string): Promise<unknown> {
	return request("/api/runtime-presets/default", {
		method: "POST",
		body: JSON.stringify({ presetId }),
	});
}

export function getCapabilityPresets(): Promise<CapabilityPresetLibrary> {
	return request<CapabilityPresetLibrary>("/api/capability-presets");
}

export function saveCapabilityPreset(preset: CapabilityPreset): Promise<unknown> {
	return request("/api/capability-presets", {
		method: "POST",
		body: JSON.stringify({
			id: preset.id,
			name: preset.name,
			description: preset.description,
			config: preset.config,
		}),
	});
}

export function setDefaultCapabilityPreset(presetId: string): Promise<unknown> {
	return request("/api/capability-presets/default", {
		method: "POST",
		body: JSON.stringify({ presetId }),
	});
}

export function getArtifacts(workflowId: string): Promise<{ items: unknown[] }> {
	return request<{ items: unknown[] }>(`/api/workflows/${workflowId}/artifacts`);
}

export function getMemory(workflowId: string, limit = 50): Promise<{ items: WorkflowMemoryEntry[] }> {
	return request<{ items: WorkflowMemoryEntry[] }>(`/api/workflows/${workflowId}/memory?limit=${limit}`);
}

export function getCheckpoints(workflowId: string): Promise<{ items: CheckpointMetadata[] }> {
	return request<{ items: CheckpointMetadata[] }>(`/api/workflows/${workflowId}/checkpoints`);
}
