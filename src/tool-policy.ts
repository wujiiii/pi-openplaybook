import type { RoleCapability, RoleId, ToolDefinition, WorkflowPhase } from "./types.ts";

const TOOL_PATTERN = /^[a-zA-Z0-9_.:-]+(?:\*)?$/;

export interface ResolvedToolPolicy {
	allowed: string[];
	denied: string[];
	definitions: Record<string, ToolDefinition>;
	configured: boolean;
}

function unique(items: string[]): string[] {
	return [...new Set(items)];
}

function isWildcard(pattern: string): boolean {
	return pattern.endsWith("*");
}

function matchesPattern(pattern: string, candidate: string): boolean {
	if (!isWildcard(pattern)) return pattern === candidate;
	return candidate.startsWith(pattern.slice(0, -1));
}

function isToolDefinitionInScope(definition: ToolDefinition, role: RoleId, phase: WorkflowPhase): boolean {
	const roleAllowed = !definition.roles || definition.roles.includes(role);
	const phaseAllowed = !definition.phases || definition.phases.includes(phase);
	return roleAllowed && phaseAllowed;
}

export function validateToolPattern(pattern: string): string | undefined {
	if (!pattern.trim()) return "Tool policy entries must be non-empty strings.";
	if (pattern === "*") return "Tool policy entries cannot use the full wildcard '*'.";
	if (!TOOL_PATTERN.test(pattern)) return `Tool policy entry '${pattern}' is invalid.`;
	return undefined;
}

export function resolveRoleTools(options: {
	capability: RoleCapability | undefined;
	toolDefinitions?: Record<string, ToolDefinition>;
	role: RoleId;
	phase: WorkflowPhase;
}): ResolvedToolPolicy {
	const definitions = options.toolDefinitions ?? {};
	const policy = options.capability?.toolPolicy;
	if (!policy) {
		return { allowed: [], denied: [], definitions: {}, configured: false };
	}
	const scopedDefinitionNames = Object.entries(definitions)
		.filter(([, definition]) => isToolDefinitionInScope(definition, options.role, options.phase))
		.map(([name]) => name);
	const candidates = unique([...scopedDefinitionNames, ...policy.include, ...policy.exclude]);
	const allowed = new Set<string>();
	for (const include of policy.include) {
		if (isWildcard(include)) {
			for (const candidate of candidates) {
				if (matchesPattern(include, candidate)) allowed.add(candidate);
			}
		} else {
			allowed.add(include);
		}
	}
	const denied = new Set<string>();
	for (const exclude of policy.exclude) {
		for (const candidate of candidates) {
			if (matchesPattern(exclude, candidate)) denied.add(candidate);
		}
	}
	for (const tool of denied) {
		allowed.delete(tool);
	}
	const allowedList = unique([...allowed]);
	return {
		allowed: allowedList,
		denied: unique([...denied]),
		definitions: Object.fromEntries(
			allowedList.flatMap((tool) => (definitions[tool] ? [[tool, definitions[tool]]] : [])),
		),
		configured: true,
	};
}
