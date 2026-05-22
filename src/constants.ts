import type { ChannelId, ReviewDecision, RoleId, WorkflowPhase } from "./types.ts";

export const OPENPLAYBOOK_DIR = ".openplaybook";
export const ACTIVE_WORKFLOW_FILE = "active-workflow.json";

export const PHASE_CHANNEL_MAP: Record<WorkflowPhase, ChannelId> = {
	draft: "control",
	requirements_discussion: "requirements",
	requirements_approval: "control",
	architecture_design: "architecture",
	architecture_review: "architecture",
	architecture_approval: "control",
	planning: "planning",
	planning_review: "planning",
	planning_approval: "control",
	development: "development",
	subtask_review: "review",
	subtask_qa: "review",
	milestone_review: "review",
	milestone_approval: "control",
	done: "control",
	blocked: "control",
};

export const PHASE_MENTIONABLE_ROLES: Record<WorkflowPhase, RoleId[]> = {
	draft: ["orchestrator"],
	requirements_discussion: ["product_manager", "orchestrator"],
	requirements_approval: ["orchestrator"],
	architecture_design: ["architect", "sql_designer", "architecture_reviewer", "orchestrator"],
	architecture_review: ["architect", "sql_designer", "architecture_reviewer", "orchestrator"],
	architecture_approval: ["orchestrator"],
	planning: ["plan_writer", "plan_reviewer", "orchestrator"],
	planning_review: ["plan_writer", "plan_reviewer", "orchestrator"],
	planning_approval: ["orchestrator"],
	development: ["frontend_developer", "backend_developer", "code_reviewer", "qa_tester", "orchestrator"],
	subtask_review: ["code_reviewer", "frontend_developer", "backend_developer", "orchestrator"],
	subtask_qa: ["qa_tester", "frontend_developer", "backend_developer", "orchestrator"],
	milestone_review: ["qa_tester", "code_reviewer", "frontend_developer", "backend_developer", "orchestrator"],
	milestone_approval: ["orchestrator"],
	done: ["orchestrator"],
	blocked: ["orchestrator"],
};

/**
 * Roles that can be @-mentioned in a given channel regardless of the workflow's current phase.
 * The control channel is always-on for the orchestrator. Other channels are append-only history
 * during off-phase and use the phase-mentionable list when they ARE the active channel.
 */
export const CHANNEL_MENTIONABLE_ROLES: Record<ChannelId, RoleId[]> = {
	control: ["orchestrator"],
	requirements: [],
	architecture: [],
	planning: [],
	development: [],
	review: [],
};

export const NEXT_TRANSITIONS: Partial<Record<WorkflowPhase, WorkflowPhase>> = {
	requirements_discussion: "requirements_approval",
	architecture_design: "architecture_review",
	planning: "planning_review",
	development: "subtask_review",
	subtask_review: "subtask_qa",
	subtask_qa: "milestone_review",
	milestone_review: "milestone_approval",
};

export const APPROVAL_TRANSITIONS: Partial<Record<WorkflowPhase, WorkflowPhase>> = {
	requirements_approval: "architecture_design",
	architecture_approval: "planning",
	planning_approval: "development",
	milestone_approval: "done",
};

export interface ReviewPhaseConfig {
	decisionFile: string;
	onApproved: WorkflowPhase;
	onRejectedFallback: WorkflowPhase;
}

export const REVIEW_PHASES: Partial<Record<WorkflowPhase, ReviewPhaseConfig>> = {
	architecture_review: {
		decisionFile: "artifacts/architecture-review.json",
		onApproved: "architecture_approval",
		onRejectedFallback: "architecture_design",
	},
	planning_review: {
		decisionFile: "artifacts/planning-review.json",
		onApproved: "planning_approval",
		onRejectedFallback: "planning",
	},
	subtask_review: {
		decisionFile: "artifacts/subtask-review.json",
		onApproved: "subtask_qa",
		onRejectedFallback: "development",
	},
	subtask_qa: {
		decisionFile: "artifacts/subtask-qa.json",
		onApproved: "milestone_review",
		onRejectedFallback: "development",
	},
	milestone_review: {
		decisionFile: "artifacts/milestone-review.json",
		onApproved: "milestone_approval",
		onRejectedFallback: "development",
	},
};

export function isDecisionStatus(value: string): value is ReviewDecision {
	return value === "approved" || value === "rejected" || value === "needs_user_decision";
}
