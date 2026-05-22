import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../coding-agent/src/index.ts";
import {
	createOrUpdateCapabilityPreset,
	deleteCapabilityPreset,
	type loadCapabilityPresetLibrary,
	setDefaultCapabilityPreset,
} from "../src/capability-presets.ts";
import { OpenPlaybookController } from "../src/commands.ts";
import { commitWorktreeIfDirty, ROLE_COMMIT_IDENTITY } from "../src/commits.ts";
import openplaybook, { type CommandRuntimeContext, type WorkflowState } from "../src/index.ts";
import { appendWorkflowMemory, searchWorkflowMemory } from "../src/memory.ts";
import { RoleSessionOrchestrator, type RoleSessionRuntimeModule } from "../src/role-sessions.ts";
import {
	createOrUpdateRuntimePreset,
	deleteRuntimePreset,
	loadRuntimePresetLibrary,
	setDefaultRuntimePreset,
} from "../src/runtime-presets.ts";
import { OpenPlaybookServer } from "../src/server.ts";
import { appendJsonlAtomic, readJsonlFile } from "../src/storage.ts";
import type { RuntimeModelOption } from "../src/types.ts";
import {
	approveWorkflow,
	getWorkflowPaths,
	loadWorkflowState,
	nextWorkflow,
	rollbackWorkflow,
	routePhaseMessage,
	startWorkflow,
} from "../src/workflow.ts";

const execFileAsync = promisify(execFile);

async function createProjectRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "openplaybook-test-"));
}

async function readJson<T>(path: string): Promise<T> {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as T;
}

function createRuntimeContext(cwd: string, notifications: string[]): CommandRuntimeContext {
	return {
		cwd,
		hasUI: true,
		notify(message: string): void {
			notifications.push(message);
		},
	};
}

async function readState(root: string, workflow: string): Promise<WorkflowState> {
	return readJson<WorkflowState>(join(root, ".openplaybook", workflow, "state.json"));
}

async function readChannel(root: string, workflow: string, channel: string): Promise<string[]> {
	const file = join(root, ".openplaybook", workflow, "channels", `${channel}.jsonl`);
	const raw = await readFile(file, "utf8");
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

const TEST_RUNTIME_MODELS: RuntimeModelOption[] = [
	{
		ref: "openai/gpt-5.4",
		provider: "openai",
		providerName: "OpenAI",
		id: "gpt-5.4",
		name: "GPT-5.4",
	},
	{
		ref: "google/gemini-3.1-pro-preview",
		provider: "google",
		providerName: "Google",
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview",
	},
	{
		ref: "anthropic/claude-opus-4-7",
		provider: "anthropic",
		providerName: "Anthropic",
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
	},
];

function createTestController(): OpenPlaybookController {
	return new OpenPlaybookController({
		runtimeModels: TEST_RUNTIME_MODELS,
		roleSessions: new RoleSessionOrchestrator({ forceMockRuntime: true }),
	});
}

describe("openplaybook M1-M3 commands & workflow lifecycle", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		for (const dir of createdDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		createdDirs.length = 0;
	});

	it("registers both /opb and /openplaybook commands", async () => {
		const registrations = new Map<
			string,
			{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
		>();
		const fakePi = {
			registerCommand(
				name: string,
				options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
			) {
				registrations.set(name, options);
			},
		} as unknown as ExtensionAPI;

		openplaybook(fakePi);

		expect(registrations.has("opb")).toBe(true);
		expect(registrations.has("openplaybook")).toBe(true);
	});

	it("creates workflow layout and state on start", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const controller = createTestController();
		const notifications: string[] = [];
		const ctx = createRuntimeContext(root, notifications);

		const result = await controller.run("start wf-alpha", ctx);
		expect(result.ok).toBe(true);

		const state = await readState(root, "wf-alpha");
		expect(state.workflow).toBe("wf-alpha");
		expect(state.status).toBe("active");
		expect(state.phase).toBe("requirements_discussion");
		expect(state.awaitingUserApproval).toBe(false);

		const controlLines = await readChannel(root, "wf-alpha", "control");
		expect(controlLines.length).toBeGreaterThan(0);
		expect(notifications.some((message) => message.includes("started"))).toBe(true);
	});

	it("enforces active workflow lock and allows new start after close", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const controller = createTestController();
		const notifications: string[] = [];
		const ctx = createRuntimeContext(root, notifications);

		const first = await controller.run("start first-wf", ctx);
		expect(first.ok).toBe(true);

		const second = await controller.run("start second-wf", ctx);
		expect(second.ok).toBe(false);
		expect(second.message.includes("Active workflow")).toBe(true);

		const close = await controller.run("close", ctx);
		expect(close.ok).toBe(true);

		const third = await controller.run("start second-wf", ctx);
		expect(third.ok).toBe(true);
	});

	it("routes @role only when role is allowed in current phase", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const controller = createTestController();
		const notifications: string[] = [];
		const ctx = createRuntimeContext(root, notifications);

		await controller.run("start routing-wf", ctx);

		const invalid = await controller.run("message @architect hello", ctx);
		expect(invalid.ok).toBe(false);

		await controller.run("next", ctx);
		await controller.run("approve", ctx);

		const valid = await controller.run("message @architect hello architecture", ctx);
		expect(valid.ok).toBe(true);

		const channelLines = await readChannel(root, "routing-wf", "architecture");
		expect(channelLines.some((line) => line.includes("@architect hello architecture"))).toBe(true);
	});

	it("applies review gate decisions in architecture_review", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const controller = createTestController();
		const notifications: string[] = [];
		const ctx = createRuntimeContext(root, notifications);

		await controller.run("start review-wf", ctx);
		await controller.run("next", ctx);
		await controller.run("approve", ctx);
		await controller.run("next", ctx);

		let state = await readState(root, "review-wf");
		expect(state.phase).toBe("architecture_review");

		const decisionFile = join(root, ".openplaybook", "review-wf", "artifacts", "architecture-review.json");
		await writeFile(
			decisionFile,
			`${JSON.stringify({ status: "rejected", blockingIssues: ["missing"], requiredFixes: ["add"] }, null, 2)}\n`,
			"utf8",
		);

		const rejected = await controller.run("next", ctx);
		expect(rejected.ok).toBe(false);
		state = await readState(root, "review-wf");
		expect(state.phase).toBe("architecture_review");
		expect(state.blockedBy?.source).toBe("review_gate");

		await writeFile(decisionFile, `${JSON.stringify({ status: "approved" }, null, 2)}\n`, "utf8");
		const approved = await controller.run("next", ctx);
		expect(approved.ok).toBe(true);
		state = await readState(root, "review-wf");
		expect(state.phase).toBe("architecture_approval");
		expect(state.awaitingUserApproval).toBe(true);
	});
});

