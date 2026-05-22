import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	hasStructuredRequiredArtifacts,
	preparePhaseArtifacts,
	readArtifactManifest,
	validateRoleArtifacts,
} from "./artifacts.ts";
import { selectCapabilityPreset } from "./capability-presets.ts";
import { applyRollback, buildRollbackPlan, createCheckpoint, loadCheckpoint } from "./checkpoints.ts";
import { commitWorktreeIfDirty } from "./commits.ts";
import { readRoleCompletion, rememberCompletionDecision } from "./completion.ts";
import {
	ACTIVE_WORKFLOW_FILE,
	APPROVAL_TRANSITIONS,
	CHANNEL_MENTIONABLE_ROLES,
	isDecisionStatus,
	NEXT_TRANSITIONS,
	OPENPLAYBOOK_DIR,
	PHASE_CHANNEL_MAP,
	PHASE_MENTIONABLE_ROLES,
	REVIEW_PHASES,
} from "./constants.ts";
import { appendWorkflowMemory, ensureWorkflowMemory } from "./memory.ts";
import { adaptRuntimeConfigToAvailableModels, loadAvailableRuntimeModels } from "./runtime-models.ts";
import { createDefaultRuntimeConfig, selectRuntimePreset } from "./runtime-presets.ts";
import { appendJsonlAtomic, ensureDir, pathExists, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./storage.ts";
import type {
	ActiveWorkflowRef,
	BlockedState,
	ChannelId,
	ChannelMessage,
	CheckpointMetadata,
	CommandResult,
	ReviewGateResult,
	RoleCapabilityConfig,
	RoleCompletion,
	RoleId,
	RollbackPlan,
	StartWorkflowOptions,
	WorkflowPhase,
	WorkflowState,
} from "./types.ts";

export interface WorkflowPaths {
	projectRoot: string;
	openplaybookRoot: string;
	activeWorkflowFile: string;
	workflowDir: string;
	stateFile: string;
	channelsDir: string;
	inboxDir: string;
	tasksDir: string;
	artifactsDir: string;
	rolesDir: string;
	summariesDir: string;
	checkpointsDir: string;
	sessionsDir: string;
	memoryDir: string;
}

const CHANNEL_FILES: ChannelId[] = ["control", "requirements", "architecture", "planning", "development", "review"];
const TASK_DIRS = ["requirements", "architecture", "planning", "development", "review"] as const;
export const ROLE_LIST: RoleId[] = [
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

export function parseWorkflowName(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return undefined;
	return trimmed;
}

export function getWorkflowPaths(projectRoot: string, workflow: string): WorkflowPaths {
	const openplaybookRoot = join(projectRoot, OPENPLAYBOOK_DIR);
	const workflowDir = join(openplaybookRoot, workflow);
	return {
		projectRoot,
		openplaybookRoot,
		activeWorkflowFile: join(openplaybookRoot, ACTIVE_WORKFLOW_FILE),
		workflowDir,
		stateFile: join(workflowDir, "state.json"),
		channelsDir: join(workflowDir, "channels"),
		inboxDir: join(workflowDir, "inbox"),
		tasksDir: join(workflowDir, "tasks"),
		artifactsDir: join(workflowDir, "artifacts"),
		rolesDir: join(workflowDir, "roles"),
		summariesDir: join(workflowDir, "summaries"),
		checkpointsDir: join(workflowDir, "checkpoints"),
		sessionsDir: join(workflowDir, "sessions"),
		memoryDir: join(workflowDir, "memory"),
	};
}

function createDefaultState(workflow: string, displayName: string): WorkflowState {
	const roles = Object.fromEntries(
		ROLE_LIST.map((role) => [
			role,
			{
				sessionId: null,
				status: "not_started",
			},
		]),
	) as WorkflowState["roles"];
	return {
		workflow,
		displayName,
		status: "active",
		phase: "requirements_discussion",
		round: 1,
		currentMilestone: null,
		currentTask: null,
		awaitingUserApproval: false,
		blockedBy: null,
		roles,
		milestones: [],
	};
}

export async function loadActiveWorkflow(projectRoot: string): Promise<ActiveWorkflowRef | undefined> {
	const activeWorkflowFile = join(projectRoot, OPENPLAYBOOK_DIR, ACTIVE_WORKFLOW_FILE);
	return readJsonFile<ActiveWorkflowRef>(activeWorkflowFile);
}

export async function loadWorkflowState(projectRoot: string, workflow: string): Promise<WorkflowState | undefined> {
	const paths = getWorkflowPaths(projectRoot, workflow);
	return readJsonFile<WorkflowState>(paths.stateFile);
}

export async function saveActiveWorkflow(paths: WorkflowPaths, state: WorkflowState): Promise<void> {
	const now = new Date().toISOString();
	const existing = await readJsonFile<ActiveWorkflowRef>(paths.activeWorkflowFile);
	const createdAt = existing?.createdAt ?? now;
	const activeRef: ActiveWorkflowRef = {
		workflow: state.workflow,
		path: join(OPENPLAYBOOK_DIR, state.workflow).replace(/\\/g, "/"),
		status: state.status,
		phase: state.phase,
		createdAt,
		updatedAt: now,
	};
	await writeJsonAtomic(paths.activeWorkflowFile, activeRef);
}

export async function saveWorkflowState(paths: WorkflowPaths, state: WorkflowState): Promise<void> {
	await writeJsonAtomic(paths.stateFile, state);
	if (state.status === "active") {
		await saveActiveWorkflow(paths, state);
	}
}

export async function removeActiveWorkflowLock(paths: WorkflowPaths): Promise<void> {
	const emptyRef: ActiveWorkflowRef = {
		workflow: "",
		path: "",
		status: "archived",
		phase: "done",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeJsonAtomic(paths.activeWorkflowFile, emptyRef);
}

async function appendChannel(paths: WorkflowPaths, channel: ChannelId, message: ChannelMessage): Promise<void> {
	const channelPath = join(paths.channelsDir, `${channel}.jsonl`);
	await appendJsonlAtomic(channelPath, message);
}

export async function logControlMessage(
	paths: WorkflowPaths,
	text: string,
	type: ChannelMessage["type"] = "info",
	refs: string[] = [],
): Promise<void> {
	const message: ChannelMessage = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		channel: "control",
		from: "orchestrator",
		to: ["user"],
		type,
		text,
		refs,
	};
	await appendChannel(paths, "control", message);
}

async function initializeWorkflowLayout(paths: WorkflowPaths): Promise<void> {
	await ensureDir(paths.workflowDir);
	await ensureDir(paths.channelsDir);
	await ensureDir(paths.inboxDir);
	await ensureDir(paths.tasksDir);
	await ensureDir(paths.artifactsDir);
	await ensureDir(paths.rolesDir);
	await ensureDir(paths.summariesDir);
	await ensureDir(paths.checkpointsDir);
	await ensureDir(paths.sessionsDir);
	await ensureWorkflowMemory(paths);
	for (const taskDir of TASK_DIRS) {
		await ensureDir(join(paths.tasksDir, taskDir));
	}
	for (const role of ROLE_LIST) {
		await ensureDir(join(paths.sessionsDir, role));
	}
	for (const channel of CHANNEL_FILES) {
		const channelFile = join(paths.channelsDir, `${channel}.jsonl`);
		if (!(await pathExists(channelFile))) {
			await writeTextAtomic(channelFile, "");
		}
	}
	for (const role of ROLE_LIST) {
		const inboxFile = join(paths.inboxDir, `${role}.jsonl`);
		if (!(await pathExists(inboxFile))) {
			await writeTextAtomic(inboxFile, "");
		}
		const roleFile = join(paths.rolesDir, `${role}.json`);
		if (!(await pathExists(roleFile))) {
			await writeJsonAtomic(roleFile, {
				role,
				sessionId: null,
				status: "not_started",
			});
		}
	}
	const runtimeConfigFile = join(paths.rolesDir, "runtime-config.json");
	if (!(await pathExists(runtimeConfigFile))) {
		await writeJsonAtomic(runtimeConfigFile, createDefaultRuntimeConfig());
	}
}

export async function startWorkflow(
	projectRoot: string,
	workflow: string,
	options: StartWorkflowOptions = {},
): Promise<CommandResult> {
	const parsed = parseWorkflowName(workflow);
	if (!parsed) {
		return { ok: false, message: "Invalid workflow name. Use only letters, numbers, ., _, -." };
	}
	const active = await loadActiveWorkflow(projectRoot);
	if (active?.workflow && active.status === "active") {
		return {
			ok: false,
			message: `Active workflow '${active.workflow}' is still running. Close or complete it before starting a new one.`,
		};
	}
	const paths = getWorkflowPaths(projectRoot, parsed);
	if (await pathExists(paths.stateFile)) {
		return { ok: false, message: `Workflow '${parsed}' already exists. Refusing to overwrite existing state.` };
	}
	await ensureDir(paths.openplaybookRoot);
	const runtimeSelection = await selectRuntimePreset(options.agentDir, options.runtimePresetId);
	if ("ok" in runtimeSelection) return runtimeSelection;
	const capabilitySelection = await selectCapabilityPreset(options.agentDir, options.capabilityPresetId);
	if ("ok" in capabilitySelection) return capabilitySelection;
	const runtimeModels = options.runtimeModels ?? (await loadAvailableRuntimeModels(options.agentDir));
	const adaptedRuntimeConfig = adaptRuntimeConfigToAvailableModels(runtimeSelection.preset.config, runtimeModels);
	if ("ok" in adaptedRuntimeConfig) return adaptedRuntimeConfig;
	await initializeWorkflowLayout(paths);
	await writeJsonAtomic(join(paths.rolesDir, "runtime-config.json"), adaptedRuntimeConfig);
	await writeJsonAtomic(join(paths.rolesDir, "runtime-preset.json"), runtimeSelection.snapshot);
	await writeJsonAtomic(join(paths.rolesDir, "capability-config.json"), capabilitySelection.preset.config);
	await writeJsonAtomic(join(paths.rolesDir, "capability-preset.json"), capabilitySelection.snapshot);
	const displayName = options.displayName?.trim() || parsed;
	const state = createDefaultState(parsed, displayName);
	await preparePhaseArtifacts(
		paths,
		state,
		capabilitySelection.preset.config.roles,
		PHASE_MENTIONABLE_ROLES[state.phase] ?? [],
	);
	await saveWorkflowState(paths, state);
	await logControlMessage(
		paths,
		`Workflow '${parsed}' started at phase '${state.phase}' with runtime preset '${runtimeSelection.preset.id}' and capability preset '${capabilitySelection.preset.id}'.`,
	);
	return { ok: true, message: `Workflow '${parsed}' started.` };
}

export async function resolveActiveState(projectRoot: string): Promise<
	| {
			paths: WorkflowPaths;
			state: WorkflowState;
	  }
	| {
			error: CommandResult;
	  }
> {
	const active = await loadActiveWorkflow(projectRoot);
	if (!active?.workflow || active.status !== "active") {
		return { error: { ok: false, message: "No active workflow found." } };
	}
	const paths = getWorkflowPaths(projectRoot, active.workflow);
	const state = await readJsonFile<WorkflowState>(paths.stateFile);
	if (!state) {
		return { error: { ok: false, message: `Active workflow '${active.workflow}' has no readable state.json.` } };
	}
	return { paths, state };
}

function phaseSummary(state: WorkflowState): string {
	const blocked = state.blockedBy ? `blocked by ${state.blockedBy.source}: ${state.blockedBy.reason}` : "not blocked";
	return `workflow=${state.workflow}, status=${state.status}, phase=${state.phase}, currentTask=${state.currentTask ?? "none"}, currentMilestone=${state.currentMilestone ?? "none"}, awaitingUserApproval=${state.awaitingUserApproval}, ${blocked}`;
}

export async function statusWorkflow(projectRoot: string): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) {
		return resolved.error;
	}
	return { ok: true, message: phaseSummary(resolved.state) };
}

