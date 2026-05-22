import { join } from "node:path";
import { expandRequiredArtifacts } from "./artifacts.ts";
import { createDefaultCapabilityConfig } from "./capability-presets.ts";
import { searchWorkflowMemory } from "./memory.ts";
import { readJsonFile, readJsonlFile, writeJsonAtomic } from "./storage.ts";
import type {
	BootstrapContext,
	BootstrapContextSection,
	RoleCapability,
	RoleContextPolicy,
	RoleId,
	RoleSessionEvent,
	RoleSummary,
	ToolDefinition,
	WorkflowState,
} from "./types.ts";
import type { WorkflowPaths } from "./workflow.ts";

const DEFAULT_CONTEXT_POLICY: RoleContextPolicy = {
	maxBootstrapTokens: 1600,
	maxRecentMessages: 6,
	includeArtifacts: "refs_only",
	memoryScopes: ["decisions", "user-preferences", "architecture-facts", "implementation-notes", "role-lessons"],
};

export function defaultContextPolicy(policy?: Partial<RoleContextPolicy>): RoleContextPolicy {
	return {
		maxBootstrapTokens: policy?.maxBootstrapTokens ?? DEFAULT_CONTEXT_POLICY.maxBootstrapTokens,
		maxRecentMessages: policy?.maxRecentMessages ?? DEFAULT_CONTEXT_POLICY.maxRecentMessages,
		includeArtifacts: policy?.includeArtifacts ?? DEFAULT_CONTEXT_POLICY.includeArtifacts,
		memoryScopes: policy?.memoryScopes ?? DEFAULT_CONTEXT_POLICY.memoryScopes,
	};
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 5);
}

function phaseTaskPath(paths: WorkflowPaths, phase: WorkflowState["phase"]): string {
	let taskDir = "requirements";
	if (phase.startsWith("architecture")) taskDir = "architecture";
	if (phase.startsWith("planning")) taskDir = "planning";
	if (phase.startsWith("development") || phase.startsWith("subtask") || phase.startsWith("milestone")) {
		taskDir = "development";
	}
	return join(paths.tasksDir, taskDir, `${phase}.md`);
}