describe("openplaybook M4-M7", () => {
	const createdDirs: string[] = [];
	const startedServers: OpenPlaybookServer[] = [];

	afterEach(async () => {
		for (const server of startedServers) {
			await server.stop();
		}
		startedServers.length = 0;
		for (const dir of createdDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		createdDirs.length = 0;
	});

	it("serves workflows and channel data for current project only", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "api-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const loaded = await loadWorkflowState(root, "api-wf");
		if (!loaded) throw new Error("missing state");
		await orchestrator.syncPhase(getWorkflowPaths(root, "api-wf"), loaded);

		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
		});
		startedServers.push(server);
		const started = await server.start(4717);

		const workflowsResponse = await fetch(`${started.url}/api/workflows`);
		expect(workflowsResponse.status).toBe(200);
		const workflowsPayload = (await workflowsResponse.json()) as {
			activeWorkflowId: string | null;
			workflows: Array<{ id: string; displayName: string; active: boolean }>;
		};
		expect(workflowsPayload.activeWorkflowId).toBe("api-wf");
		expect(workflowsPayload.workflows.some((item) => item.id === "api-wf" && item.active)).toBe(true);
		expect(workflowsPayload.workflows.find((item) => item.id === "api-wf")?.displayName).toBe("api-wf");

		const channelResponse = await fetch(`${started.url}/api/workflows/api-wf/channels/control?cursor=0&limit=10`);
		expect(channelResponse.status).toBe(200);
		const channelPayload = (await channelResponse.json()) as { items: unknown[]; total: number };
		expect(channelPayload.total).toBeGreaterThan(0);
		expect(channelPayload.items.length).toBeGreaterThan(0);

		const phaseContextResponse = await fetch(`${started.url}/api/workflows/api-wf/phase-context`);
		expect(phaseContextResponse.status).toBe(200);
		const phaseContext = (await phaseContextResponse.json()) as {
			phase: string;
			channel: string;
			allowedRoles: string[];
			roleStates: Record<string, { status: string }>;
			readonly: boolean;
		};
		expect(phaseContext.phase).toBe("requirements_discussion");
		expect(phaseContext.channel).toBe("requirements");
		expect(phaseContext.allowedRoles).toContain("product_manager");
		// Lazy startup: roles remain "not_started" until they receive a message.
		expect(phaseContext.roleStates.product_manager?.status).toBe("not_started");
		expect(phaseContext.readonly).toBe(false);
	});

	it("serves built Vue webui assets and shows a Chinese fallback when assets are missing", async () => {
		const root = await createProjectRoot();
		const webUiDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(webUiDir);
		await mkdir(join(webUiDir, "assets"), { recursive: true });
		await writeFile(join(webUiDir, "index.html"), '<div id="app">Vue OpenPlaybook</div>', "utf8");
		await writeFile(join(webUiDir, "assets", "index.js"), "console.log('openplaybook')", "utf8");

		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const server = new OpenPlaybookServer({ projectRoot: root, roleSessions: orchestrator, webUiDir });
		startedServers.push(server);
		const started = await server.start(4724);

		const indexResponse = await fetch(`${started.url}/`);
		expect(indexResponse.status).toBe(200);
		expect(await indexResponse.text()).toContain("Vue OpenPlaybook");
		const assetResponse = await fetch(`${started.url}/assets/index.js`);
		expect(assetResponse.status).toBe(200);
		expect(assetResponse.headers.get("content-type")).toContain("application/javascript");

		const missingServer = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
			webUiDir: join(webUiDir, "missing"),
		});
		startedServers.push(missingServer);
		const missingStarted = await missingServer.start(4725);
		const fallback = await fetch(`${missingStarted.url}/`);
		expect(fallback.status).toBe(200);
		expect(await fallback.text()).toContain("OpenPlaybook WebUI 尚未构建");
	});

	it("accepts @role messages and validates invalid payloads", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "message-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const loaded = await loadWorkflowState(root, "message-wf");
		if (!loaded) throw new Error("missing state");
		await orchestrator.syncPhase(getWorkflowPaths(root, "message-wf"), loaded);

		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
		});
		startedServers.push(server);
		const started = await server.start(4718);

		const bad = await fetch(`${started.url}/api/workflows/message-wf/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(bad.status).toBe(400);

		const ok = await fetch(`${started.url}/api/workflows/message-wf/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "@product_manager clarify acceptance criteria" }),
		});
		expect(ok.status).toBe(200);
	});

	it("creates checkpoint at approve gate and supports rollback preview", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "rollback-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		await nextWorkflow(root);
		await approveWorkflow(root);
		const paths = getWorkflowPaths(root, "rollback-wf");
		const files = await readdir(paths.checkpointsDir);
		expect(files.length).toBeGreaterThan(0);
		const checkpointName = files[0].replace(/\.json$/, "");

		const preview = await rollbackWorkflow(root, checkpointName, false);
		expect(preview.result.ok).toBe(true);
		expect(preview.plan?.checkpoint).toBe(checkpointName);
	});

	it("blocks revise action through API into blocked phase", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "revise-api-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const loaded = await loadWorkflowState(root, "revise-api-wf");
		if (!loaded) throw new Error("missing state");
		await orchestrator.syncPhase(getWorkflowPaths(root, "revise-api-wf"), loaded);

		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
		});
		startedServers.push(server);
		const started = await server.start(4720);

		const response = await fetch(`${started.url}/api/workflows/revise-api-wf/actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "revise", reason: "need product decision" }),
		});
		expect(response.status).toBe(200);

		const stateRaw = await readFile(join(root, ".openplaybook", "revise-api-wf", "state.json"), "utf8");
		const state = JSON.parse(stateRaw) as { phase: string; blockedBy?: { source: string } };
		expect(state.phase).toBe("blocked");
		expect(state.blockedBy?.source).toBe("user_revise");
	});

	it("initializes real runtime preset as the only built-in preset", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);

		const library = await loadRuntimePresetLibrary(agentDir);
		expect(library.defaultPresetId).toBe("real-default");
		expect(library.presets.some((preset) => preset.id === "real-default")).toBe(true);
		expect(library.presets.some((preset) => preset.id === "mock-default")).toBe(false);

		const result = await startWorkflow(root, "default-real-wf", { agentDir, runtimeModels: TEST_RUNTIME_MODELS });
		expect(result.ok).toBe(true);
		const config = await readJson<{
			mode: string;
			defaultModel: string | null;
			roles: Record<string, { model: string }>;
		}>(join(root, ".openplaybook", "default-real-wf", "roles", "runtime-config.json"));
		expect(config.mode).toBe("real");
		expect(config.defaultModel).toBe("openai/gpt-5.4");
		expect(config.roles.orchestrator?.model).toBe("google/gemini-3.1-pro-preview");
		expect(config.roles.backend_developer?.model).toBe("openai/gpt-5.4");
	});

	it("rejects user-visible mock runtime presets", async () => {
		const agentDir = await createProjectRoot();
		createdDirs.push(agentDir);

		const result = await createOrUpdateRuntimePreset(agentDir, {
			id: "mock-runtime",
			name: "Mock Runtime",
			config: {
				mode: "mock",
				defaultModel: null,
				roles: {},
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("real");
	});

	it("adapts unavailable runtime models to currently available models", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "partially-unavailable",
			name: "Partially Unavailable",
			config: {
				mode: "real",
				defaultModel: "deepseek/deepseek-v4-pro",
				roles: {
					product_manager: { model: "anthropic/claude-sonnet-4-6" },
					architect: { model: "anthropic/claude-opus-4-7" },
					backend_developer: { model: "openai/gpt-5.3-codex" },
				},
			},
		});

		const result = await startWorkflow(root, "adapted-wf", {
			agentDir,
			runtimePresetId: "partially-unavailable",
			runtimeModels: TEST_RUNTIME_MODELS.slice(0, 2),
		});
		expect(result.ok).toBe(true);
		const config = await readJson<{
			defaultModel: string | null;
			roles: Record<string, { model: string }>;
		}>(join(root, ".openplaybook", "adapted-wf", "roles", "runtime-config.json"));
		expect(config.defaultModel).toBe("openai/gpt-5.4");
		expect(config.roles.product_manager?.model).toBe("google/gemini-3.1-pro-preview");
		expect(config.roles.architect?.model).toBe("openai/gpt-5.4");
		expect(config.roles.backend_developer?.model).toBe("openai/gpt-5.4");
	});

	it("refuses workflow start when no runtime models are available", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);

		const result = await startWorkflow(root, "no-models-wf", { agentDir, runtimeModels: [] });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("/login");
	});

	it("uses the selected pi agent directory for real role runtime auth and model services", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "global-auth-runtime",
			name: "Global Auth Runtime",
			config: {
				mode: "real",
				defaultModel: "openai/gpt-5.4",
				roles: {
					product_manager: { model: "openai/gpt-5.4" },
				},
			},
		});
		const start = await startWorkflow(root, "global-auth-wf", {
			agentDir,
			runtimePresetId: "global-auth-runtime",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		expect(start.ok).toBe(true);

		const captured = {
			authPath: "",
			runtimeAgentDir: "",
			servicesAgentDir: "",
		};
		const fakeSession = {
			sessionFile: "fake-session",
			async bindExtensions(_options: object): Promise<void> {},
			subscribe(_listener: (event: { type: string }) => void): () => void {
				return () => {};
			},
			async sendUserMessage(_content: string, _options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {},
		};
		const runtimeModule = {
			AuthStorage: {
				create(path?: string): unknown {
					captured.authPath = path ?? "";
					return { path };
				},
			},
			SessionManager: {
				create(cwd: string, sessionDir?: string): unknown {
					return { cwd, sessionDir };
				},
			},
			async createAgentSessionServices(options: { cwd: string; agentDir?: string; authStorage?: unknown }) {
				captured.servicesAgentDir = options.agentDir ?? "";
				return {
					diagnostics: [],
					modelRegistry: {
						find(provider: string, modelId: string) {
							return { provider, id: modelId };
						},
						getAvailable() {
							return [{ provider: "openai", id: "gpt-5.4" }];
						},
					},
				};
			},
			async createAgentSessionFromServices() {
				return { session: fakeSession };
			},
			async createAgentSessionRuntime(createRuntime, options) {
				captured.runtimeAgentDir = options.agentDir;
				const created = await createRuntime(options);
				return {
					session: created.session,
					async dispose(): Promise<void> {},
				};
			},
		} satisfies RoleSessionRuntimeModule;

		const orchestrator = new RoleSessionOrchestrator({ agentDir, runtimeModule });
		const state = await loadWorkflowState(root, "global-auth-wf");
		if (!state) throw new Error("missing state");
		const authPaths = getWorkflowPaths(root, "global-auth-wf");
		await orchestrator.syncPhase(authPaths, state);
		await orchestrator.ensureRoleRunning(authPaths, "product_manager", state);

		expect(captured.authPath).toBe(join(agentDir, "auth.json"));
		expect(captured.runtimeAgentDir).toBe(agentDir);
		expect(captured.servicesAgentDir).toBe(agentDir);
	});

	it("writes assistant final replies to transcript and current phase channel without noisy message_update entries", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		const start = await startWorkflow(root, "assistant-reply-wf", {
			agentDir,
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		expect(start.ok).toBe(true);

		let runtimeListener: ((event: { type: string; message?: unknown; toolName?: string }) => void) | undefined;
		const fakeSession = {
			sessionFile: "assistant-reply-session",
			async bindExtensions(_options: object): Promise<void> {},
			subscribe(listener: (event: { type: string; message?: unknown; toolName?: string }) => void): () => void {
				runtimeListener = listener;
				return () => {
					runtimeListener = undefined;
				};
			},
			async sendUserMessage(content: string, _options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {
				if (content.includes("你好")) {
					runtimeListener?.({
						type: "message_update",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "正在思考" }],
						},
					});
					runtimeListener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "你好，我是产品经理，已收到你的消息。" }],
						},
					});
				}
			},
		};
		const runtimeModule = {
			AuthStorage: {
				create(path?: string): unknown {
					return { path };
				},
			},
			SessionManager: {
				create(cwd: string, sessionDir?: string): unknown {
					return { cwd, sessionDir };
				},
			},
			async createAgentSessionServices() {
				return {
					diagnostics: [],
					modelRegistry: {
						find(provider: string, modelId: string) {
							return { provider, id: modelId };
						},
						getAvailable() {
							return [{ provider: "openai", id: "gpt-5.4" }];
						},
					},
				};
			},
			async createAgentSessionFromServices() {
				return { session: fakeSession };
			},
			async createAgentSessionRuntime(createRuntime, options) {
				const created = await createRuntime(options);
				return {
					session: created.session,
					async dispose(): Promise<void> {},
				};
			},
		} satisfies RoleSessionRuntimeModule;

		const orchestrator = new RoleSessionOrchestrator({ agentDir, runtimeModule });
		const state = await loadWorkflowState(root, "assistant-reply-wf");
		if (!state) throw new Error("missing state");
		const paths = getWorkflowPaths(root, "assistant-reply-wf");
		await orchestrator.syncPhase(paths, state);
		await orchestrator.deliverUserMessage(paths, state, "product_manager", "你好");

		const details = await orchestrator.readRoleDetails(paths, "product_manager");
		expect(details.transcript.some((event) => event.summary.includes("你好，我是产品经理"))).toBe(true);
		expect(details.transcript.some((event) => event.summary === "message_update")).toBe(false);

		const requirementChannelRaw = await readFile(
			join(root, ".openplaybook", "assistant-reply-wf", "channels", "requirements.jsonl"),
			"utf8",
		);
		const requirementChannel = requirementChannelRaw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { from: string; text: string });
		expect(requirementChannel.some((message) => message.from === "product_manager")).toBe(true);
		expect(requirementChannel.some((message) => message.text.includes("已收到你的消息"))).toBe(true);
	});

	it("serializes concurrent jsonl appends on the same file", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const target = join(root, "concurrent-events.jsonl");

		await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				appendJsonlAtomic(target, {
					index,
					message: `event-${index}`,
				}),
			),
		);

		const events = await readJsonlFile<Array<{ index: number; message: string }>[number]>(target);
		expect(events).toHaveLength(24);
		expect(new Set(events.map((event) => event.index))).toEqual(
			new Set(Array.from({ length: 24 }, (_, index) => index)),
		);
	});

	it("creates global runtime presets and snapshots the selected preset on workflow start", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "quality",
			name: "Quality",
			config: {
				mode: "real",
				defaultModel: "openai/gpt-5.4",
				roles: {
					architect: { model: "anthropic/claude-opus-4-7", thinkingLevel: "high" },
				},
			},
		});
		await setDefaultRuntimePreset(agentDir, "quality");

		const result = await startWorkflow(root, "runtime-wf", { agentDir, runtimeModels: TEST_RUNTIME_MODELS });
		expect(result.ok).toBe(true);

		const config = await readJson<{
			mode: string;
			defaultModel: string | null;
			roles: Record<string, { model: string; thinkingLevel?: string }>;
		}>(join(root, ".openplaybook", "runtime-wf", "roles", "runtime-config.json"));
		expect(config.mode).toBe("real");
		expect(config.defaultModel).toBe("openai/gpt-5.4");
		expect(config.roles.architect?.model).toBe("anthropic/claude-opus-4-7");

		const snapshot = await readJson<{ presetId: string; name: string; configHash: string }>(
			join(root, ".openplaybook", "runtime-wf", "roles", "runtime-preset.json"),
		);
		expect(snapshot.presetId).toBe("quality");
		expect(snapshot.name).toBe("Quality");
		expect(snapshot.configHash.length).toBeGreaterThan(0);
	});

	it("stores workflow display names and falls back to id for older workflow state", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);

		const result = await startWorkflow(root, "named-wf", {
			agentDir,
			displayName: "需求协作工作流",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		expect(result.ok).toBe(true);

		const state = await readJson<{ workflow: string; displayName: string }>(
			join(root, ".openplaybook", "named-wf", "state.json"),
		);
		expect(state.workflow).toBe("named-wf");
		expect(state.displayName).toBe("需求协作工作流");

		const legacyDir = join(root, ".openplaybook", "legacy-wf");
		await mkdir(legacyDir, { recursive: true });
		await writeFile(
			join(legacyDir, "state.json"),
			JSON.stringify({
				workflow: "legacy-wf",
				status: "closed",
				phase: "done",
				round: 1,
				currentMilestone: null,
				currentTask: null,
				awaitingUserApproval: false,
				blockedBy: null,
				roles: {},
				milestones: [],
			}),
			"utf8",
		);

		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
		});
		startedServers.push(server);
		const started = await server.start(4726);
		const workflowsResponse = await fetch(`${started.url}/api/workflows`);
		expect(workflowsResponse.status).toBe(200);
		const workflowsPayload = (await workflowsResponse.json()) as {
			workflows: Array<{ id: string; displayName: string }>;
		};
		expect(workflowsPayload.workflows.find((item) => item.id === "named-wf")?.displayName).toBe("需求协作工作流");
		expect(workflowsPayload.workflows.find((item) => item.id === "legacy-wf")?.displayName).toBe("legacy-wf");
	});

	it("keeps running workflow runtime snapshots unchanged after global preset edits", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "stable",
			name: "Stable",
			config: {
				mode: "real",
				defaultModel: null,
				roles: {
					architect: { model: "openai/gpt-5.4" },
				},
			},
		});
		await startWorkflow(root, "snapshot-wf", {
			agentDir,
			runtimePresetId: "stable",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		await createOrUpdateRuntimePreset(agentDir, {
			id: "stable",
			name: "Stable Updated",
			config: {
				mode: "real",
				defaultModel: null,
				roles: {
					architect: { model: "google/gemini-3.1-pro-preview" },
				},
			},
		});

		const config = await readJson<{ roles: Record<string, { model: string }> }>(
			join(root, ".openplaybook", "snapshot-wf", "roles", "runtime-config.json"),
		);
		expect(config.roles.architect?.model).toBe("openai/gpt-5.4");
	});

	it("rejects invalid preset mutations", async () => {
		const agentDir = await createProjectRoot();
		createdDirs.push(agentDir);
		const invalid = await createOrUpdateRuntimePreset(agentDir, {
			id: "bad id",
			name: "Bad",
			config: { mode: "real", defaultModel: "openai/gpt-5.4", roles: {} },
		});
		expect(invalid.ok).toBe(false);
		const missingDefault = await setDefaultRuntimePreset(agentDir, "missing");
		expect(missingDefault.ok).toBe(false);
		const deleteDefault = await deleteRuntimePreset(agentDir, "real-default");
		expect(deleteDefault.ok).toBe(false);
	});

	it("serves runtime preset CRUD and creates workflows from the selected preset", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
			agentDir,
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		startedServers.push(server);
		const started = await server.start(4721);

		const createPreset = await fetch(`${started.url}/api/runtime-presets`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "fast",
				name: "Fast",
				config: {
					mode: "real",
					defaultModel: "google/gemini-3.1-pro-preview",
					roles: {
						frontend_developer: { model: "google/gemini-3.1-pro-preview" },
					},
				},
			}),
		});
		expect(createPreset.status).toBe(200);

		const setDefault = await fetch(`${started.url}/api/runtime-presets/default`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ presetId: "fast" }),
		});
		expect(setDefault.status).toBe(200);

		const createWorkflow = await fetch(`${started.url}/api/workflows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "api-start-wf", displayName: "接口启动工作流" }),
		});
		expect(createWorkflow.status).toBe(200);

		const config = await readJson<{ defaultModel: string | null }>(
			join(root, ".openplaybook", "api-start-wf", "roles", "runtime-config.json"),
		);
		expect(config.defaultModel).toBe("google/gemini-3.1-pro-preview");
		const state = await readJson<{ displayName: string }>(join(root, ".openplaybook", "api-start-wf", "state.json"));
		expect(state.displayName).toBe("接口启动工作流");

		const presets = await fetch(`${started.url}/api/runtime-presets`);
		expect(presets.status).toBe(200);
		const payload = (await presets.json()) as Awaited<ReturnType<typeof loadRuntimePresetLibrary>>;
		expect(payload.defaultPresetId).toBe("fast");
		expect(payload.presets.some((preset) => preset.id === "fast")).toBe(true);

		const models = await fetch(`${started.url}/api/runtime-models`);
		expect(models.status).toBe(200);
		const modelPayload = (await models.json()) as {
			models: RuntimeModelOption[];
			recommendations: Record<string, string>;
		};
		expect(modelPayload.models.map((model) => model.ref)).toEqual(TEST_RUNTIME_MODELS.map((model) => model.ref));
		expect(modelPayload.recommendations.frontend_developer).toBe("google/gemini-3.1-pro-preview");
	});

	it("refuses runtime hot mutation commands for active workflows", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "runtime-command-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const controller = new OpenPlaybookController();
		const result = await controller.run("runtime model architect openai/gpt-4.1", {
			cwd: root,
			hasUI: false,
			notify() {},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("preset");
	});

	it("creates capability presets and snapshots the selected preset on workflow start", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "vue-java",
			name: "Vue Java",
			config: {
				roles: {
					frontend_developer: {
						persona: "Vue frontend developer",
						responsibilities: ["Implement Vue UI"],
						phasePrompts: { development: "Use Vue 3 Composition API." },
						skills: ["vue-best-practices", "vue-testing-best-practices"],
						toolPolicy: { include: ["shell", "apply_patch"], exclude: [] },
						outputContract: "Write concise implementation notes and refs.",
					},
					backend_developer: {
						persona: "Spring Boot backend developer",
						responsibilities: ["Implement Java APIs"],
						phasePrompts: { development: "Use Spring Boot layered services." },
						skills: ["springboot-patterns", "springboot-tdd"],
						toolPolicy: { include: ["shell", "apply_patch"], exclude: [] },
						outputContract: "Write concise implementation notes and refs.",
					},
				},
			},
		});
		await setDefaultCapabilityPreset(agentDir, "vue-java");

		const result = await startWorkflow(root, "capability-wf", { agentDir, runtimeModels: TEST_RUNTIME_MODELS });
		expect(result.ok).toBe(true);
		const config = await readJson<{ roles: Record<string, { persona: string; skills: string[] }> }>(
			join(root, ".openplaybook", "capability-wf", "roles", "capability-config.json"),
		);
		expect(config.roles.frontend_developer?.persona).toBe("Vue frontend developer");
		expect(config.roles.frontend_developer?.skills).toContain("vue-best-practices");
		const snapshot = await readJson<{ presetId: string; name: string; configHash: string }>(
			join(root, ".openplaybook", "capability-wf", "roles", "capability-preset.json"),
		);
		expect(snapshot.presetId).toBe("vue-java");
		expect(snapshot.name).toBe("Vue Java");
		expect(snapshot.configHash.length).toBeGreaterThan(0);
	});

	it("keeps running workflow capability snapshots unchanged after global preset edits", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "stable-capability",
			name: "Stable Capability",
			config: {
				roles: {
					architect: {
						persona: "Original architect",
						responsibilities: ["Design architecture"],
						phasePrompts: { architecture_design: "Create the architecture." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						outputContract: "Reference architecture files.",
					},
				},
			},
		});
		await startWorkflow(root, "capability-snapshot-wf", {
			agentDir,
			capabilityPresetId: "stable-capability",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "stable-capability",
			name: "Stable Capability Updated",
			config: {
				roles: {
					architect: {
						persona: "Updated architect",
						responsibilities: ["Design architecture"],
						phasePrompts: { architecture_design: "Create the architecture." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						outputContract: "Reference architecture files.",
					},
				},
			},
		});
		const config = await readJson<{ roles: Record<string, { persona: string }> }>(
			join(root, ".openplaybook", "capability-snapshot-wf", "roles", "capability-config.json"),
		);
		expect(config.roles.architect?.persona).toBe("Original architect");
	});

	it("rejects invalid capability preset mutations", async () => {
		const agentDir = await createProjectRoot();
		createdDirs.push(agentDir);
		const invalid = await createOrUpdateCapabilityPreset(agentDir, {
			id: "bad id",
			name: "Bad",
			config: { roles: {} },
		});
		expect(invalid.ok).toBe(false);
		const missingDefault = await setDefaultCapabilityPreset(agentDir, "missing");
		expect(missingDefault.ok).toBe(false);
		const deleteDefault = await deleteCapabilityPreset(agentDir, "default-web-app");
		expect(deleteDefault.ok).toBe(false);
	});

	it("rejects removed compatibility inputs for presets and artifacts", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);

		const oldArtifactFormat = await createOrUpdateCapabilityPreset(agentDir, {
			id: "old-artifact-format",
			name: "Old Artifact Format",
			config: {
				roles: {
					product_manager: {
						persona: "Old artifact format",
						responsibilities: ["Clarify requirements"],
						phasePrompts: { requirements_discussion: "Invalid old artifact format." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						requiredArtifacts: ["artifacts/requirements/{workflow}.md"] as never,
						outputContract: "Write refs.",
					},
				},
			},
		});
		expect(oldArtifactFormat.ok).toBe(false);
		expect(oldArtifactFormat.message).toContain("requiredArtifacts must be artifact objects");

		const controller = new OpenPlaybookController();
		const commandResult = await controller.run("start old-preset --preset missing", {
			cwd: root,
			hasUI: false,
			notify() {},
		});
		expect(commandResult.ok).toBe(false);
		expect(commandResult.message).toContain("--runtime-preset");

		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: new RoleSessionOrchestrator({ forceMockRuntime: true }),
			runtimeModels: TEST_RUNTIME_MODELS,
			agentDir,
		});
		startedServers.push(server);
		const started = await server.start(4724);
		const response = await fetch(`${started.url}/api/workflows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "old-api-preset", presetId: "missing" }),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("runtimePresetId");
	});

	it("serves capability preset CRUD and starts workflows with selected capability preset", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
			agentDir,
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		startedServers.push(server);
		const started = await server.start(4722);

		const createPreset = await fetch(`${started.url}/api/capability-presets`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "react-java",
				name: "React Java",
				config: {
					roles: {
						frontend_developer: {
							persona: "React frontend developer",
							responsibilities: ["Implement React UI"],
							phasePrompts: { development: "Use React components." },
							skills: ["ui-ux-pro-max"],
							toolPolicy: { include: ["shell"], exclude: [] },
							outputContract: "Reference changed files.",
						},
					},
				},
			}),
		});
		expect(createPreset.status).toBe(200);

		const createWorkflow = await fetch(`${started.url}/api/workflows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "capability-api-wf", capabilityPresetId: "react-java" }),
		});
		expect(createWorkflow.status).toBe(200);
		const config = await readJson<{ roles: Record<string, { persona: string }> }>(
			join(root, ".openplaybook", "capability-api-wf", "roles", "capability-config.json"),
		);
		expect(config.roles.frontend_developer?.persona).toBe("React frontend developer");

		const presets = await fetch(`${started.url}/api/capability-presets`);
		expect(presets.status).toBe(200);
		const payload = (await presets.json()) as Awaited<ReturnType<typeof loadCapabilityPresetLibrary>>;
		expect(payload.presets.some((preset) => preset.id === "react-java")).toBe(true);
		const snapshot = await fetch(`${started.url}/api/workflows/capability-api-wf/capability-preset`);
		expect(snapshot.status).toBe(200);
	});

	it("writes capability bootstrap prompt to role transcript and merges configured tools", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "tool-runtime",
			name: "Tool Runtime",
			config: {
				mode: "real",
				defaultModel: "openai/gpt-5.4",
				roles: {
					product_manager: { model: "openai/gpt-5.4" },
				},
			},
		});
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "pm-capability",
			name: "PM Capability",
			config: {
				roles: {
					product_manager: {
						persona: "Product manager for requirements discovery",
						responsibilities: ["Clarify requirements"],
						phasePrompts: { requirements_discussion: "Ask concise product questions." },
						skills: ["brainstorming"],
						toolPolicy: { include: ["capability-tool"], exclude: [] },
						requiredArtifacts: [
							{
								path: "artifacts/requirements/{workflow}-{phase}-{role}.md",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Requirements discussion notes.",
							},
						],
						outputContract: "Write short notes and file refs only.",
					},
				},
			},
		});
		await startWorkflow(root, "bootstrap-wf", {
			agentDir,
			runtimePresetId: "tool-runtime",
			capabilityPresetId: "pm-capability",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "bootstrap-wf");
		if (!state) throw new Error("missing state");
		const bootstrapPaths = getWorkflowPaths(root, "bootstrap-wf");
		await orchestrator.syncPhase(bootstrapPaths, state);
		await orchestrator.ensureRoleRunning(bootstrapPaths, "product_manager", state);
		const transcript = await readFile(
			join(root, ".openplaybook", "bootstrap-wf", "sessions", "product_manager", "transcript.jsonl"),
			"utf8",
		);
		expect(transcript).toContain("Product manager for requirements discovery");
		expect(transcript).toContain("Ask concise product questions.");
		expect(transcript).toContain("brainstorming");
		expect(transcript).toContain("capability-tool");
		expect(transcript).toContain("artifacts/requirements/bootstrap-wf-requirements_discussion-product_manager.md");
	});

	it("applies structured tool policies with definitions and excludes before runtime startup", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateRuntimePreset(agentDir, {
			id: "tool-policy-runtime",
			name: "Tool Policy Runtime",
			config: {
				mode: "real",
				defaultModel: "openai/gpt-5.4",
				roles: {
					product_manager: {
						model: "openai/gpt-5.4",
					},
				},
			},
		});
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "tool-policy-capability",
			name: "Tool Policy Capability",
			config: {
				toolDefinitions: {
					read: {
						description: "Read project files for requirement context.",
						category: "filesystem",
						riskLevel: "low",
						usage: "Use before asking questions that depend on existing docs.",
					},
					bash: {
						description: "Run focused inspection commands.",
						category: "shell",
						riskLevel: "medium",
						usage: "Use only for read-only checks in this role.",
					},
					mcp_search_files: {
						description: "Search indexed project context.",
						category: "mcp",
						riskLevel: "low",
						usage: "Prefer for broad search before shell commands.",
					},
				},
				roles: {
					product_manager: {
						persona: "Product manager with structured tool policy",
						responsibilities: ["Clarify requirements"],
						phasePrompts: { requirements_discussion: "Use allowed tools conservatively." },
						skills: ["brainstorming"],
						toolPolicy: {
							include: ["read", "bash", "mcp_*"],
							exclude: ["bash", "mcp_delete_file"],
						},
						outputContract: "Write short notes and file refs only.",
					},
				},
			},
		});

		await startWorkflow(root, "tool-policy-wf", {
			agentDir,
			runtimePresetId: "tool-policy-runtime",
			capabilityPresetId: "tool-policy-capability",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "tool-policy-wf");
		if (!state) throw new Error("missing state");
		const paths = getWorkflowPaths(root, "tool-policy-wf");
		await orchestrator.syncPhase(paths, state);
		await orchestrator.ensureRoleRunning(paths, "product_manager", state);

		const bootstrap = await readJson<{
			prompt: string;
		}>(join(paths.sessionsDir, "product_manager", "bootstrap-context.json"));
		expect(bootstrap.prompt).toContain("Tool Use Contract");
		expect(bootstrap.prompt).toContain("read: Read project files for requirement context.");
		expect(bootstrap.prompt).toContain("mcp_search_files: Search indexed project context.");
		expect(bootstrap.prompt).toContain("Denied tools: bash, mcp_delete_file");
		expect(bootstrap.prompt).not.toContain("mcp_delete_file: ");
		expect(bootstrap.prompt).not.toContain("- bash");
	});

	it("rejects broad wildcard and invalid structured tool policy entries", async () => {
		const agentDir = await createProjectRoot();
		createdDirs.push(agentDir);
		const broadWildcard = await createOrUpdateCapabilityPreset(agentDir, {
			id: "bad-tool-policy",
			name: "Bad Tool Policy",
			config: {
				roles: {
					product_manager: {
						persona: "Invalid tool policy",
						responsibilities: ["Clarify requirements"],
						phasePrompts: { requirements_discussion: "Invalid." },
						skills: [],
						toolPolicy: { include: ["*"], exclude: [] },
						outputContract: "Write refs.",
					},
				},
			},
		});
		expect(broadWildcard.ok).toBe(false);
		expect(broadWildcard.message).toContain("full wildcard");

		const invalidDefinition = await createOrUpdateCapabilityPreset(agentDir, {
			id: "bad-tool-definition",
			name: "Bad Tool Definition",
			config: {
				toolDefinitions: {
					read: {
						description: "Read files.",
						category: "filesystem",
						riskLevel: "catastrophic" as "low",
						usage: "Read files.",
					},
				},
				roles: {
					product_manager: {
						persona: "Invalid tool definition",
						responsibilities: ["Clarify requirements"],
						phasePrompts: { requirements_discussion: "Invalid." },
						skills: [],
						toolPolicy: { include: ["read"], exclude: [] },
						outputContract: "Write refs.",
					},
				},
			},
		});
		expect(invalidDefinition.ok).toBe(false);
		expect(invalidDefinition.message).toContain("riskLevel");
	});

	it("blocks phase progress until required role artifacts exist and validates JSON artifacts", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "artifact-gate",
			name: "Artifact Gate",
			config: {
				roles: {
					product_manager: {
						persona: "Product manager with required outputs",
						responsibilities: ["Write fixed outputs"],
						phasePrompts: { requirements_discussion: "Produce required artifacts." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						requiredArtifacts: [
							{
								path: "artifacts/requirements/{workflow}-requirements.md",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Requirements notes.",
							},
							{
								path: "artifacts/requirements/{workflow}-decision.json",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Requirements decision data.",
								schema: { required: ["approved"] },
							},
						],
						outputContract: "Write required artifacts before completion.",
					},
				},
			},
		});
		await startWorkflow(root, "artifact-gate-wf", {
			agentDir,
			capabilityPresetId: "artifact-gate",
			runtimeModels: TEST_RUNTIME_MODELS,
		});

		let next = await nextWorkflow(root);
		expect(next.ok).toBe(false);
		expect(next.message).toContain("Missing required artifacts");

		const artifactDir = join(root, ".openplaybook", "artifact-gate-wf", "artifacts", "requirements");
		await mkdir(artifactDir, { recursive: true });
		await writeFile(join(artifactDir, "artifact-gate-wf-requirements.md"), "requirements", "utf8");
		await writeFile(join(artifactDir, "artifact-gate-wf-decision.json"), "{", "utf8");

		next = await nextWorkflow(root);
		expect(next.ok).toBe(false);
		expect(next.message).toContain("Invalid required artifacts");

		await writeFile(join(artifactDir, "artifact-gate-wf-decision.json"), '{"approved":true}', "utf8");
		next = await nextWorkflow(root);
		expect(next.ok).toBe(false);
		expect(next.message).toContain("Missing role completion");

		await writeFile(
			join(root, ".openplaybook", "artifact-gate-wf", "sessions", "product_manager", "completion.json"),
			JSON.stringify({
				status: "done",
				phase: "requirements_discussion",
				artifacts: [
					"artifacts/requirements/artifact-gate-wf-requirements.md",
					"artifacts/requirements/artifact-gate-wf-decision.json",
				],
				needsUserDecision: false,
				summary: "Requirements artifacts are ready.",
				refs: [
					"artifacts/requirements/artifact-gate-wf-requirements.md",
					"artifacts/requirements/artifact-gate-wf-decision.json",
				],
			}),
			"utf8",
		);
		next = await nextWorkflow(root);
		expect(next.ok).toBe(true);
		expect(next.message).toContain("requirements_approval");
	});

	it("initializes workflow memory files and searches memory by role, phase, and scope", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "memory-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const paths = getWorkflowPaths(root, "memory-wf");

		for (const file of [
			"decisions.jsonl",
			"user-preferences.jsonl",
			"architecture-facts.jsonl",
			"implementation-notes.jsonl",
			"role-lessons.jsonl",
		]) {
			await expect(readFile(join(paths.memoryDir, file), "utf8")).resolves.toBe("");
		}

		await appendWorkflowMemory(paths, {
			scope: "decisions",
			phase: "requirements_discussion",
			role: "product_manager",
			type: "decision",
			text: "Users must approve each milestone before development continues.",
			refs: ["summaries/requirements_discussion.md"],
			tags: ["approval"],
			importance: 9,
		});
		await appendWorkflowMemory(paths, {
			scope: "architecture-facts",
			phase: "architecture_design",
			role: "architect",
			type: "fact",
			text: "The workflow stores all collaboration state under .openplaybook/<workflow>/.",
			refs: ["artifacts/architecture/design.md"],
			tags: ["storage"],
			importance: 7,
		});

		const pmMemory = await searchWorkflowMemory(paths, {
			role: "product_manager",
			phase: "requirements_discussion",
			scopes: ["decisions"],
		});
		expect(pmMemory).toHaveLength(1);
		expect(pmMemory[0].text).toContain("approve each milestone");

		const architectureMemory = await searchWorkflowMemory(paths, {
			role: "product_manager",
			phase: "requirements_discussion",
			scopes: ["architecture-facts"],
		});
		expect(architectureMemory).toHaveLength(0);
	});

	it("builds bootstrap context from summary and memory while preserving required artifacts under budget", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "memory-capability",
			name: "Memory Capability",
			config: {
				roles: {
					product_manager: {
						persona: "Product manager with a tight context budget",
						responsibilities: ["Keep memory concise"],
						phasePrompts: { requirements_discussion: "Use relevant memory, not full transcripts." },
						skills: ["brainstorming"],
						toolPolicy: { include: ["shell"], exclude: [] },
						requiredArtifacts: [
							{
								path: "artifacts/requirements/{workflow}-requirements.md",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Requirements notes.",
							},
						],
						outputContract: "Write short refs.",
						contextPolicy: {
							maxBootstrapTokens: 170,
							maxRecentMessages: 2,
							includeArtifacts: "refs_only",
							memoryScopes: ["decisions", "user-preferences"],
						},
					},
				},
			},
		});
		await startWorkflow(root, "context-wf", {
			agentDir,
			capabilityPresetId: "memory-capability",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		const paths = getWorkflowPaths(root, "context-wf");
		await appendWorkflowMemory(paths, {
			scope: "decisions",
			phase: "requirements_discussion",
			role: "product_manager",
			type: "decision",
			text: "Keep this relevant memory because it explains the user gate.",
			refs: ["summaries/requirements_discussion.md"],
			tags: ["gate"],
			importance: 10,
		});
		await appendWorkflowMemory(paths, {
			scope: "implementation-notes",
			phase: "development",
			role: "backend_developer",
			type: "note",
			text: "This unrelated backend memory should not enter the product manager prompt.",
			refs: [],
			tags: ["backend"],
			importance: 4,
		});
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "context-wf");
		if (!state) throw new Error("missing state");
		await orchestrator.syncPhase(paths, state);
		await orchestrator.ensureRoleRunning(paths, "product_manager", state);

		const bootstrapContext = await readJson<{
			prompt: string;
			estimatedTokens: number;
			trimmedSections: string[];
			sections: Array<{ name: string; included: boolean }>;
		}>(join(paths.sessionsDir, "product_manager", "bootstrap-context.json"));
		expect(bootstrapContext.estimatedTokens).toBeLessThanOrEqual(170);
		expect(bootstrapContext.prompt).toContain("artifacts/requirements/context-wf-requirements.md");
		expect(bootstrapContext.prompt).toContain("Keep this relevant memory");
		expect(bootstrapContext.prompt).not.toContain("unrelated backend memory");
		expect(bootstrapContext.trimmedSections).toContain("recentTranscript");

		const summary = await readJson<{ currentTask: string; nextSteps: string[] }>(
			join(paths.sessionsDir, "product_manager", "summary.json"),
		);
		expect(summary.currentTask).toContain("requirements_discussion");
		expect(summary.nextSteps[0]).toContain("requirements_discussion");
	});

	it("serves workflow memory and role summaries through the local API", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "memory-api-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const paths = getWorkflowPaths(root, "memory-api-wf");
		await appendWorkflowMemory(paths, {
			scope: "user-preferences",
			phase: "requirements_discussion",
			role: "product_manager",
			type: "preference",
			text: "User prefers short role handoff messages.",
			refs: [],
			tags: ["handoff"],
			importance: 8,
		});
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "memory-api-wf");
		if (!state) throw new Error("missing state");
		await orchestrator.syncPhase(paths, state);

		const server = new OpenPlaybookServer({
			projectRoot: root,
			roleSessions: orchestrator,
		});
		startedServers.push(server);
		const started = await server.start(4717);

		const memoryResponse = await fetch(`${started.url}/api/workflows/memory-api-wf/memory?scope=user-preferences`);
		expect(memoryResponse.status).toBe(200);
		const memoryPayload = (await memoryResponse.json()) as { items: Array<{ text: string }> };
		expect(memoryPayload.items[0].text).toContain("short role handoff");

		const postResponse = await fetch(`${started.url}/api/workflows/memory-api-wf/memory`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: "decisions",
				role: "product_manager",
				phase: "requirements_discussion",
				type: "decision",
				text: "API can append audited memory entries.",
				refs: ["channels/requirements.jsonl"],
				tags: ["api"],
				importance: 6,
			}),
		});
		expect(postResponse.status).toBe(200);

		const summaryResponse = await fetch(`${started.url}/api/workflows/memory-api-wf/roles/product_manager/summary`);
		expect(summaryResponse.status).toBe(200);
		const summaryPayload = (await summaryResponse.json()) as { currentTask: string; nextSteps: string[] };
		expect(summaryPayload.currentTask).toContain("requirements_discussion");
		expect(summaryPayload.nextSteps[0]).toContain("requirements_discussion");
	});

	it("gates structured artifacts with manifest, template, schema, and role completion", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "structured-artifacts",
			name: "Structured Artifacts",
			config: {
				roles: {
					product_manager: {
						persona: "Product manager with structured artifact contract",
						responsibilities: ["Write structured requirements"],
						phasePrompts: { requirements_discussion: "Produce the structured requirements artifact." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						requiredArtifacts: [
							{
								path: "artifacts/requirements/{workflow}-requirements.json",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Structured requirements summary.",
								schema: { required: ["summary"] },
								template: '{\n  "summary": ""\n}\n',
							},
						],
						outputContract: "Write completion after artifact is ready.",
					},
				},
			},
		});
		await startWorkflow(root, "structured-wf", {
			agentDir,
			capabilityPresetId: "structured-artifacts",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		const paths = getWorkflowPaths(root, "structured-wf");

		const artifactPath = join(paths.workflowDir, "artifacts", "requirements", "structured-wf-requirements.json");
		await expect(readFile(artifactPath, "utf8")).resolves.toContain('"summary"');
		const initialManifest = await readJson<{ items: Array<{ path: string; status: string; description: string }> }>(
			join(paths.artifactsDir, "manifest.json"),
		);
		expect(initialManifest.items[0]).toMatchObject({
			path: "artifacts/requirements/structured-wf-requirements.json",
			status: "missing",
			description: "Structured requirements summary.",
		});

		await writeFile(artifactPath, "{}", "utf8");
		let next = await nextWorkflow(root);
		expect(next.ok).toBe(false);
		expect(next.message).toContain("missing required key 'summary'");

		await writeFile(artifactPath, '{"summary":"Ready"}', "utf8");
		next = await nextWorkflow(root);
		expect(next.ok).toBe(false);
		expect(next.message).toContain("Missing role completion");

		await writeFile(
			join(paths.sessionsDir, "product_manager", "completion.json"),
			JSON.stringify({
				status: "done",
				phase: "requirements_discussion",
				artifacts: ["artifacts/requirements/structured-wf-requirements.json"],
				needsUserDecision: false,
				summary: "Requirements artifact is ready.",
				refs: ["artifacts/requirements/structured-wf-requirements.json"],
			}),
			"utf8",
		);
		next = await nextWorkflow(root);
		expect(next.ok).toBe(true);
		expect(next.message).toContain("requirements_approval");
		const manifest = await readJson<{ items: Array<{ path: string; status: string }> }>(
			join(paths.artifactsDir, "manifest.json"),
		);
		expect(manifest.items[0]).toMatchObject({
			path: "artifacts/requirements/structured-wf-requirements.json",
			status: "valid",
		});
	});

	it("blocks when role completion requests a user decision", async () => {
		const root = await createProjectRoot();
		const agentDir = await createProjectRoot();
		createdDirs.push(root);
		createdDirs.push(agentDir);
		await createOrUpdateCapabilityPreset(agentDir, {
			id: "completion-decision",
			name: "Completion Decision",
			config: {
				roles: {
					product_manager: {
						persona: "Product manager that can request decisions",
						responsibilities: ["Escalate unclear scope"],
						phasePrompts: { requirements_discussion: "Escalate when blocked." },
						skills: [],
						toolPolicy: { include: ["shell"], exclude: [] },
						requiredArtifacts: [
							{
								path: "artifacts/requirements/{workflow}.md",
								owner: "product_manager",
								phase: "requirements_discussion",
								description: "Requirements notes.",
							},
						],
						outputContract: "Write completion decision state.",
					},
				},
			},
		});
		await startWorkflow(root, "decision-wf", {
			agentDir,
			capabilityPresetId: "completion-decision",
			runtimeModels: TEST_RUNTIME_MODELS,
		});
		const paths = getWorkflowPaths(root, "decision-wf");
		await writeFile(join(paths.workflowDir, "artifacts", "requirements", "decision-wf.md"), "requirements", "utf8");
		await writeFile(
			join(paths.sessionsDir, "product_manager", "completion.json"),
			JSON.stringify({
				status: "done",
				phase: "requirements_discussion",
				artifacts: ["artifacts/requirements/decision-wf.md"],
				needsUserDecision: true,
				summary: "Need user to choose B2B or B2C scope.",
				refs: ["artifacts/requirements/decision-wf.md"],
			}),
			"utf8",
		);

		const next = await nextWorkflow(root);
		expect(next.ok).toBe(true);
		expect(next.message).toContain("requires user decision");
		const state = await loadWorkflowState(root, "decision-wf");
		expect(state?.phase).toBe("blocked");
		expect(state?.blockedBy?.source).toBe("system");
	});

	it("serves artifact, completion, checkpoint, and rollback APIs", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "production-api-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		await nextWorkflow(root);
		await approveWorkflow(root);
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "production-api-wf");
		if (!state) throw new Error("missing state");
		await orchestrator.syncPhase(getWorkflowPaths(root, "production-api-wf"), state);
		const server = new OpenPlaybookServer({ projectRoot: root, roleSessions: orchestrator });
		startedServers.push(server);
		const started = await server.start(4723);

		const artifacts = await fetch(`${started.url}/api/workflows/production-api-wf/artifacts`);
		expect(artifacts.status).toBe(200);
		const artifactPayload = (await artifacts.json()) as { items: unknown[] };
		expect(Array.isArray(artifactPayload.items)).toBe(true);

		const completion = await fetch(`${started.url}/api/workflows/production-api-wf/roles/product_manager/completion`);
		expect(completion.status).toBe(200);

		const checkpoints = await fetch(`${started.url}/api/workflows/production-api-wf/checkpoints`);
		expect(checkpoints.status).toBe(200);
		const checkpointPayload = (await checkpoints.json()) as { items: Array<{ name: string }> };
		expect(checkpointPayload.items.length).toBeGreaterThan(0);

		const rollback = await fetch(`${started.url}/api/workflows/production-api-wf/rollback`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ checkpoint: checkpointPayload.items[0].name, confirm: false }),
		});
		expect(rollback.status).toBe(200);
		const rollbackPayload = (await rollback.json()) as { result: { ok: boolean }; plan: { checkpoint: string } };
		expect(rollbackPayload.result.ok).toBe(true);
		expect(rollbackPayload.plan.checkpoint).toBe(checkpointPayload.items[0].name);
	});

	it("ships dogfood scenario assets for real runtime validation", async () => {
		const root = join(process.cwd(), "examples", "dogfood");
		await expect(readFile(join(root, "README.md"), "utf8")).resolves.toContain("OpenPlaybook dogfood");
		await expect(readFile(join(root, "scenario.json"), "utf8")).resolves.toContain("runtimePresetId");
		await expect(readFile(join(root, "dogfood-report.md"), "utf8")).resolves.toContain("人工介入点");
	});
});

