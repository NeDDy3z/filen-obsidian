import { normalizePath, TFile, TFolder, type App, type DataAdapter } from "obsidian";
import type { Entry } from "./sync.ts";

/**
 * The vault side.
 *
 * Reads the file list from Obsidian's own index rather than walking the adapter. Adapter.list()
 * hands back NFC paths but stats an unresolved NFC-directory plus the raw on-disk name, so on
 * Linux it throws ENOENT for anything inside a folder whose real name is decomposed (NFD).
 * The index is immune, keeps its own NFC-to-real-name mapping that every other adapter call
 * resolves through, and already carries mtime and size.
 */
export class LocalVault {
	private readonly app: App;
	private readonly fs: DataAdapter;
	private readonly configDir: string;
	private readonly stateDir: string;

	constructor(app: App, configDir: string, stateDir: string) {
		this.app = app;
		this.fs = app.vault.adapter;
		this.configDir = configDir;
		this.stateDir = stateDir;
	}

	async walk(includeConfigDir: boolean): Promise<Entry[]> {
		const out: Entry[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f.path === "/" || f.path === "") continue;
			if (f instanceof TFolder) out.push({ path: f.path, isDir: true, mtime: 0, size: 0 });
			else if (f instanceof TFile) out.push({ path: f.path, isDir: false, mtime: f.stat.mtime, size: f.stat.size });
		}
		// The index deliberately omits dotfolders, so the config folder still needs walking.
		if (includeConfigDir) await this.walkConfig(this.configDir, out);
		return out;
	}

	private async walkConfig(dir: string, out: Entry[]): Promise<void> {
		let listing: { files: string[]; folders: string[] };
		try {
			listing = await this.fs.list(dir);
		} catch (err) {
			throw new Error(
				`Could not read ${dir}. If its name contains accented characters, rename it to ` +
					`precomposed Unicode (NFC) or turn off config syncing. Cause: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		for (const path of listing.folders) {
			if (path === this.stateDir) continue;
			out.push({ path, isDir: true, mtime: 0, size: 0 });
			await this.walkConfig(path, out);
		}
		for (const path of listing.files) {
			const stat = await this.fs.stat(path);
			if (stat) out.push({ path, isDir: false, mtime: stat.mtime, size: stat.size });
		}
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
