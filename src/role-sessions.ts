import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getOpenPlaybookAgentDir } from "./agent-dir.ts";
import { createDefaultCapabilityConfig } from "./capability-presets.ts";
import { PHASE_CHANNEL_MAP, PHASE_MENTIONABLE_ROLES } from "./constants.ts";
import { buildRoleBootstrapContext } from "./context-builder.ts";
import {
	appendJsonlAtomic,
	ensureDir,
	pathExists,
	readJsonFile,
	readJsonlFile,
	writeJsonAtomic,
	writeTextAtomic,
} from "./storage.ts";
import { type ResolvedToolPolicy, resolveRoleTools } from "./tool-policy.ts";
import type {
	ChannelMessage,
	RoleCapability,
	RoleCapabilityConfig,
	RoleId,
	RoleModelAssignment,
	RoleRuntimeConfig,
	RoleSessionEvent,
	RoleSessionState,
	RoleSummary,
	WorkflowState,
} from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

interface ModelLike {
	provider: string;
	id: string;
}

interface ModelRegistryLike {
	find(provider: string, modelId: string): ModelLike | undefined;
	getAvailable(): ModelLike[];
}

interface SessionLike {
	sessionFile?: string;
	bindExtensions(options: object): Promise<void>;
	subscribe(listener: (event: AgentSessionEventLike) => void): () => void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
}

interface RuntimeLike {
	session: SessionLike;
	dispose(): Promise<void>;
}

interface ServicesLike {
	diagnostics: Array<{ type: string; message: string }>;
	modelRegistry: ModelRegistryLike;
}

interface SessionManagerFactoryLike {
	create(cwd: string, sessionDir?: string): unknown;
}

interface AuthStorageFactoryLike {
	create(path?: string): unknown;
}

export interface RoleSessionRuntimeModule {
	AuthStorage: AuthStorageFactoryLike;
	SessionManager: SessionManagerFactoryLike;
	createAgentSessionServices(options: {
		cwd: string;
		agentDir?: string;
		authStorage?: unknown;
	}): Promise<ServicesLike>;
	createAgentSessionFromServices(options: {
		services: ServicesLike;
		sessionManager: unknown;
		sessionStartEvent?: unknown;
		model?: ModelLike;
		thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
		tools?: string[];
	}): Promise<{ session: SessionLike; modelFallbackMessage?: string }>;
	createAgentSessionRuntime(
		createRuntime: (options: {
			cwd: string;
			agentDir: string;
			sessionManager: unknown;
			sessionStartEvent?: unknown;
		}) => Promise<{
			session: SessionLike;
			services: ServicesLike;
			diagnostics: Array<{ type: string; message: string }>;
			modelFallbackMessage?: string;
		}>,
		options: { cwd: string; agentDir: string; sessionManager: unknown; sessionStartEvent?: unknown },
	): Promise<RuntimeLike>;
}

interface ManagedRoleSession {
	role: RoleId;
	sessionId: string;
	startedAt: string;
	unsubscribe?: () => void;
	runtime?: RuntimeLike;
}

interface RoleSessionOrchestratorOptions {
	forceMockRuntime?: boolean;
	agentDir?: string;
	runtimeModule?: RoleSessionRuntimeModule;
}

interface TextContentLike {
	type: string;
	text?: string;
}

interface AgentSessionEventLike {
	type: string;
	message?: unknown;
	toolName?: string;
	toolCallId?: string;
}

function now(): string {
	return new Date().toISOString();
}

function roleSessionKey(paths: WorkflowPaths, role: RoleId): string {
	return `${paths.workflowDir}:${role}`;
}

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash >= modelRef.length - 1) return undefined;
	return {
		provider: modelRef.slice(0, slash).trim(),
		modelId: modelRef.slice(slash + 1).trim(),
	};
}

function createDefaultRuntimeConfig(): RoleRuntimeConfig {
	return {
		mode: "mock",
		defaultModel: null,
		roles: {},
	};
}

function createInitialRoleState(role: RoleId, phase: WorkflowState["phase"]): RoleSessionState {
	return {
		role,
		sessionId: null,
		status: "not_started",
		phase,
		lastUpdatedAt: now(),
		lastError: null,
		model: null,
	};
}

function isRoleRuntimeConfig(value: unknown): value is RoleRuntimeConfig {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<RoleRuntimeConfig>;
	return maybe.mode === "mock" || maybe.mode === "real";
}

