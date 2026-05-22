import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CapabilityPresetInput,
	createOrUpdateCapabilityPreset,
	deleteCapabilityPreset,
	loadCapabilityPresetLibrary,
	setDefaultCapabilityPreset,
} from "./capability-presets.ts";
import { OPENPLAYBOOK_DIR, PHASE_CHANNEL_MAP, PHASE_MENTIONABLE_ROLES } from "./constants.ts";
import {
	appendWorkflowMemory,
	isMemoryPhase,
	isMemoryRole,
	isMemoryScope,
	parseMemoryScopeList,
	searchWorkflowMemory,
	validateWorkflowMemoryInput,
} from "./memory.ts";
import { redactValue } from "./redaction.ts";
import type { RoleSessionOrchestrator } from "./role-sessions.ts";
import { buildRuntimeModelRecommendations, loadAvailableRuntimeModels } from "./runtime-models.ts";
import {
	createOrUpdateRuntimePreset,
	deleteRuntimePreset,
	loadRuntimePresetLibrary,
	type RuntimePresetInput,
	setDefaultRuntimePreset,
} from "./runtime-presets.ts";
import { readJsonFile, readJsonlFile } from "./storage.ts";
import {
	CHANNEL_IDS,
	type ChannelId,
	type CommandResult,
	type OpenPlaybookApiCreateWorkflowRequest,
	type OpenPlaybookApiPhaseContextResponse,
	type OpenPlaybookApiRuntimeModelsResponse,
	type OpenPlaybookApiWorkflowsResponse,
	ROLE_IDS,
	type RoleId,
	type RoleRuntimeState,
	type RuntimeModelOption,
	type WorkflowMemoryInput,
} from "./types.ts";
import { renderMissingWebUiPage } from "./ui.ts";
import {
	approveWorkflow,
	closeWorkflow,
	getWorkflowPaths,
	listWorkflowArtifacts,
	listWorkflowCheckpoints,
	loadActiveWorkflow,
	loadWorkflowState,
	nextWorkflow,
	parseWorkflowName,
	readWorkflowRoleCompletion,
	reviseWorkflow,
	rollbackWorkflow,
	routePhaseMessage,
	startWorkflow,
	type WorkflowPaths,
} from "./workflow.ts";

interface OpenPlaybookServerOptions {
	projectRoot: string;
	roleSessions: RoleSessionOrchestrator;
	onMutation?: () => Promise<void>;
	agentDir?: string;
	webUiDir?: string;
	runtimeModels?: RuntimeModelOption[];
}

export interface OpenPlaybookServeResult {
	port: number;
	url: string;
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(`${JSON.stringify(payload)}\n`);
}

function text(
	res: ServerResponse,
	statusCode: number,
	payload: string,
	contentType = "text/plain; charset=utf-8",
): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", contentType);
	res.setHeader("cache-control", "no-store");
	res.end(payload);
}

const WEBUI_DIR = join(dirname(fileURLToPath(import.meta.url)), "webui");

const ASSET_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

async function serveFile(res: ServerResponse, absolutePath: string, contentType: string): Promise<boolean> {
	try {
		const content = await readFile(absolutePath);
		res.statusCode = 200;
		res.setHeader("content-type", contentType);
		res.setHeader("cache-control", "no-store");
		res.end(content);
		return true;
	} catch {
		return false;
	}
}

function resolveWebUiAsset(webUiDir: string, pathname: string): string | undefined {
	const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const normalized = normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes(":")) return undefined;
	return join(webUiDir, normalized);
}

function badRequest(res: ServerResponse, message: string): void {
	json(res, 400, { error: message });
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf8");
	return JSON.parse(raw) as unknown;
}

function isRole(value: string): value is RoleId {
	return ROLE_IDS.includes(value as RoleId);
}

function isChannel(value: string): value is ChannelId {
	return CHANNEL_IDS.includes(value as ChannelId);
}