describe("openplaybook lazy startup / orchestrator availability / auto-commit", () => {
	const createdDirs: string[] = [];

	afterEach(async () => {
		for (const dir of createdDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		createdDirs.length = 0;
	});

	it("syncPhase leaves mentionable roles in not_started; first message transitions to idle", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "lazy-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const paths = getWorkflowPaths(root, "lazy-wf");
		const orchestrator = new RoleSessionOrchestrator({ forceMockRuntime: true });
		const state = await loadWorkflowState(root, "lazy-wf");
		if (!state) throw new Error("missing state");
		await orchestrator.syncPhase(paths, state);

		const beforeStatus = await orchestrator.readRoleStatus(paths, "product_manager", state.phase);
		expect(beforeStatus.status).toBe("not_started");

		await orchestrator.deliverUserMessage(paths, state, "product_manager", "hi");
		const afterStatus = await orchestrator.readRoleStatus(paths, "product_manager", state.phase);
		expect(["idle", "running", "waiting"]).toContain(afterStatus.status);
	});

	it("routes @orchestrator on the control channel during a working phase", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "ctrl-wf", { runtimeModels: TEST_RUNTIME_MODELS });
		const state = await loadWorkflowState(root, "ctrl-wf");
		expect(state?.phase).toBe("requirements_discussion");

		const result = await routePhaseMessage(root, "@orchestrator", "please check overall progress", "control");
		expect(result.ok).toBe(true);

		const controlLines = await readChannel(root, "ctrl-wf", "control");
		expect(controlLines.some((line) => line.includes("please check overall progress"))).toBe(true);
	});

	it("rejects @orchestrator on a non-control channel when not in the orchestrator's phase", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await startWorkflow(root, "ctrl-wf-2", { runtimeModels: TEST_RUNTIME_MODELS });
		// requirements_discussion's PHASE_MENTIONABLE_ROLES now includes orchestrator,
		// so routing without channelOverride writes to the active "requirements" channel.
		// We assert the legal default-channel path still works.
		const ok = await routePhaseMessage(root, "@orchestrator", "ping");
		expect(ok.ok).toBe(true);

		// And @architect (not allowed in requirements_discussion + not in the control channel set) must fail.
		const denied = await routePhaseMessage(root, "@architect", "ping", "control");
		expect(denied.ok).toBe(false);
	});

	it("commitWorktreeIfDirty: returns clean reason on an unchanged worktree", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
		await execFileAsync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=t@t.local", "commit", "--allow-empty", "-m", "init"],
			{ cwd: root },
		);
		const result = await commitWorktreeIfDirty(root, {
			role: "orchestrator",
			phase: "milestone_approval",
			message: "milestone(orchestrator): test",
		});
		expect(result.committed).toBe(false);
		expect(result.reason).toBe("clean");
	});

	it("commitWorktreeIfDirty: commits with role-attributed author on a dirty worktree", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
		await execFileAsync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=t@t.local", "commit", "--allow-empty", "-m", "init"],
			{ cwd: root },
		);
		await writeFile(join(root, "feature.txt"), "first version\n", "utf8");
		const result = await commitWorktreeIfDirty(root, {
			role: "backend_developer",
			phase: "subtask_qa",
			message: "subtask(backend_developer): added feature.txt",
		});
		expect(result.committed).toBe(true);
		expect(result.commit?.length ?? 0).toBeGreaterThan(0);

		const { stdout: lastLog } = await execFileAsync("git", ["log", "-1", "--format=%an|%ae|%s"], { cwd: root });
		const [author, email, subject] = lastLog.trim().split("|");
		expect(author).toBe(ROLE_COMMIT_IDENTITY.backend_developer.name);
		expect(email).toBe(ROLE_COMMIT_IDENTITY.backend_developer.email);
		expect(subject).toBe("subtask(backend_developer): added feature.txt");
	});

	it("commitWorktreeIfDirty: returns not_a_git_repo when the directory is not a git worktree", async () => {
		const root = await createProjectRoot();
		createdDirs.push(root);
		const result = await commitWorktreeIfDirty(root, {
			role: "orchestrator",
			phase: "milestone_approval",
			message: "ignored",
		});
		expect(result.committed).toBe(false);
		expect(result.reason).toBe("not_a_git_repo");
	});
});