export class RoleSessionOrchestrator {
	private sessions = new Map<string, ManagedRoleSession>();
	private runtimeModulePromise?: Promise<RoleSessionRuntimeModule | null>;
	private readonly options: RoleSessionOrchestratorOptions;

	constructor(options: RoleSessionOrchestratorOptions = {}) {
		this.options = options;
	}

	private runtimeConfigPath(paths: WorkflowPaths): string {
		return join(paths.rolesDir, "runtime-config.json");
	}

	private capabilityConfigPath(paths: WorkflowPaths): string {
		return join(paths.rolesDir, "capability-config.json");
	}

	private async roleBaseDir(paths: WorkflowPaths, role: RoleId): Promise<string> {
		const dir = join(paths.sessionsDir, role);
		await ensureDir(dir);
		await ensureDir(join(dir, "artifacts"));
		return dir;
	}

	private statusPath(paths: WorkflowPaths, role: RoleId): string {
		return join(paths.sessionsDir, role, "status.json");
	}

	private transcriptPath(paths: WorkflowPaths, role: RoleId): string {
		return join(paths.sessionsDir, role, "transcript.jsonl");
	}

	private toolEventsPath(paths: WorkflowPaths, role: RoleId): string {
		return join(paths.sessionsDir, role, "tool-events.jsonl");
	}

	private async readRuntimeConfig(paths: WorkflowPaths): Promise<RoleRuntimeConfig> {
		const loaded = await readJsonFile<RoleRuntimeConfig>(this.runtimeConfigPath(paths));
		if (isRoleRuntimeConfig(loaded)) return loaded;
		const fallback = createDefaultRuntimeConfig();
		await writeJsonAtomic(this.runtimeConfigPath(paths), fallback);
		return fallback;
	}

	private async readCapabilityConfig(paths: WorkflowPaths): Promise<RoleCapabilityConfig> {
		const loaded = await readJsonFile<RoleCapabilityConfig>(this.capabilityConfigPath(paths));
		if (loaded?.roles && typeof loaded.roles === "object") return loaded;
		const fallback = createDefaultCapabilityConfig();
		await writeJsonAtomic(this.capabilityConfigPath(paths), fallback);
		return fallback;
	}

	private async readRoleState(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"],
	): Promise<RoleSessionState> {
		const existing = await readJsonFile<RoleSessionState>(this.statusPath(paths, role));
		if (existing) return existing;
		const initial = createInitialRoleState(role, phase);
		await writeJsonAtomic(this.statusPath(paths, role), initial);
		return initial;
	}

	private async writeRoleState(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"],
		patch: Partial<RoleSessionState>,
	): Promise<RoleSessionState> {
		const current = await this.readRoleState(paths, role, phase);
		const next: RoleSessionState = {
			...current,
			...patch,
			phase,
			lastUpdatedAt: now(),
		};
		await writeJsonAtomic(this.statusPath(paths, role), next);
		return next;
	}

	private async appendEvent(paths: WorkflowPaths, role: RoleId, event: RoleSessionEvent): Promise<void> {
		const destination = event.kind === "tool" ? this.toolEventsPath(paths, role) : this.transcriptPath(paths, role);
		await appendJsonlAtomic(destination, event);
	}

	private async appendSystemEvent(
		paths: WorkflowPaths,
		role: RoleId,
		kind: RoleSessionEvent["kind"],
		summary: string,
	): Promise<void> {
		await this.appendEvent(paths, role, {
			id: randomUUID(),
			ts: now(),
			role,
			kind,
			summary,
		});
	}