async function createTaskForPhase(paths: WorkflowPaths, state: WorkflowState): Promise<void> {
	const phase = state.phase;
	let taskDir = "requirements";
	if (phase.startsWith("architecture")) taskDir = "architecture";
	if (phase.startsWith("planning")) taskDir = "planning";
	if (phase.startsWith("development") || phase.startsWith("subtask") || phase.startsWith("milestone"))
		taskDir = "development";
	const taskFileName = `${phase}.md`;
	const taskPath = join(paths.tasksDir, taskDir, taskFileName);
	if (await pathExists(taskPath)) return;
	const now = new Date().toISOString();
	const content = [
		`# Task ${phase}`,
		"",
		`- workflow: ${state.workflow}`,
		`- phase: ${phase}`,
		`- createdAt: ${now}`,
		"",
		"## Objective",
		"Fill objective and outputs for this phase.",
		"",
		"## Inputs",
		"List referenced artifacts.",
		"",
		"## Outputs",
		"List expected artifacts and decision files.",
		"",
		"## Acceptance",
		"List acceptance criteria for this phase gate.",
		"",
	].join("\n");
	await writeTextAtomic(taskPath, content);
}

async function createSummaryForPhase(paths: WorkflowPaths, phase: WorkflowPhase, state: WorkflowState): Promise<void> {
	const summaryPath = join(paths.summariesDir, `${phase}.md`);
	if (await pathExists(summaryPath)) return;
	const content = [
		`# Summary ${phase}`,
		"",
		`- workflow: ${state.workflow}`,
		`- phase: ${phase}`,
		`- round: ${state.round}`,
		"",
		"## Goal",
		"To be filled after phase completion.",
		"",
		"## Key Decisions",
		"- None recorded yet.",
		"",
		"## Artifacts",
		"- None recorded yet.",
		"",
		"## Open Issues",
		"- None recorded yet.",
		"",
	].join("\n");
	await writeTextAtomic(summaryPath, content);
}

