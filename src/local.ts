import { normalizePath, type App, type DataAdapter } from "obsidian";
import type { Entry } from "./sync.ts";

/**
 * The vault side.
 *
 * Uses the Adapter API rather than the Vault API, which the plugin guidelines otherwise
 * prefer: Vault.getFiles() hides dotfiles, so it cannot see the config folder at all.
 */
export class LocalVault {
	private readonly fs: DataAdapter;
	private readonly configDir: string;
	private readonly stateDir: string;

	constructor(app: App, configDir: string, stateDir: string) {
		this.fs = app.vault.adapter;
		this.configDir = configDir;
		this.stateDir = stateDir;
	}

	private isForbidden(path: string): boolean {
		return (
			path === this.stateDir ||
			path.startsWith(`${this.stateDir}/`) ||
			path === ".trash" ||
			path.startsWith(".trash/")
		);
	}

	async walk(includeConfigDir: boolean): Promise<Entry[]> {
		const out: Entry[] = [];
		const visit = async (dir: string): Promise<void> => {
			const { files, folders } = await this.fs.list(dir);
			for (const path of folders) {
				if (this.isForbidden(path)) continue;
				if (!includeConfigDir && path === this.configDir) continue;
				out.push({ path, isDir: true, mtime: 0, size: 0 });
				await visit(path);
			}
			for (const path of files) {
				if (this.isForbidden(path)) continue;
				const stat = await this.fs.stat(path);
				if (stat) out.push({ path, isDir: false, mtime: stat.mtime, size: stat.size });
			}
		};
		await visit("/");
		return out;
	}

	read(path: string): Promise<ArrayBuffer> {
		return this.fs.readBinary(path);
	}

	/** Writes mtime through, or the next pass reads the download as a local edit and ping-pongs. */
	async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.mkdir(path.slice(0, slash));
		await this.fs.writeBinary(path, data, { mtime, ctime: mtime });
	}

	async mkdir(path: string): Promise<void> {
		if (!(await this.fs.exists(path))) await this.fs.mkdir(path);
	}

	async trash(path: string, isDir: boolean): Promise<void> {
		if (!(await this.fs.exists(path))) return;
		if (isDir) {
			// Non-recursive so a folder still holding excluded files survives.
			await this.fs.rmdir(path, false).catch(() => undefined);
			return;
		}
		await this.fs.trashLocal(path);
	}

	async readJson(path: string): Promise<unknown> {
		try {
			if (!(await this.fs.exists(path))) return null;
			return JSON.parse(await this.fs.read(path));
		} catch {
			return null;
		}
	}

	async writeJson(path: string, value: unknown): Promise<void> {
		await this.mkdir(normalizePath(this.stateDir));
		await this.fs.write(path, JSON.stringify(value));
	}
}