	private async appendRoleChannelMessage(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"],
		text: string,
	): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		const message: ChannelMessage = {
			id: randomUUID(),
			ts: now(),
			channel: PHASE_CHANNEL_MAP[phase],
			from: role,
			to: ["user"],
			type: "role_message",
			text: trimmed,
			refs: [],
		};
		await appendJsonlAtomic(join(paths.channelsDir, `${message.channel}.jsonl`), message);
	}

	private extractAssistantText(message: unknown): string | undefined {
		if (!message || typeof message !== "object") return undefined;
		const maybeMessage = message as { role?: unknown; content?: unknown };
		if (maybeMessage.role !== "assistant") return undefined;
		if (typeof maybeMessage.content === "string") {
			const trimmed = maybeMessage.content.trim();
			return trimmed || undefined;
		}
		if (!Array.isArray(maybeMessage.content)) return undefined;
		const text = maybeMessage.content
			.filter(
				(item): item is TextContentLike =>
					typeof item === "object" &&
					item !== null &&
					"type" in item &&
					(item as { type?: unknown }).type === "text" &&
					"text" in item &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text?.trim() ?? "")
			.filter(Boolean)
			.join("\n");
		return text || undefined;
	}

	private async recordRuntimeEvent(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"],
		event: AgentSessionEventLike,
	): Promise<void> {
		if (event.type === "message_end") {
			const assistantText = this.extractAssistantText(event.message);
			if (!assistantText) return;
			await this.appendEvent(paths, role, {
				id: randomUUID(),
				ts: now(),
				role,
				kind: "transcript",
				summary: assistantText,
			});
			await this.appendRoleChannelMessage(paths, role, phase, assistantText);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			await this.appendEvent(paths, role, {
				id: randomUUID(),
				ts: now(),
				role,
				kind: "tool",
				summary: `tool start: ${event.toolName}`,
			});
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			await this.appendEvent(paths, role, {
				id: randomUUID(),
				ts: now(),
				role,
				kind: "tool",
				summary: `tool end: ${event.toolName}`,
			});
		}
	}

	// Runtime module is loaded lazily because some local environments only have source workspace without built dist.
	private async loadRuntimeModule(): Promise<RoleSessionRuntimeModule | null> {
		if (this.options.runtimeModule) return this.options.runtimeModule;
		if (!this.runtimeModulePromise) {
			this.runtimeModulePromise = import("@earendil-works/pi-coding-agent")
				.then((module) => module as unknown as RoleSessionRuntimeModule)
				.catch(() => null);
		}
		return this.runtimeModulePromise;
	}

	private resolveConfiguredModel(
		registry: ModelRegistryLike,
		assignment: RoleModelAssignment | undefined,
		defaultModel: string | null,
	): ModelLike | undefined {
		const explicit = assignment?.model ?? defaultModel;
		if (!explicit) return undefined;
		const parsed = parseModelRef(explicit);
		if (!parsed) return undefined;
		const exact = registry.find(parsed.provider, parsed.modelId);
		if (exact) return exact;
		return registry
			.getAvailable()
			.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId);
	}

	private mergeTools(
		capability: RoleCapability | undefined,
		capabilityConfig: RoleCapabilityConfig,
		role: RoleId,
		phase: WorkflowState["phase"],
	): ResolvedToolPolicy {
		return resolveRoleTools({
			capability,
			toolDefinitions: capabilityConfig.toolDefinitions,
			role,
			phase,
		});
	}

	private defaultRoleSummary(role: RoleId, phase: WorkflowState["phase"]): RoleSummary {
		return {
			role,
			phase,
			currentTask: `Work on ${phase}`,
			completedArtifacts: [],
			decisions: [],
			blockers: [],
			nextSteps: [`Continue ${phase} and write required artifacts by ref.`],
			updatedAt: now(),
		};
	}

	private async ensureRoleSummary(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"],
	): Promise<RoleSummary> {
		const summaryPath = join(paths.sessionsDir, role, "summary.json");
		const existing = await readJsonFile<RoleSummary>(summaryPath);
		if (existing) return existing;
		const summary = this.defaultRoleSummary(role, phase);
		await writeJsonAtomic(summaryPath, summary);
		await writeTextAtomic(
			join(paths.sessionsDir, role, "summary.md"),
			[
				`# ${role} Summary`,
				"",
				`Current task: ${summary.currentTask}`,
				`Next step: ${summary.nextSteps[0]}`,
				"",
			].join("\n"),
		);
		return summary;
	}

	private async buildBootstrapPrompt(
		paths: WorkflowPaths,
		role: RoleId,
		state: WorkflowState,
		capability: RoleCapability | undefined,
		tools: ResolvedToolPolicy,
	): Promise<string> {
		await this.ensureRoleSummary(paths, role, state.phase);
		const context = await buildRoleBootstrapContext({
			paths,
			role,
			state,
			capability,
			tools: tools.allowed,
			deniedTools: tools.denied,
			toolDefinitions: tools.definitions,
		});
		return context.prompt;
	}

	private async startRealRuntime(
		paths: WorkflowPaths,
		role: RoleId,
		state: WorkflowState,
		config: RoleRuntimeConfig,
		assignment: RoleModelAssignment | undefined,
		capability: RoleCapability | undefined,
		capabilityConfig: RoleCapabilityConfig,
	): Promise<ManagedRoleSession> {
		const tools = this.mergeTools(capability, capabilityConfig, role, state.phase);
		const bootstrapPrompt = await this.buildBootstrapPrompt(paths, role, state, capability, tools);
		const module = await this.loadRuntimeModule();
		if (!module) {
			throw new Error("Real runtime is unavailable in current environment. Build coding-agent dependencies first.");
		}
		const runtimeAgentDir = this.options.agentDir ?? getOpenPlaybookAgentDir();
		const roleSessionDir = join(paths.sessionsDir, role, "pi-sessions");
		await ensureDir(runtimeAgentDir);
		await ensureDir(roleSessionDir);
		const authStorage = module.AuthStorage.create(join(runtimeAgentDir, "auth.json"));
		const createRuntime = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}: {
			cwd: string;
			agentDir: string;
			sessionManager: unknown;
			sessionStartEvent?: unknown;
		}) => {
			const services = await module.createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
			});
			const model = this.resolveConfiguredModel(services.modelRegistry, assignment, config.defaultModel);
			const created = await module.createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				thinkingLevel: assignment?.thinkingLevel,
				tools: tools.allowed,
			});
			return {
				...created,
				services,
				diagnostics: [...services.diagnostics],
			};
		};
		const runtime = await module.createAgentSessionRuntime(createRuntime, {
			cwd: paths.projectRoot,
			agentDir: runtimeAgentDir,
			sessionManager: module.SessionManager.create(paths.projectRoot, roleSessionDir),
		});
		await runtime.session.bindExtensions({});
		const managed: ManagedRoleSession = {
			role,
			sessionId: runtime.session.sessionFile ?? randomUUID(),
			startedAt: now(),
			runtime,
		};
		managed.unsubscribe = runtime.session.subscribe((event) => {
			void this.recordRuntimeEvent(paths, role, state.phase, event);
		});
		await this.writeRoleState(paths, role, state.phase, {
			status: "running",
			sessionId: managed.sessionId,
			model: assignment?.model ?? config.defaultModel ?? null,
			lastError: null,
		});
		await this.appendSystemEvent(paths, role, "system", "real runtime started");
		await this.appendSystemEvent(paths, role, "transcript", bootstrapPrompt);
		await runtime.session.sendUserMessage(bootstrapPrompt, { deliverAs: "followUp" });
		await this.appendSystemEvent(paths, role, "system", "bootstrap prompt queued to real runtime");
		return managed;
	}

	private async startMockRuntime(
		paths: WorkflowPaths,
		role: RoleId,
		state: WorkflowState,
		config: RoleRuntimeConfig,
		assignment: RoleModelAssignment | undefined,
		capability: RoleCapability | undefined,
		capabilityConfig: RoleCapabilityConfig,
	): Promise<ManagedRoleSession> {
		const tools = this.mergeTools(capability, capabilityConfig, role, state.phase);
		const bootstrapPrompt = await this.buildBootstrapPrompt(paths, role, state, capability, tools);
		const managed: ManagedRoleSession = {
			role,
			sessionId: randomUUID(),
			startedAt: now(),
		};
		await this.writeRoleState(paths, role, state.phase, {
			status: "running",
			sessionId: managed.sessionId,
			model: assignment?.model ?? config.defaultModel ?? null,
			lastError: null,
		});
		await this.appendSystemEvent(paths, role, "system", "mock runtime started");
		await this.appendSystemEvent(paths, role, "transcript", bootstrapPrompt);
		return managed;
	}

	private async ensureRuntime(paths: WorkflowPaths, role: RoleId, state: WorkflowState): Promise<void> {
		const key = roleSessionKey(paths, role);
		if (this.sessions.has(key)) return;
		const config = await this.readRuntimeConfig(paths);
		const capabilityConfig = await this.readCapabilityConfig(paths);
		const assignment = config.roles[role];
		const capability = capabilityConfig.roles[role];
		await this.writeRoleState(paths, role, state.phase, { status: "starting", lastError: null });
		try {
			const managed =
				config.mode === "real" && !this.options.forceMockRuntime
					? await this.startRealRuntime(paths, role, state, config, assignment, capability, capabilityConfig)
					: await this.startMockRuntime(paths, role, state, config, assignment, capability, capabilityConfig);
			this.sessions.set(key, managed);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await this.writeRoleState(paths, role, state.phase, {
				status: "failed",
				lastError: detail,
				model: assignment?.model ?? config.defaultModel ?? null,
			});
			await this.appendSystemEvent(paths, role, "system", `runtime failed: ${detail}`);
		}
	}

	private async stopRuntime(paths: WorkflowPaths, role: RoleId, phase: WorkflowState["phase"]): Promise<void> {
		const key = roleSessionKey(paths, role);
		const managed = this.sessions.get(key);
		if (managed) {
			if (managed.unsubscribe) managed.unsubscribe();
			if (managed.runtime) await managed.runtime.dispose();
			this.sessions.delete(key);
			await this.appendSystemEvent(paths, role, "system", "session stopped");
		}
		await this.writeRoleState(paths, role, phase, { status: "stopped" });
	}

	async syncPhase(paths: WorkflowPaths, state: WorkflowState): Promise<void> {
		const allowed = new Set<RoleId>(PHASE_MENTIONABLE_ROLES[state.phase]);
		for (const role of Object.keys(state.roles) as RoleId[]) {
			await this.roleBaseDir(paths, role);
			await this.ensureRoleSummary(paths, role, state.phase);
			if (!(await pathExists(this.transcriptPath(paths, role)))) {
				await this.appendSystemEvent(paths, role, "system", "transcript initialized");
			}
			if (!(await pathExists(this.toolEventsPath(paths, role)))) {
				await this.appendSystemEvent(paths, role, "tool", "tool events initialized");
			}
			if (!allowed.has(role)) {
				await this.stopRuntime(paths, role, state.phase);
			}
			// Lazy startup: roles in `allowed` are NOT pre-started here.
			// They will be started on first user message via deliverUserMessage().
		}
	}

	async deliverUserMessage(
		paths: WorkflowPaths,
		state: WorkflowState,
		role: RoleId,
		message: string,
		refs: string[] = [],
	): Promise<void> {
		await this.ensureRuntime(paths, role, state);
		await this.writeRoleState(paths, role, state.phase, { status: "waiting" });
		await this.appendEvent(paths, role, {
			id: randomUUID(),
			ts: now(),
			role,
			kind: "transcript",
			summary: `user -> @${role}: ${message}`,
		});
		if (refs.length > 0) {
			await this.appendEvent(paths, role, {
				id: randomUUID(),
				ts: now(),
				role,
				kind: "tool",
				summary: `refs: ${refs.join(", ")}`,
			});
		}
		const managed = this.sessions.get(roleSessionKey(paths, role));
		if (managed?.runtime) {
			try {
				await managed.runtime.session.sendUserMessage(message, { deliverAs: "followUp" });
				await this.appendSystemEvent(paths, role, "system", "message queued to real runtime");
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await this.writeRoleState(paths, role, state.phase, {
					status: "failed",
					lastError: detail,
				});
				await this.appendSystemEvent(paths, role, "system", `message delivery failed: ${detail}`);
				return;
			}
		} else {
			await this.appendSystemEvent(paths, role, "system", "message accepted by mock runtime");
		}
		await this.writeRoleState(paths, role, state.phase, { status: "idle" });
	}

	async stopWorkflow(paths: WorkflowPaths, state: WorkflowState): Promise<void> {
		for (const role of Object.keys(state.roles) as RoleId[]) {
			await this.stopRuntime(paths, role, state.phase);
		}
	}

	async readRoleStatus(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"] = "draft",
	): Promise<RoleSessionState> {
		return this.readRoleState(paths, role, phase);
	}

	/**
	 * Manually start a role's runtime if it isn't already running. Lazy-startup
	 * code paths (e.g. tests, or future "warm before first message" callers)
	 * should call this rather than syncPhase, which no longer pre-starts roles.
	 */
	async ensureRoleRunning(paths: WorkflowPaths, role: RoleId, state: WorkflowState): Promise<void> {
		await this.ensureRuntime(paths, role, state);
	}

	async readRoleDetails(
		paths: WorkflowPaths,
		role: RoleId,
	): Promise<{
		state: RoleSessionState;
		transcript: RoleSessionEvent[];
		toolEvents: RoleSessionEvent[];
		artifacts: string[];
	}> {
		const state = await this.readRoleState(paths, role, "draft");
		const transcript = await readJsonlFile<RoleSessionEvent>(this.transcriptPath(paths, role));
		const toolEvents = await readJsonlFile<RoleSessionEvent>(this.toolEventsPath(paths, role));
		const artifactsDir = join(paths.sessionsDir, role, "artifacts");
		const artifacts = (await pathExists(artifactsDir)) ? (await readdir(artifactsDir)).sort() : [];
		return { state, transcript, toolEvents, artifacts };
	}

	async readRoleSummary(
		paths: WorkflowPaths,
		role: RoleId,
		phase: WorkflowState["phase"] = "draft",
	): Promise<RoleSummary> {
		return this.ensureRoleSummary(paths, role, phase);
	}
}