async function rememberPhaseSummary(paths: WorkflowPaths, phase: WorkflowPhase): Promise<void> {
	await appendWorkflowMemory(paths, {
		scope: phase.startsWith("architecture") ? "architecture-facts" : "implementation-notes",
		phase,
		role: "orchestrator",
		type: "phase_summary",
		text: `Phase '${phase}' produced summary ${join("summaries", `${phase}.md`)}.`,
		refs: [join("summaries", `${phase}.md`)],
		tags: ["phase-summary"],
		importance: 4,
	});
}

async function rememberGateBlocker(
	paths: WorkflowPaths,
	phase: WorkflowPhase,
	source: "review_gate" | "qa_gate",
	text: string,
	refs: string[],
): Promise<void> {
	await appendWorkflowMemory(paths, {
		scope: "implementation-notes",
		phase,
		role: source === "qa_gate" ? "qa_tester" : "code_reviewer",
		type: "blocker",
		text,
		refs,
		tags: [source, "blocker"],
		importance: 10,
	});
}

async function transitionToPhase(
	paths: WorkflowPaths,
	state: WorkflowState,
	nextPhase: WorkflowPhase,
	setAwaitingApproval: boolean,
): Promise<void> {
	const previousPhase = state.phase;
	await createSummaryForPhase(paths, previousPhase, state);
	await rememberPhaseSummary(paths, previousPhase);
	state.phase = nextPhase;
	state.awaitingUserApproval = setAwaitingApproval;
	state.blockedBy = null;
	await createTaskForPhase(paths, state);
	const capabilityConfig = await readCapabilityConfig(paths);
	await preparePhaseArtifacts(paths, state, capabilityConfig.roles, PHASE_MENTIONABLE_ROLES[state.phase] ?? []);
	await saveWorkflowState(paths, state);
	await logControlMessage(
		paths,
		`Phase changed from '${previousPhase}' to '${nextPhase}'. Details: tasks/${nextPhase}.md and summaries/${previousPhase}.md.`,
	);
}