function renderList(items: string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function renderSection(name: string, content: string, included = true, trimmed = false): BootstrapContextSection {
	return { name, content, included, trimmed };
}

function renderPrompt(sections: BootstrapContextSection[]): string {
	return sections
		.filter((section) => section.included)
		.map((section) => section.content)
		.join("\n\n");
}

function trimSectionContent(content: string, maxCharacters: number): string {
	if (content.length <= maxCharacters) return content;
	const keep = Math.max(0, maxCharacters - 44);
	return `${content.slice(0, keep).trimEnd()}\n[trimmed for context budget]`;
}

async function readRoleSummary(paths: WorkflowPaths, role: RoleId): Promise<RoleSummary | undefined> {
	return readJsonFile<RoleSummary>(join(paths.sessionsDir, role, "summary.json"));
}

async function readRecentTranscript(
	paths: WorkflowPaths,
	role: RoleId,
	maxRecentMessages: number,
): Promise<RoleSessionEvent[]> {
	if (maxRecentMessages <= 0) return [];
	const events = await readJsonlFile<RoleSessionEvent>(join(paths.sessionsDir, role, "transcript.jsonl"));
	return events.slice(-maxRecentMessages);
}

async function writeBootstrapContext(paths: WorkflowPaths, role: RoleId, context: BootstrapContext): Promise<void> {
	await writeJsonAtomic(join(paths.sessionsDir, role, "bootstrap-context.json"), context);
}

export async function buildRoleBootstrapContext(options: {
	paths: WorkflowPaths;
	role: RoleId;
	state: WorkflowState;
	capability: RoleCapability | undefined;
	tools: string[] | undefined;
	deniedTools?: string[];
	toolDefinitions?: Record<string, ToolDefinition>;
}): Promise<BootstrapContext> {
	const { paths, role, state, tools } = options;
	const capability = options.capability ?? createDefaultCapabilityConfig().roles[role];
	const policy = defaultContextPolicy(capability?.contextPolicy);
	const phasePrompt = capability?.phasePrompts[state.phase] ?? "Work on the current phase task assigned to this role.";
	const requiredArtifacts = expandRequiredArtifacts(capability, state, role);
	const summary = await readRoleSummary(paths, role);
	const relevantMemory = await searchWorkflowMemory(paths, {
		role,
		phase: state.phase,
		scopes: policy.memoryScopes,
		limit: 8,
	});
	const recentTranscript = await readRecentTranscript(paths, role, policy.maxRecentMessages);

	const sections: BootstrapContextSection[] = [
		renderSection(
			"identity",
			[
				`# OpenPlayBook Role Bootstrap: ${role}`,
				"",
				`Persona: ${capability?.persona ?? role}`,
				"",
				"Responsibilities:",
				renderList(capability?.responsibilities ?? []),
			].join("\n"),
		),
		renderSection(
			"phase",
			[
				`Current phase: ${state.phase}`,
				`Task file: ${phaseTaskPath(paths, state.phase)}`,
				`Phase prompt: ${phasePrompt}`,
			].join("\n"),
		),
		renderSection(
			"roleSummary",
			[
				"Role Summary:",
				`- Current task: ${summary?.currentTask ?? `Work on ${state.phase}`}`,
				`- Completed artifacts: ${(summary?.completedArtifacts ?? []).join(", ") || "none"}`,
				`- Key decisions: ${(summary?.decisions ?? []).join("; ") || "none"}`,
				`- Blockers: ${(summary?.blockers ?? []).join("; ") || "none"}`,
				`- Next steps: ${(summary?.nextSteps ?? [`Continue ${state.phase}`]).join("; ")}`,
			].join("\n"),
		),
		renderSection(
			"memory",
			[
				"Relevant Memory:",
				...(relevantMemory.length > 0
					? relevantMemory.map(
							(item) => `- [${item.scope}/${item.type}] ${item.text} refs=${item.refs.join(",") || "none"}`,
						)
					: ["- none"]),
			].join("\n"),
		),
		renderSection(
			"recentTranscript",
			[
				"Recent Transcript Summary:",
				...(recentTranscript.length > 0 ? recentTranscript.map((event) => `- ${event.summary}`) : ["- none"]),
			].join("\n"),
		),
		renderSection("skills", ["Skills to follow:", renderList(capability?.skills ?? [])].join("\n")),
		renderSection(
			"tools",
			[
				"Tool Use Contract:",
				"Allowed tools:",
				renderList(tools ?? []),
				`Denied tools: ${(options.deniedTools ?? []).join(", ") || "none"}`,
				"",
				"Tool definitions:",
				...(tools ?? []).flatMap((tool) => {
					const definition = options.toolDefinitions?.[tool];
					if (!definition) return [];
					return [
						`- ${tool}: ${definition.description}`,
						`  category=${definition.category} risk=${definition.riskLevel}`,
						`  usage=${definition.usage}`,
					];
				}),
			].join("\n"),
		),
		renderSection("artifacts", ["Required output files:", renderList(requiredArtifacts)].join("\n")),
		renderSection(
			"completion",
			[
				"Completion signal:",
				`- When this role's current task is complete, write sessions/${role}/completion.json.`,
				"- Use status done, failed, or blocked.",
				"- Set needsUserDecision true only when the user must choose before work can continue.",
			].join("\n"),
		),
		renderSection(
			"rules",
			[
				"Communication rules:",
				"- Keep channel handoff messages short.",
				"- Put detailed work in files and role transcript artifacts.",
				"- Ask the user only when a decision is required.",
				"- Treat artifact bodies as refs unless the task explicitly requires reading them.",
				"",
				`Output contract: ${capability?.outputContract ?? "Write concise notes with file refs."}`,
			].join("\n"),
		),
	];

	const trimmedSections: string[] = [];
	let prompt = renderPrompt(sections);
	while (estimateTokens(prompt) > policy.maxBootstrapTokens) {
		const transcript = sections.find((section) => section.name === "recentTranscript" && section.included);
		if (transcript && !transcript.trimmed) {
			transcript.content = "Recent Transcript Summary:\n- omitted for context budget; full transcript is on disk.";
			transcript.trimmed = true;
			trimmedSections.push("recentTranscript");
			prompt = renderPrompt(sections);
			continue;
		}
		const memory = sections.find((section) => section.name === "memory" && section.included);
		if (memory && !memory.trimmed) {
			const remainingCharacters = Math.max(
				120,
				policy.maxBootstrapTokens * 4 - prompt.length + memory.content.length,
			);
			memory.content = trimSectionContent(memory.content, remainingCharacters);
			memory.trimmed = true;
			trimmedSections.push("memory");
			prompt = renderPrompt(sections);
			continue;
		}
		const optional = sections.find(
			(section) =>
				["roleSummary", "skills", "tools", "completion", "rules"].includes(section.name) &&
				section.included &&
				!section.trimmed,
		);
		if (optional) {
			optional.content = `${optional.name}: omitted for context budget.`;
			optional.trimmed = true;
			trimmedSections.push(optional.name);
			prompt = renderPrompt(sections);
			continue;
		}
		const identity = sections.find((section) => section.name === "identity" && !section.trimmed);
		if (identity) {
			identity.content = [`# OpenPlayBook Role Bootstrap: ${role}`, `Persona: ${capability?.persona ?? role}`].join(
				"\n",
			);
			identity.trimmed = true;
			trimmedSections.push("identity");
			prompt = renderPrompt(sections);
			continue;
		}
		const phase = sections.find((section) => section.name === "phase" && !section.trimmed);
		if (phase) {
			phase.content = [`Current phase: ${state.phase}`, `Task file: ${phaseTaskPath(paths, state.phase)}`].join(
				"\n",
			);
			phase.trimmed = true;
			trimmedSections.push("phase");
			prompt = renderPrompt(sections);
			continue;
		}
		break;
	}
	const context: BootstrapContext = {
		role,
		phase: state.phase,
		policy,
		estimatedTokens: estimateTokens(prompt),
		trimmedSections,
		sections,
		prompt,
	};
	await writeBootstrapContext(paths, role, context);
	return context;
}
