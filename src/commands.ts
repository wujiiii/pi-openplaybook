import { RoleSessionOrchestrator } from "./role-sessions.ts";
import { loadRuntimePresetLibrary, setDefaultRuntimePreset } from "./runtime-presets.ts";
import { OpenPlaybookServer } from "./server.ts";
import {
	type CommandResult,
	type CommandRuntimeContext,
	ROLE_IDS,
	type RoleId,
	type RuntimeModelOption,
} from "./types.ts";
import {
	approveWorkflow,
	closeWorkflow,
	listWorkflowArtifacts,
	nextWorkflow,
	readWorkflowRoleCompletion,
	resolveActiveState,
	reviseWorkflow,
	rollbackWorkflow,
	routePhaseMessage,
	startWorkflow,
	statusWorkflow,
} from "./workflow.ts";

function notifyResult(ctx: CommandRuntimeContext, result: CommandResult): void {
	if (!ctx.hasUI) return;
	ctx.notify(result.message, result.ok ? "info" : "error");
}

function parseSubcommand(rawArgs: string): { subcommand: string; rest: string } {
	const trimmed = rawArgs.trim();
	if (!trimmed) return { subcommand: "", rest: "" };
	const firstSpace = trimmed.indexOf(" ");
	if (firstSpace === -1) return { subcommand: trimmed.toLowerCase(), rest: "" };
	return {
		subcommand: trimmed.slice(0, firstSpace).toLowerCase(),
		rest: trimmed.slice(firstSpace + 1).trim(),
	};
}

function parseRoleMessage(rest: string): { role: RoleId; message: string } | undefined {
	if (!rest.startsWith("@")) return undefined;
	const firstSpace = rest.indexOf(" ");
	if (firstSpace === -1) return undefined;
	const role = rest.slice(1, firstSpace).trim();
	const message = rest.slice(firstSpace + 1).trim();
	if (!role || !message) return undefined;
	if (!ROLE_IDS.includes(role as RoleId)) return undefined;
	return { role: role as RoleId, message };
}

function parseServePort(raw: string): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) return undefined;
	return parsed;
}

function parseRollbackArgs(rest: string): { name: string; confirm: boolean } | undefined {
	const parts = rest
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return undefined;
	const name = parts[0];
	const confirm = parts.slice(1).includes("--confirm");
	return { name, confirm };
}

function parseStartArgs(
	rest: string,
): { workflow: string; runtimePresetId?: string; capabilityPresetId?: string } | undefined {
	const parts = rest.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return undefined;
	const workflow = parts[0];
	let runtimePresetId: string | undefined;
	let capabilityPresetId: string | undefined;
	for (let index = 1; index < parts.length; index += 1) {
		const flag = parts[index];
		const value = parts[index + 1];
		if (!value) return undefined;
		if (flag === "--runtime-preset") {
			runtimePresetId = value;
		} else if (flag === "--capability-preset") {
			capabilityPresetId = value;
		} else {
			return undefined;
		}
		index += 1;
	}
	return { workflow, runtimePresetId, capabilityPresetId };
}

export class OpenPlaybookController {
	private readonly roleSessions: RoleSessionOrchestrator;
	private readonly servers = new Map<string, OpenPlaybookServer>();
	private readonly options: {
		agentDir?: string;
		runtimeModels?: RuntimeModelOption[];
		roleSessions?: RoleSessionOrchestrator;
	};

	constructor(
		options: {
			agentDir?: string;
			runtimeModels?: RuntimeModelOption[];
			roleSessions?: RoleSessionOrchestrator;
		} = {},
	) {
		this.options = options;
		this.roleSessions = options.roleSessions ?? new RoleSessionOrchestrator({ agentDir: options.agentDir });
	}

	private async syncSessions(cwd: string): Promise<void> {
		const resolved = await resolveActiveState(cwd);
		if ("error" in resolved) return;
		await this.roleSessions.syncPhase(resolved.paths, resolved.state);
	}

	private async closeSessions(cwd: string): Promise<void> {
		const resolved = await resolveActiveState(cwd);
		if ("error" in resolved) return;
		await this.roleSessions.stopWorkflow(resolved.paths, resolved.state);
	}

	private async serve(ctx: CommandRuntimeContext, port?: number): Promise<CommandResult> {
		let server = this.servers.get(ctx.cwd);
		if (!server) {
			server = new OpenPlaybookServer({
				projectRoot: ctx.cwd,
				roleSessions: this.roleSessions,
				agentDir: this.options.agentDir,
				runtimeModels: this.options.runtimeModels,
				onMutation: async () => {
					await this.syncSessions(ctx.cwd);
				},
			});
			this.servers.set(ctx.cwd, server);
		}
		const started = await server.start(port ?? 4717);
		return {
			ok: true,
			message: `OpenPlaybook server started at ${started.url}`,
		};
	}