/**
 * Pick the developer whose role state was updated most recently. Falls back to
 * `frontend_developer` if neither has been touched. Used to attribute auto-commits.
 */
async function pickRecentDeveloper(paths: WorkflowPaths, state: WorkflowState): Promise<RoleId> {
	const candidates: RoleId[] = ["frontend_developer", "backend_developer"];
	let best: { role: RoleId; ts: string } | undefined;
	for (const role of candidates) {
		const statusFile = join(paths.sessionsDir, role, "status.json");
		const status = await readJsonFile<{ lastUpdatedAt?: string }>(statusFile);
		const ts = status?.lastUpdatedAt;
		if (!ts) continue;
		if (!best || ts > best.ts) best = { role, ts };
	}
	if (best) return best.role;
	void state;
	return "frontend_developer";
}

async function readReviewDecision(paths: WorkflowPaths, decisionFile: string): Promise<ReviewGateResult | undefined> {
	const absolute = join(paths.workflowDir, decisionFile);
	try {
		const raw = await readFile(absolute, "utf8");
		const parsed = JSON.parse(raw) as Partial<ReviewGateResult>;
		if (!parsed.status || !isDecisionStatus(parsed.status)) return undefined;
		return {
			status: parsed.status,
			blockingIssues: parsed.blockingIssues ?? [],
			requiredFixes: parsed.requiredFixes ?? [],
			refs: parsed.refs ?? [],
		};
	} catch {
		return undefined;
	}
}

