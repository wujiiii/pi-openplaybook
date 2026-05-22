import type { ChannelId, RoleId, RoleRuntimeStatus, WorkflowPhase } from "./types";

export const ROLE_IDS: RoleId[] = [
	"orchestrator",
	"product_manager",
	"architect",
	"sql_designer",
	"architecture_reviewer",
	"plan_writer",
	"plan_reviewer",
	"frontend_developer",
	"backend_developer",
	"code_reviewer",
	"qa_tester",
];

export const CHANNELS: ChannelId[] = ["control", "requirements", "architecture", "planning", "development", "review"];

/**
 * Roles addressable on a given channel regardless of the current phase.
 * Control always accepts @orchestrator; other channels follow phase-mentionable rules.
 */
export const channelMentionableRoles: Record<ChannelId, RoleId[]> = {
	control: ["orchestrator"],
	requirements: [],
	architecture: [],
	planning: [],
	development: [],
	review: [],
};

export const PHASES: WorkflowPhase[] = [
	"requirements_discussion",
	"requirements_approval",
	"architecture_design",
	"architecture_review",
	"architecture_approval",
	"planning",
	"planning_review",
	"planning_approval",
	"development",
	"subtask_review",
	"subtask_qa",
	"milestone_review",
	"milestone_approval",
	"done",
];

export const roleLabels: Record<RoleId, string> = {
	orchestrator: "编排调度员",
	product_manager: "产品经理",
	architect: "架构师",
	sql_designer: "数据结构设计师",
	architecture_reviewer: "架构审查师",
	plan_writer: "计划撰写师",
	plan_reviewer: "计划审查师",
	frontend_developer: "前端开发",
	backend_developer: "后端开发",
	code_reviewer: "代码审查师",
	qa_tester: "QA 测试师",
};

export const phaseLabels: Record<WorkflowPhase, string> = {
	draft: "草稿",
	requirements_discussion: "需求讨论",
	requirements_approval: "需求验收",
	architecture_design: "架构设计",
	architecture_review: "架构审查",
	architecture_approval: "架构验收",
	planning: "计划撰写",
	planning_review: "计划审查",
	planning_approval: "计划验收",
	development: "开发",
	subtask_review: "子任务审查",
	subtask_qa: "子任务 QA",
	milestone_review: "里程碑审查",
	milestone_approval: "里程碑验收",
	done: "完成",
	blocked: "阻塞",
};

export const channelLabels: Record<ChannelId, string> = {
	control: "控制台",
	requirements: "需求",
	architecture: "架构",
	planning: "计划",
	development: "开发",
	review: "审查与 QA",
};

export const statusLabels: Record<RoleRuntimeStatus, string> = {
	not_started: "未启动",
	starting: "启动中",
	running: "工作中",
	waiting: "等待中",
	idle: "空闲",
	done: "已完成",
	failed: "失败",
	stopped: "已停止",
};

export const roleColors: Record<RoleId, string> = {
	orchestrator: "#2455d6",
	product_manager: "#008b73",
	architect: "#6f42ff",
	sql_designer: "#a86e00",
	architecture_reviewer: "#cf3f79",
	plan_writer: "#2f7d32",
	plan_reviewer: "#9346d1",
	frontend_developer: "#0d8ea8",
	backend_developer: "#c55e1a",
	code_reviewer: "#4d63c9",
	qa_tester: "#d23f31",
};

export function formatTime(value: string): string {
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function splitLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
}
