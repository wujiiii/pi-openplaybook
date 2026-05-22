import { OpenPlaybookController } from "./commands.ts";

interface ExtensionCommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string): Promise<boolean>;
	};
}

interface ExtensionAPI {
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
		},
	): void;
}

function createRuntimeContext(ctx: ExtensionCommandContext) {
	return {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		notify(message: string, type: "info" | "warning" | "error" = "info") {
			if (ctx.hasUI) {
				ctx.ui.notify(message, type);
			}
		},
		async confirm(title: string, message: string): Promise<boolean> {
			if (!ctx.hasUI) return false;
			return ctx.ui.confirm(title, message);
		},
	};
}

export default function openplaybook(pi: ExtensionAPI): void {
	const controller = new OpenPlaybookController();
	const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		await controller.run(args, createRuntimeContext(ctx));
	};
	pi.registerCommand("opb", {
		description: "OpenPlaybook workflow control",
		handler,
	});
	pi.registerCommand("openplaybook", {
		description: "OpenPlaybook workflow control (alias of /opb)",
		handler,
	});
}

export { OpenPlaybookController } from "./commands.ts";
export type {
	ActiveWorkflowRef,
	BlockedState,
	ChannelMessage,
	CommandResult,
	CommandRuntimeContext,
	MilestoneState,
	OpenPlaybookApiActionRequest,
	OpenPlaybookApiChannelPageResponse,
	OpenPlaybookApiMessageRequest,
	OpenPlaybookApiRoleResponse,
	OpenPlaybookApiWorkflowItem,
	OpenPlaybookApiWorkflowsResponse,
	ReviewDecision,
	ReviewGateResult,
	RoleId,
	RoleRuntimeState,
	RoleRuntimeStatus,
	RoleSessionEvent,
	RoleSessionState,
	RollbackPlan,
	RuntimeModelOption,
	WorkflowActionType,
	WorkflowPhase,
	WorkflowState,
	WorkflowStatus,
} from "./types.ts";