async function readCapabilityConfig(paths: WorkflowPaths): Promise<RoleCapabilityConfig> {
	return (await readJsonFile<RoleCapabilityConfig>(join(paths.rolesDir, "capability-config.json"))) ?? { roles: {} };
}

async function validatePhaseRequiredArtifacts(
	paths: WorkflowPaths,
	state: WorkflowState,
	capabilityConfig: RoleCapabilityConfig,
): Promise<CommandResult | undefined> {
	const roles = PHASE_MENTIONABLE_ROLES[state.phase] ?? [];
	const results = await Promise.all(
		roles.map((role) => validateRoleArtifacts(paths, state, role, capabilityConfig.roles[role])),
	);
	const missing = results.flatMap((result) => result.missingArtifacts.map((path) => `${result.role}: ${path}`));
	if (missing.length > 0) {
		return {
			ok: false,
			message: `Missing required artifacts before leaving '${state.phase}': ${missing.join(", ")}`,
		};
	}
	const invalid = results.flatMap((result) =>
		result.invalidArtifacts.map((artifact) => `${result.role}: ${artifact.path} (${artifact.reason})`),
	);
	if (invalid.length > 0) {
		return {
			ok: false,
			message: `Invalid required artifacts before leaving '${state.phase}': ${invalid.join(", ")}`,
		};
	}
	return undefined;
}

async function validatePhaseRoleCompletions(
	paths: WorkflowPaths,
	state: WorkflowState,
	capabilityConfig: RoleCapabilityConfig,
): Promise<CommandResult | undefined> {
	const roles = (PHASE_MENTIONABLE_ROLES[state.phase] ?? []).filter((role) =>
		hasStructuredRequiredArtifacts(capabilityConfig.roles[role]),
	);
	for (const role of roles) {
		const completion = await readRoleCompletion(paths, role, state.phase);
		if (!completion) {
			return {
				ok: false,
				message: `Missing role completion before leaving '${state.phase}': ${role} must write sessions/${role}/completion.json.`,
			};
		}
		if (completion.needsUserDecision) {
			state.phase = "blocked";
			state.awaitingUserApproval = true;
			state.blockedBy = {
				reason: completion.summary,
				source: "system",
				resumePhaseOnApprove: completion.phase,
			};
			await saveWorkflowState(paths, state);
			await rememberCompletionDecision(paths, role, completion);
			await logControlMessage(
				paths,
				`Role @${role} requires user decision: ${completion.summary}`,
				"info",
				completion.refs,
			);
			return {
				ok: true,
				message: `Role @${role} requires user decision. Workflow moved to blocked.`,
			};
		}
		if (completion.status !== "done") {
			return {
				ok: false,
				message: `Role @${role} completion is '${completion.status}' before leaving '${state.phase}'.`,
			};
		}
	}
	return undefined;
}