async function listWorkflows(projectRoot: string): Promise<OpenPlaybookApiWorkflowsResponse> {
	const root = join(projectRoot, OPENPLAYBOOK_DIR);
	const active = await loadActiveWorkflow(projectRoot);
	let workflows: OpenPlaybookApiWorkflowsResponse["workflows"] = [];
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());
		const states = await Promise.all(dirs.map((e) => loadWorkflowState(projectRoot, e.name)));
		for (let i = 0; i < dirs.length; i++) {
			const state = states[i];
			if (!state) continue;
			const name = dirs[i].name;
			workflows.push({
				id: name,
				displayName: state.displayName || state.workflow,
				status: state.status,
				phase: state.phase,
				active: active?.workflow === name && active.status === "active",
				updatedAt: active?.workflow === name ? active.updatedAt : new Date().toISOString(),
			});
		}
	} catch {
		workflows = [];
	}
	workflows.sort((a, b) => a.id.localeCompare(b.id));
	return {
		activeWorkflowId: active?.status === "active" && active.workflow ? active.workflow : null,
		workflows,
	};
}

async function resolveWorkflow(
	projectRoot: string,
	workflowId: string,
): Promise<{
	paths: WorkflowPaths;
} | null> {
	const parsed = parseWorkflowName(workflowId);
	if (!parsed) return null;
	const paths = getWorkflowPaths(projectRoot, parsed);
	const state = await readJsonFile(paths.stateFile);
	if (!state) return null;
	return { paths };
}

function parseCursor(url: URL, defaultLimit = 50, maxLimit = 1000): { cursor: number; limit: number } {
	const cursorRaw = url.searchParams.get("cursor");
	const limitRaw = url.searchParams.get("limit");
	const cursor = cursorRaw ? Math.max(0, Number.parseInt(cursorRaw, 10) || 0) : 0;
	const limit = limitRaw
		? Math.min(maxLimit, Math.max(1, Number.parseInt(limitRaw, 10) || defaultLimit))
		: defaultLimit;
	return { cursor, limit };
}

export class OpenPlaybookServer {
	private server?: Server;
	private port?: number;
	private readonly options: OpenPlaybookServerOptions;

	constructor(options: OpenPlaybookServerOptions) {
		this.options = options;
	}

	private async runAction(workflowId: string, action: string, reason?: string): Promise<CommandResult> {
		const active = await loadActiveWorkflow(this.options.projectRoot);
		if (!active?.workflow || active.status !== "active") {
			return { ok: false, message: "No active workflow found." };
		}
		if (active.workflow !== workflowId) {
			return {
				ok: false,
				message: `Workflow '${workflowId}' is not active. Actions are allowed only on active workflow '${active.workflow}'.`,
			};
		}
		if (action === "approve") return approveWorkflow(this.options.projectRoot);
		if (action === "next") return nextWorkflow(this.options.projectRoot);
		if (action === "close") return closeWorkflow(this.options.projectRoot);
		if (action === "revise") return reviseWorkflow(this.options.projectRoot, reason ?? "");
		return { ok: false, message: `Unknown action '${action}'.` };
	}

	private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const pathname = url.pathname;
		const method = req.method ?? "GET";
		const parts = pathname.split("/").filter(Boolean);

