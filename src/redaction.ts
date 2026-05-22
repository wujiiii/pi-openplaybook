import type { RedactionRule } from "./types.ts";

const DEFAULT_RULES: RedactionRule[] = [
	{ pattern: "(api[_-]?key\\s*[=:]\\s*)([^\\s,;]+)", replacement: "$1[REDACTED]", enabled: true },
	{ pattern: "(token\\s*[=:]\\s*)([^\\s,;]+)", replacement: "$1[REDACTED]", enabled: true },
	{ pattern: "(secret\\s*[=:]\\s*)([^\\s,;]+)", replacement: "$1[REDACTED]", enabled: true },
	{ pattern: "(password\\s*[=:]\\s*)([^\\s,;]+)", replacement: "$1[REDACTED]", enabled: true },
	{ pattern: "(authorization\\s*[=:]\\s*)([^\\s,;]+)", replacement: "$1[REDACTED]", enabled: true },
];

export function redactString(value: string, rules: RedactionRule[] = DEFAULT_RULES): string {
	let current = value;
	for (const rule of rules) {
		if (!rule.enabled) continue;
		const regex = new RegExp(rule.pattern, "gi");
		current = current.replace(regex, rule.replacement);
	}
	return current;
}

export function redactValue<T>(value: T, rules: RedactionRule[] = DEFAULT_RULES): T {
	if (typeof value === "string") {
		return redactString(value, rules) as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, rules)) as T;
	}
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			output[key] = redactValue(entry, rules);
		}
		return output as T;
	}
	return value;
}

export { DEFAULT_RULES as OPENPLAYBOOK_REDACTION_RULES };