export async function nextWorkflow(projectRoot: string): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return resolved.error;
	const { paths, state } = resolved;
	if (state.status !== "active") {
		return { ok: false, message: `Workflow is not active (status=${state.status}).` };
	}
	if (state.awaitingUserApproval) {
		return { ok: false, message: `Phase '${state.phase}' is awaiting user approval. Use /opb approve.` };
	}
	if (state.phase === "blocked") {
		return { ok: false, message: "Workflow is blocked. Use /opb approve or /opb revise after resolving blockers." };
	}

	const capabilityConfig = await readCapabilityConfig(paths);
	const artifactGate = await validatePhaseRequiredArtifacts(paths, state, capabilityConfig);
	if (artifactGate) return artifactGate;
	const completionGate = await validatePhaseRoleCompletions(paths, state, capabilityConfig);
	if (completionGate) return completionGate;

	const reviewPhase = REVIEW_PHASES[state.phase];
	if (reviewPhase) {
		const reviewPhaseName = state.phase;
		const decision = await readReviewDecision(paths, reviewPhase.decisionFile);
		if (!decision) {
			return {
				ok: false,
				message: `Missing or invalid review decision file: ${reviewPhase.decisionFile}.`,
			};
		}
		const gateSource = reviewPhaseName === "subtask_qa" ? "qa_gate" : "review_gate";
		if (decision.status === "approved") {
			const approvalPhase = reviewPhase.onApproved;
			const requiresUserApproval = approvalPhase.endsWith("_approval");
			if (reviewPhaseName === "subtask_qa") {
				const author = await pickRecentDeveloper(paths, state);
				const commitMessage = `subtask(${author}): qa passed for ${state.workflow}`;
				const result = await commitWorktreeIfDirty(paths.projectRoot, {
					role: author,
					phase: "subtask_qa",
					message: commitMessage,
				});
				if (result.committed) {
					await logControlMessage(
						paths,
						`Auto-committed subtask changes as @${author} (${result.commit?.slice(0, 7)}).`,
					);
				} else if (result.reason && result.reason !== "clean") {
					await logControlMessage(paths, `Auto-commit on subtask QA skipped: ${result.reason}.`, "info");
				}
			}
			await transitionToPhase(paths, state, approvalPhase, requiresUserApproval);
			return { ok: true, message: `Review approved. Entered '${approvalPhase}'.` };
		}
		if (decision.status === "rejected") {
			state.blockedBy = {
				reason: `Review rejected (${reviewPhaseName}).`,
				source: gateSource,
			};
			await saveWorkflowState(paths, state);
			await rememberGateBlocker(
				paths,
				reviewPhaseName,
				gateSource,
				`Review rejected in '${reviewPhaseName}'.`,
				decision.refs ?? [],
			);
			await logControlMessage(
				paths,
				`Review rejected in '${reviewPhaseName}'. Returned for fixes.`,
				"error",
				decision.refs ?? [],
			);
			return {
				ok: false,
				message: `Review rejected in '${reviewPhaseName}'. Apply fixes and update ${reviewPhase.decisionFile}.`,
			};
		}
		state.phase = "blocked";
		state.awaitingUserApproval = true;
		state.blockedBy = {
			reason: `User decision required from ${reviewPhaseName}.`,
			source: gateSource,
			resumePhaseOnApprove: reviewPhase.onApproved,
		};
		await saveWorkflowState(paths, state);
		await rememberGateBlocker(
			paths,
			reviewPhaseName,
			gateSource,
			`User decision required from '${reviewPhaseName}'.`,
			decision.refs ?? [],
		);
		await logControlMessage(
			paths,
			`Review requires user decision from '${reviewPhaseName}'.`,
			"info",
			decision.refs ?? [],
		);
		return { ok: true, message: "Review requires user decision. Workflow moved to blocked." };
	}

	const nextPhase = NEXT_TRANSITIONS[state.phase];
	if (!nextPhase) {
		return { ok: false, message: `No automatic transition from phase '${state.phase}'.` };
	}
	const requiresApproval = nextPhase.endsWith("_approval");
	await transitionToPhase(paths, state, nextPhase, requiresApproval);
	return { ok: true, message: `Moved to '${nextPhase}'.` };
}

