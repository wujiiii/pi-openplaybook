import { homedir } from "node:os";
import { join } from "node:path";

export function getOpenPlaybookAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}
