export const WORKFLOW_STATUSES = ["active", "completed", "closed", "failed", "archived"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_PHASES = [
	"draft",
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
	"blocked",
] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const REVIEW_DECISIONS = ["approved", "rejected", "needs_user_decision"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const ROLE_IDS = [
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
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const CHANNEL_IDS = ["control", "requirements", "architecture", "planning", "development", "review"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const ROLE_RUNTIME_STATUSES = [
	"not_started",
	"starting",
	"running",
	"waiting",
	"idle",
	"done",
	"failed",
	"stopped",
] as const;
export type RoleRuntimeStatus = (typeof ROLE_RUNTIME_STATUSES)[number];

export interface RoleRuntimeState {
	sessionId: string | null;
	status: RoleRuntimeStatus;
}

export interface MilestoneState {
	id: string;
	status: "pending" | "in_progress" | "done" | "blocked";
	tasks: string[];
}

export interface BlockedState {
	reason: string;
	source: "user_revise" | "review_gate" | "qa_gate" | "system";
	resumePhaseOnApprove?: WorkflowPhase;
}

export interface WorkflowState {
	workflow: string;
	displayName: string;
	status: WorkflowStatus;
	phase: WorkflowPhase;
	round: number;
	currentMilestone: string | null;
	currentTask: string | null;
	awaitingUserApproval: boolean;
	blockedBy: BlockedState | null;
	roles: Record<RoleId, RoleRuntimeState>;
	milestones: MilestoneState[];
}

export interface RoleSessionState extends RoleRuntimeState {
	role: RoleId;
	phase: WorkflowPhase | null;
	lastUpdatedAt: string;
	lastError: string | null;
	model: string | null;
}

export interface RoleModelAssignment {
	model: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
}

export interface RoleRuntimeConfig {
	mode: "mock" | "real";
	defaultModel: string | null;
	roles: Partial<Record<RoleId, RoleModelAssignment>>;
}

export interface RuntimeModelOption {
	ref: string;
	provider: string;
	providerName: string;
	id: string;
	name: string;
}

export interface OpenPlaybookApiRuntimeModelsResponse {
	models: RuntimeModelOption[];
	recommendations: Record<RoleId, string | null>;
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

export interface RuntimePresetSnapshot {
	presetId: string;
	name: string;
	selectedAt: string;
	configHash: string;
}

export const TOOL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export interface ToolPolicy {
	include: string[];
	exclude: string[];
}

export interface ToolDefinition {
	description: string;
	category: string;
	riskLevel: ToolRiskLevel;
	usage: string;
	phases?: WorkflowPhase[];
	roles?: RoleId[];
}

export interface ArtifactSchema {
	required?: string[];
}

export interface ArtifactSpec {
	path: string;
	owner: RoleId;
	phase: WorkflowPhase;
	description: string;
	schema?: ArtifactSchema;
	template?: string;
	optional?: boolean;
}

export type ArtifactStatus = "missing" | "valid" | "invalid" | "optional";

export interface ArtifactManifestItem {
	path: string;
	owner: RoleId;
	phase: WorkflowPhase;
	description: string;
	status: ArtifactStatus;
	optional: boolean;
	refs: string[];
	validation?: string;
	updatedAt: string;
}

export interface ArtifactManifest {
	version: 1;
	items: ArtifactManifestItem[];
}

export interface RoleCompletion {
	status: "done" | "failed" | "blocked";
	phase: WorkflowPhase;
	artifacts: string[];
	needsUserDecision: boolean;
	summary: string;
	refs: string[];
}

export interface PhaseConvergenceResult {
	ok: boolean;
	phase: WorkflowPhase;
	blockers: string[];
	refs: string[];
}

export interface DogfoodRunReport {
	scenario: string;
	runtimePresetId: string;
	capabilityPresetId: string;
	result: "not_run" | "passed" | "failed";
	manualInterventionPoints: string[];
}

export interface RoleCapability {
	persona: string;
	responsibilities: string[];
	phasePrompts: Partial<Record<WorkflowPhase, string>>;
	skills: string[];
	toolPolicy: ToolPolicy;
	requiredArtifacts?: ArtifactSpec[];
	optionalArtifacts?: ArtifactSpec[];
	artifactTemplates?: Record<string, string>;
	contextPolicy?: RoleContextPolicy;
	outputContract: string;
}

export const MEMORY_SCOPES = [
	"decisions",
	"user-preferences",
	"architecture-facts",
	"implementation-notes",
	"role-lessons",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const ARTIFACT_CONTEXT_MODES = ["refs_only", "summary", "inline"] as const;
export type ArtifactContextMode = (typeof ARTIFACT_CONTEXT_MODES)[number];

export interface RoleContextPolicy {
	maxBootstrapTokens: number;
	maxRecentMessages: number;
	includeArtifacts: ArtifactContextMode;
	memoryScopes: MemoryScope[];
}

export interface WorkflowMemoryEntry {
	id: string;
	ts: string;
	scope: MemoryScope;
	phase: WorkflowPhase;
	role: RoleId;
	type: string;
	text: string;
	refs: string[];
	tags: string[];
	importance: number;
}

export interface WorkflowMemoryInput {
	scope: MemoryScope;
	phase: WorkflowPhase;
	role: RoleId;
	type: string;
	text: string;
	refs?: string[];
	tags?: string[];
	importance?: number;
}

export interface WorkflowMemorySearch {
	role?: RoleId;
	phase?: WorkflowPhase;
	scopes?: MemoryScope[];
	tags?: string[];
	limit?: number;
}

export interface RoleSummary {
	role: RoleId;
	phase: WorkflowPhase;
	currentTask: string;
	completedArtifacts: string[];
	decisions: string[];
	blockers: string[];
	nextSteps: string[];
	updatedAt: string;
}

export interface BootstrapContextSection {
	name: string;
	included: boolean;
	trimmed: boolean;
	content: string;
}

export interface BootstrapContext {
	role: RoleId;
	phase: WorkflowPhase;
	policy: RoleContextPolicy;
	estimatedTokens: number;
	trimmedSections: string[];
	sections: BootstrapContextSection[];
	prompt: string;
}

export interface RoleArtifactGateResult {
	ok: boolean;
	role: RoleId;
	requiredArtifacts: string[];
	missingArtifacts: string[];
	invalidArtifacts: Array<{ path: string; reason: string }>;
	manifestItems?: ArtifactManifestItem[];
}

export interface RoleCapabilityConfig {
	roles: Partial<Record<RoleId, RoleCapability>>;
	toolDefinitions?: Record<string, ToolDefinition>;
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

export interface CapabilityPresetSnapshot {
	presetId: string;
	name: string;
	selectedAt: string;
	configHash: string;
}

export interface StartWorkflowOptions {
	displayName?: string;
	runtimePresetId?: string;
	capabilityPresetId?: string;
	agentDir?: string;
	runtimeModels?: RuntimeModelOption[];
}

export interface ActiveWorkflowRef {
	workflow: string;
	path: string;
	status: WorkflowStatus;
	phase: WorkflowPhase;
	createdAt: string;
	updatedAt: string;
}

export interface ChannelMessage {
	id: string;
	ts: string;
	channel: ChannelId;
	from: string;
	to: string[];
	type: "info" | "error" | "task_assigned" | "artifact_ready" | "user_message" | "role_message" | "system";
	text: string;
	refs: string[];
}

export interface ReviewGateResult {
	status: ReviewDecision;
	blockingIssues?: string[];
	requiredFixes?: string[];
	refs?: string[];
}

export interface CommandRuntimeContext {
	cwd: string;
	hasUI: boolean;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
}

export interface CommandResult {
	ok: boolean;
	message: string;
}

export type WorkflowActionType = "approve" | "revise" | "next" | "close";

export interface OpenPlaybookApiWorkflowItem {
	id: string;
	displayName: string;
	status: WorkflowStatus;
	phase: WorkflowPhase;
	active: boolean;
	updatedAt: string;
}

export interface OpenPlaybookApiWorkflowsResponse {
	activeWorkflowId: string | null;
	workflows: OpenPlaybookApiWorkflowItem[];
}

export interface OpenPlaybookApiChannelPageResponse {
	channel: ChannelId;
	items: ChannelMessage[];
	nextCursor: number | null;
	total: number;
}

export interface RoleSessionEvent {
	id: string;
	ts: string;
	role: RoleId;
	kind: "transcript" | "tool" | "system";
	summary: string;
}

export interface OpenPlaybookApiRoleResponse {
	role: RoleId;
	state: RoleSessionState;
	transcript: RoleSessionEvent[];
	toolEvents: RoleSessionEvent[];
	artifacts: string[];
}

export interface OpenPlaybookApiMemoryResponse {
	items: WorkflowMemoryEntry[];
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

export interface OpenPlaybookApiActionRequest {
	action: WorkflowActionType;
	reason?: string;
}

export interface OpenPlaybookApiMessageRequest {
	message: string;
}

export interface OpenPlaybookApiCreateWorkflowRequest {
	id: string;
	displayName?: string;
	runtimePresetId?: string;
	capabilityPresetId?: string;
}

export interface CheckpointMetadata {
	name: string;
	phase: WorkflowPhase;
	commit: string | null;
	branch: string | null;
	stateSnapshot: WorkflowState;
	createdAt: string;
	operator: string;
}

export interface RollbackPlan {
	checkpoint: string;
	phase: WorkflowPhase;
	commit: string | null;
	branch: string | null;
	requiresCleanWorktree: boolean;
	gitActions: string[];
	stateAction: string;
}

export interface RedactionRule {
	pattern: string;
	replacement: string;
	enabled: boolean;
}