export async function approveWorkflow(projectRoot: string): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return resolved.error;
	const { paths, state } = resolved;
	if (state.status !== "active") {
		return { ok: false, message: `Workflow is not active (status=${state.status}).` };
	}
	if (state.phase === "blocked") {
		const resumePhase = state.blockedBy?.resumePhaseOnApprove;
		if (!resumePhase) {
			return { ok: false, message: "Blocked workflow cannot be approved without a resume phase." };
		}
		await transitionToPhase(paths, state, resumePhase, resumePhase.endsWith("_approval"));
		return { ok: true, message: `Workflow unblocked and moved to '${resumePhase}'.` };
	}
	const nextPhase = APPROVAL_TRANSITIONS[state.phase];
	if (!nextPhase) {
		return { ok: false, message: `Phase '${state.phase}' is not an approval gate.` };
	}
	if (!state.awaitingUserApproval) {
		return { ok: false, message: `Phase '${state.phase}' is not currently awaiting approval.` };
	}
	if (state.phase === "milestone_approval") {
		const commitMessage = `milestone(orchestrator): ${state.workflow}`;
		const result = await commitWorktreeIfDirty(paths.projectRoot, {
			role: "orchestrator",
			phase: "milestone_approval",
			message: commitMessage,
		});
		if (result.committed) {
			await logControlMessage(paths, `Auto-committed milestone as @orchestrator (${result.commit?.slice(0, 7)}).`);
		} else if (result.reason && result.reason !== "clean") {
			await logControlMessage(paths, `Auto-commit on milestone approval skipped: ${result.reason}.`, "info");
		}
	}
	const checkpointName = `${state.phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	await createCheckpoint(paths, state, checkpointName, "user");
	await transitionToPhase(paths, state, nextPhase, false);
	if (nextPhase === "done") {
		state.status = "completed";
		state.awaitingUserApproval = false;
		await saveWorkflowState(paths, state);
		await removeActiveWorkflowLock(paths);
		await logControlMessage(paths, `Workflow '${state.workflow}' completed.`);
	}
	return { ok: true, message: `Approved '${state.phase}', moved to '${nextPhase}'.` };
}

export async function reviseWorkflow(projectRoot: string, reason: string): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return resolved.error;
	const { paths, state } = resolved;
	if (!reason.trim()) {
		return { ok: false, message: "Revision reason is required." };
	}
	const blockedState: BlockedState = {
		reason: reason.trim(),
		source: "user_revise",
	};
	state.phase = "blocked";
	state.awaitingUserApproval = true;
	state.blockedBy = blockedState;
	await saveWorkflowState(paths, state);
	await logControlMessage(paths, `Workflow revised by user: ${reason.trim()}`, "info");
	return { ok: true, message: "Workflow moved to blocked with user revision reason." };
}

export async function closeWorkflow(projectRoot: string): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return resolved.error;
	const { paths, state } = resolved;
	state.status = "closed";
	state.awaitingUserApproval = false;
	state.blockedBy = null;
	await saveWorkflowState(paths, state);
	await removeActiveWorkflowLock(paths);
	await logControlMessage(paths, `Workflow '${state.workflow}' closed.`);
	return { ok: true, message: `Workflow '${state.workflow}' closed.` };
}

export async function routePhaseMessage(
	projectRoot: string,
	roleTag: string,
	messageBody: string,
	channelOverride?: ChannelId,
): Promise<CommandResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return resolved.error;
	const { paths, state } = resolved;
	if (state.status !== "active") {
		return { ok: false, message: `Workflow is not active (status=${state.status}).` };
	}
	if (state.phase === "blocked" || state.phase === "done") {
		return { ok: false, message: `Phase '${state.phase}' does not accept role mentions.` };
	}
	const roleId = roleTag.startsWith("@") ? roleTag.slice(1) : roleTag;
	const isKnownRole = ROLE_LIST.includes(roleId as RoleId);
	if (!isKnownRole) {
		return { ok: false, message: `Unknown role '${roleId}'.` };
	}
	const channel: ChannelId = channelOverride ?? PHASE_CHANNEL_MAP[state.phase];
	const phaseAllowed = PHASE_MENTIONABLE_ROLES[state.phase] ?? [];
	const channelAllowed = CHANNEL_MENTIONABLE_ROLES[channel] ?? [];
	const allowedRoles = new Set<RoleId>([...phaseAllowed, ...channelAllowed]);
	if (!allowedRoles.has(roleId as RoleId)) {
		return {
			ok: false,
			message: `Role '${roleId}' is not mentionable in phase '${state.phase}' on channel '${channel}'.`,
		};
	}
	if (!messageBody.trim()) {
		return { ok: false, message: "Message content is required." };
	}
	const message: ChannelMessage = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		channel,
		from: "user",
		to: [roleId],
		type: "user_message",
		text: `@${roleId} ${messageBody.trim()}`,
		refs: [],
	};
	await appendChannel(paths, channel, message);
	await appendJsonlAtomic(join(paths.inboxDir, `${roleId}.jsonl`), message);
	await logControlMessage(paths, `User message routed to @${roleId} in channel '${channel}'.`);
	return { ok: true, message: `Message sent to @${roleId} in ${channel}.` };
}

export interface RollbackPreviewResult {
	result: CommandResult;
	plan?: RollbackPlan;
	checkpoint?: CheckpointMetadata;
}

export async function rollbackWorkflow(
	projectRoot: string,
	checkpointName: string,
	confirm: boolean,
	operator = "user",
): Promise<RollbackPreviewResult> {
	const resolved = await resolveActiveState(projectRoot);
	if ("error" in resolved) return { result: resolved.error };
	const { paths } = resolved;
	if (!checkpointName.trim()) {
		return { result: { ok: false, message: "Checkpoint name is required." } };
	}
	const checkpoint = await loadCheckpoint(paths, checkpointName.trim());
	if (!checkpoint) {
		return { result: { ok: false, message: `Checkpoint '${checkpointName.trim()}' not found.` } };
	}
	const plan = await buildRollbackPlan(paths, checkpoint);
	if (!confirm) {
		return {
			result: {
				ok: true,
				message: `Rollback plan ready for '${checkpoint.name}'. Re-run with --confirm to apply.`,
			},
			plan,
			checkpoint,
		};
	}
	const applied = await applyRollback(paths, checkpoint, operator);
	return {
		result: applied,
		plan,
		checkpoint,
	};
}

export async function listWorkflowArtifacts(projectRoot: string, workflow: string) {
	const paths = getWorkflowPaths(projectRoot, workflow);
	return readArtifactManifest(paths);
}

export async function listWorkflowCheckpoints(projectRoot: string, workflow: string): Promise<CheckpointMetadata[]> {
	const paths = getWorkflowPaths(projectRoot, workflow);
	if (!(await pathExists(paths.checkpointsDir))) return [];
	const files = (await readdir(paths.checkpointsDir)).filter((file) => file.endsWith(".json")).sort();
	const checkpoints: CheckpointMetadata[] = [];
	for (const file of files) {
		const checkpoint = await loadCheckpoint(paths, file.replace(/\.json$/, ""));
		if (checkpoint) checkpoints.push(checkpoint);
	}
	return checkpoints;
}

export async function readWorkflowRoleCompletion(
	projectRoot: string,
	workflow: string,
	role: RoleId,
): Promise<RoleCompletion | undefined> {
	const paths = getWorkflowPaths(projectRoot, workflow);
	const state = await loadWorkflowState(projectRoot, workflow);
	if (!state) return undefined;
	return readRoleCompletion(paths, role, state.phase);
}
