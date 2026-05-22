import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

async function runSerializedFileMutation(path: string, operation: () => Promise<void>): Promise<void> {
	const previous = fileMutationQueues.get(path) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(operation);
	fileMutationQueues.set(path, next);
	try {
		await next;
	} finally {
		if (fileMutationQueues.get(path) === next) {
			fileMutationQueues.delete(path);
		}
	}
}

async function replaceFileAtomic(tempPath: string, path: string): Promise<void> {
	try {
		await rename(tempPath, path);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") {
			throw error;
		}
	}
	await rm(path, { force: true });
	await rename(tempPath, path);
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
	const payload = `${JSON.stringify(data, null, 2)}\n`;
	await writeTextAtomic(path, payload);
}

export async function writeTextAtomic(path: string, data: string): Promise<void> {
	await runSerializedFileMutation(path, async () => {
		await writeTextAtomicUnsafe(path, data);
	});
}

export async function appendJsonlAtomic(path: string, entry: unknown): Promise<void> {
	await runSerializedFileMutation(path, async () => {
		const serialized = `${JSON.stringify(entry)}\n`;
		await ensureDir(dirname(path));
		try {
			await appendFile(path, serialized, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await writeFile(path, serialized, "utf8");
			} else {
				throw error;
			}
		}
	});
}

export async function readJsonlFile<T>(path: string): Promise<T[]> {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

async function writeTextAtomicUnsafe(path: string, data: string): Promise<void> {
	await ensureDir(dirname(path));
	const tempPath = `${path}.${randomUUID()}.tmp`;
	await writeFile(tempPath, data, "utf8");
	await replaceFileAtomic(tempPath, path);
}