		if (pathname === "/api/workflows" && method === "GET") {
			json(res, 200, await listWorkflows(this.options.projectRoot));
			return;
		}
		if (pathname === "/api/workflows" && method === "POST") {
			const payload = (await parseBody(req)) as OpenPlaybookApiCreateWorkflowRequest;
			if ("presetId" in (payload as object)) {
				badRequest(res, "Use runtimePresetId; presetId is not supported.");
				return;
			}
			const workflowName = typeof payload.id === "string" ? parseWorkflowName(payload.id) : undefined;
			if (!workflowName) {
				badRequest(res, "Invalid workflow id.");
				return;
			}
			const result = await startWorkflow(this.options.projectRoot, workflowName, {
				displayName: typeof payload.displayName === "string" ? payload.displayName.trim() : workflowName,
				agentDir: this.options.agentDir,
				runtimePresetId: payload.runtimePresetId,
				capabilityPresetId: payload.capabilityPresetId,
				runtimeModels: this.options.runtimeModels,
			});
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			if (this.options.onMutation) {
				await this.options.onMutation();
			}
			json(res, 200, result);
			return;
		}
		if (pathname === "/api/runtime-presets" && method === "GET") {
			json(res, 200, redactValue(await loadRuntimePresetLibrary(this.options.agentDir)));
			return;
		}
		if (pathname === "/api/runtime-models" && method === "GET") {
			const library = await loadRuntimePresetLibrary(this.options.agentDir);
			const defaultPreset = library.presets.find((preset) => preset.id === library.defaultPresetId);
			const models = this.options.runtimeModels ?? (await loadAvailableRuntimeModels(this.options.agentDir));
			const payload: OpenPlaybookApiRuntimeModelsResponse = {
				models,
				recommendations: buildRuntimeModelRecommendations(models, defaultPreset?.config),
			};
			json(res, 200, redactValue(payload));
			return;
		}
		if (pathname === "/api/runtime-presets" && method === "POST") {
			const payload = (await parseBody(req)) as RuntimePresetInput;
			const result = await createOrUpdateRuntimePreset(this.options.agentDir, payload);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}
		if (pathname === "/api/runtime-presets/default" && method === "POST") {
			const payload = (await parseBody(req)) as { presetId?: string };
			if (!payload.presetId) {
				badRequest(res, "Missing presetId.");
				return;
			}
			const result = await setDefaultRuntimePreset(this.options.agentDir, payload.presetId);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}
		if (parts.length === 3 && parts[0] === "api" && parts[1] === "runtime-presets" && method === "DELETE") {
			const result = await deleteRuntimePreset(this.options.agentDir, parts[2]);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}
		if (pathname === "/api/capability-presets" && method === "GET") {
			json(res, 200, redactValue(await loadCapabilityPresetLibrary(this.options.agentDir)));
			return;
		}
		if (pathname === "/api/capability-presets" && method === "POST") {
			const payload = (await parseBody(req)) as CapabilityPresetInput;
			const result = await createOrUpdateCapabilityPreset(this.options.agentDir, payload);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}
		if (pathname === "/api/capability-presets/default" && method === "POST") {
			const payload = (await parseBody(req)) as { presetId?: string };
			if (!payload.presetId) {
				badRequest(res, "Missing presetId.");
				return;
			}
			const result = await setDefaultCapabilityPreset(this.options.agentDir, payload.presetId);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}
		if (parts.length === 3 && parts[0] === "api" && parts[1] === "capability-presets" && method === "DELETE") {
			const result = await deleteCapabilityPreset(this.options.agentDir, parts[2]);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			json(res, 200, result);
			return;
		}