	async run(rawArgs: string, ctx: CommandRuntimeContext): Promise<CommandResult> {
		const parsed = parseSubcommand(rawArgs);
		if (!parsed.subcommand) {
			const result = {
				ok: false,
				message:
					"Usage: /opb <start|status|next|approve|revise|close|message|serve|rollback|preset|artifacts|completion|dogfood> ...",
			};
			notifyResult(ctx, result);
			return result;
		}

		let result: CommandResult;
		if (parsed.subcommand === "start") {
			const startArgs = parseStartArgs(parsed.rest);
			if (!startArgs) {
				result = {
					ok: false,
					message: "Usage: /opb start <workflow> [--runtime-preset <id>] [--capability-preset <id>]",
				};
				notifyResult(ctx, result);
				return result;
			}
			result = await startWorkflow(ctx.cwd, startArgs.workflow, {
				agentDir: this.options.agentDir,
				runtimePresetId: startArgs.runtimePresetId,
				capabilityPresetId: startArgs.capabilityPresetId,
				runtimeModels: this.options.runtimeModels,
			});
			if (result.ok) await this.syncSessions(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "status") {
			result = await statusWorkflow(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "serve") {
			const port = parseServePort(parsed.rest);
			if (parsed.rest && !port) {
				result = { ok: false, message: "Usage: /opb serve [port]" };
			} else {
				result = await this.serve(ctx, port);
			}
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "runtime") {
			result = {
				ok: false,
				message: "Runtime config is a start-time preset snapshot. Use /opb preset list|show|set-default.",
			};
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "preset") {
			const args = parsed.rest.split(/\s+/).filter(Boolean);
			const action = args[0];
			if (action === "list") {
				const library = await loadRuntimePresetLibrary(this.options.agentDir);
				result = {
					ok: true,
					message: library.presets
						.map(
							(preset) =>
								`${preset.id}${preset.id === library.defaultPresetId ? " (default)" : ""}: ${preset.name}`,
						)
						.join("\n"),
				};
				notifyResult(ctx, result);
				return result;
			}
			if (action === "show" && args[1]) {
				const library = await loadRuntimePresetLibrary(this.options.agentDir);
				const preset = library.presets.find((candidate) => candidate.id === args[1]);
				result = preset
					? { ok: true, message: JSON.stringify(preset, null, 2) }
					: { ok: false, message: `Runtime preset '${args[1]}' does not exist.` };
				notifyResult(ctx, result);
				return result;
			}
			if (action === "set-default" && args[1]) {
				result = await setDefaultRuntimePreset(this.options.agentDir, args[1]);
				notifyResult(ctx, result);
				return result;
			}
			result = { ok: false, message: "Usage: /opb preset <list|show <id>|set-default <id>>" };
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "next") {
			result = await nextWorkflow(ctx.cwd);
			if (result.ok) await this.syncSessions(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "artifacts") {
			const resolved = await resolveActiveState(ctx.cwd);
			if ("error" in resolved) {
				notifyResult(ctx, resolved.error);
				return resolved.error;
			}
			const manifest = await listWorkflowArtifacts(ctx.cwd, resolved.state.workflow);
			result = {
				ok: true,
				message:
					manifest.items.length === 0
						? "No structured artifacts registered."
						: manifest.items.map((item) => `${item.status} ${item.owner}: ${item.path}`).join("\n"),
			};
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "completion") {
			const role = parsed.rest.startsWith("@") ? parsed.rest.slice(1).trim() : parsed.rest.trim();
			if (!ROLE_IDS.includes(role as RoleId)) {
				result = { ok: false, message: "Usage: /opb completion @role" };
				notifyResult(ctx, result);
				return result;
			}
			const resolved = await resolveActiveState(ctx.cwd);
			if ("error" in resolved) {
				notifyResult(ctx, resolved.error);
				return resolved.error;
			}
			const completion = await readWorkflowRoleCompletion(ctx.cwd, resolved.state.workflow, role as RoleId);
			result = {
				ok: true,
				message: completion ? JSON.stringify(completion, null, 2) : `No completion for @${role}.`,
			};
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "dogfood") {
			result = {
				ok: true,
				message:
					"Dogfood assets are in packages/openplaybook/examples/dogfood. Use scenario.json and fill dogfood-report.md after a real runtime run.",
			};
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "approve") {
			result = await approveWorkflow(ctx.cwd);
			if (result.ok) await this.syncSessions(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "revise") {
			result = await reviseWorkflow(ctx.cwd, parsed.rest);
			if (result.ok) await this.syncSessions(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "rollback") {
			const args = parseRollbackArgs(parsed.rest);
			if (!args) {
				result = { ok: false, message: "Usage: /opb rollback <checkpoint> [--confirm]" };
				notifyResult(ctx, result);
				return result;
			}
			let confirm = args.confirm;
			if (confirm && ctx.confirm) {
				confirm = await ctx.confirm(
					"Confirm rollback",
					`Apply rollback '${args.name}'? This may reset git history.`,
				);
			}
			const rollback = await rollbackWorkflow(ctx.cwd, args.name, confirm, "user");
			result = rollback.result;
			if (rollback.plan) {
				const planText = JSON.stringify(rollback.plan, null, 2);
				ctx.notify(planText, "info");
			}
			if (result.ok && confirm) {
				await this.closeSessions(ctx.cwd);
			}
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "close") {
			await this.closeSessions(ctx.cwd);
			result = await closeWorkflow(ctx.cwd);
			notifyResult(ctx, result);
			return result;
		}
		if (parsed.subcommand === "message") {
			const roleMessage = parseRoleMessage(parsed.rest);
			if (!roleMessage) {
				result = {
					ok: false,
					message: "Usage: /opb message @role your message",
				};
				notifyResult(ctx, result);
				return result;
			}
			result = await routePhaseMessage(ctx.cwd, `@${roleMessage.role}`, roleMessage.message);
			if (result.ok) {
				const resolved = await resolveActiveState(ctx.cwd);
				if (!("error" in resolved)) {
					await this.roleSessions.deliverUserMessage(
						resolved.paths,
						resolved.state,
						roleMessage.role,
						roleMessage.message,
					);
				}
			}
			notifyResult(ctx, result);
			return result;
		}

		result = { ok: false, message: `Unknown subcommand '${parsed.subcommand}'.` };
		notifyResult(ctx, result);
		return result;
	}
}
