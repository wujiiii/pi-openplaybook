export type WorkflowStatus = "active" | "completed" | "closed" | "failed" | "archived";
export type WorkflowPhase =
	| "draft"
	| "requirements_discussion"
	| "requirements_approval"
	| "architecture_design"
	| "architecture_review"
	| "architecture_approval"
	| "planning"
	| "planning_review"
	| "planning_approval"
	| "development"
	| "subtask_review"
	| "subtask_qa"
	| "milestone_review"
	| "milestone_approval"
	| "done"
	| "blocked";
export type ChannelId = "control" | "requirements" | "architecture" | "planning" | "development" | "review";
export type RoleId =
	| "orchestrator"
	| "product_manager"
	| "architect"
	| "sql_designer"
	| "architecture_reviewer"
	| "plan_writer"
	| "plan_reviewer"
	| "frontend_developer"
	| "backend_developer"
	| "code_reviewer"
	| "qa_tester";
export type RoleRuntimeStatus =
	| "not_started"
	| "starting"
	| "running"
	| "waiting"
	| "idle"
	| "done"
	| "failed"
	| "stopped";

export interface RoleRuntimeState {
	sessionId: string | null;
	status: RoleRuntimeStatus;
}

export interface WorkflowItem {
	id: string;
	displayName: string;
	status: WorkflowStatus;
	phase: WorkflowPhase;
	active: boolean;
	updatedAt: string;
}

export interface OpenPlaybookApiCreateWorkflowRequest {
	id: string;
	displayName: string;
	runtimePresetId?: string;
	capabilityPresetId?: string;
}

export interface OpenPlaybookApiWorkflowsResponse {
	activeWorkflowId: string | null;
	workflows: WorkflowItem[];
}

export interface OpenPlaybookApiPhaseContextResponse {
	workflowId: string;
	phase: WorkflowPhase;
	channel: ChannelId;
	allowedRoles: RoleId[];
	roleStates: Record<RoleId, RoleRuntimeState>;
	isCurrentWorkflow: boolean;
	readonly: boolean;
}

export interface ChannelMessage {
	id: string;
	ts: string;
	channel: ChannelId;
	from: string;
	to: string[];
	type: string;
	text: string;
	refs: string[];
}

export interface RoleSessionState extends RoleRuntimeState {
	role: RoleId;
	phase: WorkflowPhase | null;
	lastUpdatedAt: string;
	lastError: string | null;
	model: string | null;
}

export interface RoleSessionEvent {
	id: string;
	ts: string;
	role: RoleId;
	kind: "transcript" | "tool" | "system";
	summary: string;
}

export interface RoleResponse {
	role: RoleId;
	state: RoleSessionState;
	transcript: RoleSessionEvent[];
	toolEvents: RoleSessionEvent[];
	artifacts: string[];
	nextCursor: number | null;
	transcriptTotal: number;
	toolEventsTotal: number;
}

export interface RoleModelAssignment {
	model: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
	tools?: string[];
}

export interface RoleRuntimeConfig {
	mode: "mock" | "real";
	defaultModel: string | null;
	roles: Partial<Record<RoleId, RoleModelAssignment>>;
}

export interface RuntimePreset {
	id: string;
	name: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	config: RoleRuntimeConfig;
}

export interface RuntimePresetLibrary {
	version: 1;
	defaultPresetId: string;
	presets: RuntimePreset[];
}

export interface RuntimeModelOption {
	ref: string;
	provider: string;
	providerName: string;
	id: string;
	name: string;
}

export interface RuntimeModelsResponse {
	models: RuntimeModelOption[];
	recommendations: Record<RoleId, string | null>;
}

export interface ToolPolicy {
	include: string[];
	exclude: string[];
}

export interface ArtifactSpec {
	path: string;
	owner: RoleId;
	phase: WorkflowPhase;
	description: string;
	schema?: { required?: string[] };
	template?: string;
}

export interface RoleCapability {
	persona: string;
	responsibilities: string[];
	phasePrompts: Partial<Record<WorkflowPhase, string>>;
	skills: string[];
	toolPolicy: ToolPolicy;
	requiredArtifacts?: ArtifactSpec[];
	outputContract: string;
}

export interface RoleCapabilityConfig {
	roles: Partial<Record<RoleId, RoleCapability>>;
}

export interface CapabilityPreset {
	id: string;
	name: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	config: RoleCapabilityConfig;
}

export interface CapabilityPresetLibrary {
	version: 1;
	defaultPresetId: string;
	presets: CapabilityPreset[];
}

export interface WorkflowMemoryEntry {
	id: string;
	ts: string;
	scope: string;
	phase: WorkflowPhase;
	role: RoleId;
	type: string;
	text: string;
	refs: string[];
	tags: string[];
	importance: number;
}

export interface RoleCompletion {
	status: "done" | "failed" | "blocked";
	phase: WorkflowPhase;
	artifacts: string[];
	needsUserDecision: boolean;
	summary: string;
	refs: string[];
}

export interface CheckpointMetadata {
	name: string;
	phase: WorkflowPhase;
	commit: string | null;
	branch: string | null;
	createdAt: string;
	operator: string;
}