		if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "workflows") {
			badRequest(res, "Unknown API route.");
			return;
		}
		const workflowId = parts[2];
		const workflow = await resolveWorkflow(this.options.projectRoot, workflowId);
		if (!workflow) {
			json(res, 404, { error: `Workflow '${workflowId}' not found.` });
			return;
		}

		if (parts[3] === "state" && method === "GET") {
			const state = await readJsonFile(workflow.paths.stateFile);
			json(res, 200, state ?? {});
			return;
		}

		if (parts[3] === "phase-context" && method === "GET") {
			const state = await loadWorkflowState(this.options.projectRoot, workflowId);
			if (!state) {
				json(res, 404, { error: `Workflow '${workflowId}' state not found.` });
				return;
			}
			const active = await loadActiveWorkflow(this.options.projectRoot);
			const isCurrentWorkflow = active?.workflow === workflowId && active.status === "active";
			const roleStates: Record<RoleId, RoleRuntimeState> = { ...state.roles };
			const allRoleStatuses = await Promise.all(
				ROLE_IDS.map((role) => this.options.roleSessions.readRoleStatus(workflow.paths, role, state.phase)),
			);
			for (let i = 0; i < ROLE_IDS.length; i++) {
				const status = allRoleStatuses[i];
				roleStates[ROLE_IDS[i]] = {
					sessionId: status.sessionId,
					status: status.status,
				};
			}
			const payload: OpenPlaybookApiPhaseContextResponse = {
				workflowId,
				phase: state.phase,
				channel: PHASE_CHANNEL_MAP[state.phase],
				allowedRoles: PHASE_MENTIONABLE_ROLES[state.phase] ?? [],
				roleStates,
				isCurrentWorkflow,
				readonly: !isCurrentWorkflow || state.status !== "active",
			};
			json(res, 200, redactValue(payload));
			return;
		}

		if (parts[3] === "runtime-preset" && method === "GET") {
			const snapshot = await readJsonFile(join(workflow.paths.rolesDir, "runtime-preset.json"));
			json(res, 200, redactValue(snapshot ?? {}));
			return;
		}

		if (parts[3] === "capability-preset" && method === "GET") {
			const snapshot = await readJsonFile(join(workflow.paths.rolesDir, "capability-preset.json"));
			json(res, 200, redactValue(snapshot ?? {}));
			return;
		}

		if (parts[3] === "artifacts" && parts.length === 4 && method === "GET") {
			const manifest = await listWorkflowArtifacts(this.options.projectRoot, workflowId);
			json(res, 200, redactValue(manifest));
			return;
		}

		if (parts[3] === "checkpoints" && parts.length === 4 && method === "GET") {
			const checkpoints = await listWorkflowCheckpoints(this.options.projectRoot, workflowId);
			json(res, 200, { items: redactValue(checkpoints) });
			return;
		}

		if (parts[3] === "rollback" && parts.length === 4 && method === "POST") {
			const payload = (await parseBody(req)) as { checkpoint?: string; confirm?: boolean };
			if (!payload.checkpoint?.trim()) {
				badRequest(res, "Missing checkpoint.");
				return;
			}
			const rollback = await rollbackWorkflow(
				this.options.projectRoot,
				payload.checkpoint,
				payload.confirm === true,
			);
			if (!rollback.result.ok) {
				json(res, 400, rollback);
				return;
			}
			json(res, 200, redactValue(rollback));
			return;
		}

		if (parts[3] === "channels" && parts.length === 5 && method === "GET") {
			const channel = parts[4];
			if (!isChannel(channel)) {
				badRequest(res, `Unknown channel '${channel}'.`);
				return;
			}
			const messages = await readJsonlFile(join(workflow.paths.channelsDir, `${channel}.jsonl`));
			const { cursor, limit } = parseCursor(url);
			const slice = messages.slice(cursor, cursor + limit);
			json(res, 200, {
				channel,
				items: redactValue(slice),
				nextCursor: cursor + limit < messages.length ? cursor + limit : null,
				total: messages.length,
			});
			return;
		}

		if (parts[3] === "memory" && parts.length === 4 && method === "GET") {
			const scopes = parseMemoryScopeList(url.searchParams.get("scope") ?? url.searchParams.get("scopes"));
			const role = url.searchParams.get("role");
			const phase = url.searchParams.get("phase");
			if (role && !isMemoryRole(role)) {
				badRequest(res, `Unknown role '${role}'.`);
				return;
			}
			if (phase && !isMemoryPhase(phase)) {
				badRequest(res, `Unknown phase '${phase}'.`);
				return;
			}
			const { limit } = parseCursor(url);
			const items = await searchWorkflowMemory(workflow.paths, {
				scopes,
				role: role && isMemoryRole(role) ? role : undefined,
				phase: phase && isMemoryPhase(phase) ? phase : undefined,
				limit,
			});
			json(res, 200, { items: redactValue(items) });
			return;
		}

		if (parts[3] === "memory" && parts.length === 4 && method === "POST") {
			const payload = (await parseBody(req)) as Partial<WorkflowMemoryInput>;
			if (!payload.scope || !isMemoryScope(payload.scope)) {
				badRequest(res, "Invalid memory scope.");
				return;
			}
			if (!payload.role || !isMemoryRole(payload.role)) {
				badRequest(res, "Invalid memory role.");
				return;
			}
			if (!payload.phase || !isMemoryPhase(payload.phase)) {
				badRequest(res, "Invalid memory phase.");
				return;
			}
			const input: WorkflowMemoryInput = {
				scope: payload.scope,
				role: payload.role,
				phase: payload.phase,
				type: payload.type ?? "",
				text: payload.text ?? "",
				refs: payload.refs,
				tags: payload.tags,
				importance: payload.importance,
			};
			const validationError = validateWorkflowMemoryInput(input);
			if (validationError) {
				badRequest(res, validationError);
				return;
			}
			const entry = await appendWorkflowMemory(workflow.paths, input);
			json(res, 200, redactValue(entry));
			return;
		}

		if (parts[3] === "roles" && parts.length === 5 && method === "GET") {
			const role = parts[4];
			if (!isRole(role)) {
				badRequest(res, `Unknown role '${role}'.`);
				return;
			}
			const details = await this.options.roleSessions.readRoleDetails(workflow.paths, role);
			const { cursor, limit } = parseCursor(url, 200);
			const transcriptTotal = details.transcript.length;
			const toolEventsTotal = details.toolEvents.length;
			const transcriptSlice = details.transcript.slice(cursor, cursor + limit);
			const toolEventsSlice = details.toolEvents.slice(cursor, cursor + limit);
			const maxTotal = Math.max(transcriptTotal, toolEventsTotal);
			json(res, 200, {
				role,
				state: redactValue(details.state),
				transcript: redactValue(transcriptSlice),
				toolEvents: redactValue(toolEventsSlice),
				artifacts: details.artifacts,
				nextCursor: cursor + limit < maxTotal ? cursor + limit : null,
				transcriptTotal,
				toolEventsTotal,
			});
			return;
		}

		if (parts[3] === "roles" && parts[5] === "summary" && parts.length === 6 && method === "GET") {
			const role = parts[4];
			if (!isRole(role)) {
				badRequest(res, `Unknown role '${role}'.`);
				return;
			}
			const state = await readJsonFile<{ phase?: string }>(workflow.paths.stateFile);
			const phase = state?.phase && isMemoryPhase(state.phase) ? state.phase : "draft";
			const summary = await this.options.roleSessions.readRoleSummary(workflow.paths, role, phase);
			json(res, 200, redactValue(summary));
			return;
		}

		if (parts[3] === "roles" && parts[5] === "completion" && parts.length === 6 && method === "GET") {
			const role = parts[4];
			if (!isRole(role)) {
				badRequest(res, `Unknown role '${role}'.`);
				return;
			}
			const completion = await readWorkflowRoleCompletion(this.options.projectRoot, workflowId, role);
			json(res, 200, redactValue(completion ?? {}));
			return;
		}

		if (parts[3] === "actions" && method === "POST") {
			const payload = (await parseBody(req)) as { action?: string; reason?: string };
			if (!payload.action) {
				badRequest(res, "Missing action.");
				return;
			}
			const result = await this.runAction(workflowId, payload.action, payload.reason);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			if (this.options.onMutation) {
				await this.options.onMutation();
			}
			json(res, 200, result);
			return;
		}

		if (parts[3] === "messages" && method === "POST") {
			const payload = (await parseBody(req)) as { message?: string; channel?: string };
			if (!payload.message?.trim()) {
				badRequest(res, "Message is required.");
				return;
			}
			const match = payload.message.match(/^@([a-zA-Z0-9._-]+)\s+([\s\S]+)$/);
			if (!match) {
				badRequest(res, "Only '@role message' format is accepted.");
				return;
			}
			const [, role, body] = match;
			const channelOverride = payload.channel && isChannel(payload.channel) ? payload.channel : undefined;
			const result = await routePhaseMessage(this.options.projectRoot, `@${role}`, body.trim(), channelOverride);
			if (!result.ok) {
				json(res, 400, result);
				return;
			}
			const activeState = await loadWorkflowState(this.options.projectRoot, workflowId);
			if (activeState && isRole(role)) {
				await this.options.roleSessions.deliverUserMessage(workflow.paths, activeState, role, body.trim());
			}
			if (this.options.onMutation) {
				await this.options.onMutation();
			}
			json(res, 200, result);
			return;
		}

		badRequest(res, "Unsupported API route.");
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname.startsWith("/api/")) {
				await this.handleApi(req, res, url);
				return;
			}
			const webUiDir = this.options.webUiDir ?? WEBUI_DIR;
			const assetPath = resolveWebUiAsset(webUiDir, url.pathname);
			if (assetPath) {
				const contentType = ASSET_CONTENT_TYPES[extname(assetPath)] ?? "application/octet-stream";
				if (await serveFile(res, assetPath, contentType)) return;
			}
			if (url.pathname !== "/" && url.pathname.startsWith("/assets/")) {
				text(res, 404, "Not found", "text/plain; charset=utf-8");
				return;
			}
			const indexPath = join(webUiDir, "index.html");
			if (await serveFile(res, indexPath, "text/html; charset=utf-8")) return;
			text(res, 200, renderMissingWebUiPage(), "text/html; charset=utf-8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			json(res, 500, { error: detail });
		}
	}

	async start(preferredPort = 4717): Promise<OpenPlaybookServeResult> {
		if (this.server && this.port) {
			return { port: this.port, url: `http://127.0.0.1:${this.port}` };
		}
		for (let candidate = preferredPort; candidate < preferredPort + 100; candidate += 1) {
			try {
				const server = createServer((req, res) => {
					void this.handle(req, res);
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(candidate, "127.0.0.1", () => resolve());
				});
				this.server = server;
				this.port = candidate;
				return { port: candidate, url: `http://127.0.0.1:${candidate}` };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
			}
		}
		throw new Error(`Failed to bind openplaybook server to a port in range ${preferredPort}–${preferredPort + 99}.`);
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => {
			this.server?.close(() => resolve());
		});
		this.server = undefined;
		this.port = undefined;
	}
}
