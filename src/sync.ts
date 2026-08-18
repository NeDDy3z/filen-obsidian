export interface Entry {
	path: string;
	isDir: boolean;
	mtime: number;
	size: number;
}

export type Snapshot = Record<string, { mtime: number; size: number; isDir: boolean }>;

export type Action =
	| { type: "upload"; path: string }
	| { type: "download"; path: string }
	| { type: "mkdirRemote"; path: string }
	| { type: "mkdirLocal"; path: string }
	| { type: "delLocal"; path: string; isDir: boolean }
	| { type: "delRemote"; path: string; isDir: boolean }
	| { type: "conflict"; path: string }
	| { type: "typeClash"; path: string }
	| { type: "forget"; path: string };

export type ConfigSyncMode = "off" | "plugins" | "all";

export type SyncDirection = "both" | "push" | "pull" | "none";

/** Filesystems and clouds disagree about sub-second precision. */
export const MTIME_TOLERANCE = 2000;

const changed = (e: Entry, s: Snapshot[string]) =>
	e.size !== s.size || Math.abs(e.mtime - s.mtime) > MTIME_TOLERANCE;

const same = (a: Entry, b: Entry) => a.size === b.size && Math.abs(a.mtime - b.mtime) <= MTIME_TOLERANCE;

const depth = (p: string) => p.split("/").length;

function order(actions: Action[]): Action[] {
	const rank: Record<Action["type"], number> = {
		mkdirLocal: 0,
		mkdirRemote: 0,
		download: 1,
		upload: 1,
		conflict: 1,
		delLocal: 2,
		delRemote: 2,
		typeClash: 3,
		forget: 3,
	};
	// Parents before children, except for deletes, which go deepest first.
	return actions.sort((a, b) => {
		const byRank = rank[a.type] - rank[b.type];
		if (byRank !== 0) return byRank;
		const byDepth = depth(a.path) - depth(b.path);
		return rank[a.type] === 2 ? -byDepth : byDepth;
	});
}

/**
 * Compares the vault, Filen, and the snapshot of the last successful sync. The snapshot is
 * what tells a one-sided delete apart from a one-sided create.
 */
export function plan(local: Entry[], remote: Entry[], snapshot: Snapshot): Action[] {
	const L = new Map(local.map((e) => [e.path, e]));
	const R = new Map(remote.map((e) => [e.path, e]));
	const actions: Action[] = [];

	for (const path of new Set([...L.keys(), ...R.keys(), ...Object.keys(snapshot)])) {
		const l = L.get(path);
		const r = R.get(path);
		const s = snapshot[path];

		if (l && r && l.isDir !== r.isDir) {
			actions.push({ type: "typeClash", path });
			continue;
		}

		const isDir = l?.isDir ?? r?.isDir ?? s?.isDir ?? false;

		if (isDir) {
			if (l && !r) actions.push(s ? { type: "delLocal", path, isDir } : { type: "mkdirRemote", path });
			else if (!l && r) actions.push(s ? { type: "delRemote", path, isDir } : { type: "mkdirLocal", path });
			else if (!l && !r) actions.push({ type: "forget", path });
			continue;
		}

		if (!s) {
			if (l && !r) actions.push({ type: "upload", path });
			else if (!l && r) actions.push({ type: "download", path });
			else if (l && r && !same(l, r)) actions.push({ type: "conflict", path });
			continue;
		}

		if (!l && !r) actions.push({ type: "forget", path });
		else if (l && !r) actions.push({ type: "delLocal", path, isDir: false });
		else if (!l && r) actions.push({ type: "delRemote", path, isDir: false });
		else if (l && r) {
			const localChanged = changed(l, s);
			const remoteChanged = changed(r, s);
			if (localChanged && remoteChanged) {
				if (!same(l, r)) actions.push({ type: "conflict", path });
			} else if (localChanged) actions.push({ type: "upload", path });
			else if (remoteChanged) actions.push({ type: "download", path });
		}
	}

	return order(actions);
}

/** `notes/a.md` becomes `notes/a.conflict-20260818-143000.md`. */
export function conflictPath(path: string, now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash
		? `${path.slice(0, dot)}.conflict-${stamp}${path.slice(dot)}`
		: `${path}.conflict-${stamp}`;
}

/** `**` spans separators, `*` does not. */
export function makeExcluder(globs: string[]): (path: string) => boolean {
	const patterns = globs
		.map((g) => g.trim())
		.filter(Boolean)
		.map(
			(g) =>
				new RegExp(
					`^${g
						.replace(/[.+^${}()|[\]\\]/g, "\\$&")
						.replace(/\*\*/g, " ")
						.replace(/\*/g, "[^/]*")
						.replace(/ /g, ".*")
						.replace(/\?/g, "[^/]")}$`,
				),
		);
	return (path: string) => patterns.some((rx) => rx.test(path));
}

/** Obsidian rewrites these on every pane change, so devices would fight over them forever. */
const CONFIG_NEVER = ["workspace.json", "workspace-mobile.json", "workspace"];

/**
 * Omits `plugins/<id>/data.json`: a running plugin rewrites its own settings from memory at
 * unpredictable times, so a downloaded copy gets clobbered or read half-written.
 */
const CONFIG_PLUGIN_FILES = [
	"plugins/*/manifest.json",
	"plugins/*/main.js",
	"plugins/*/styles.css",
	"community-plugins.json",
	"core-plugins.json",
	"core-plugins-migration.json",
	"appearance.json",
	"hotkeys.json",
	"themes/**",
	"snippets/**",
];

/**
 * Keep-predicate for vault paths. Config folders are dropped even when their contents are
 * kept, which is harmless: both write paths create missing parents.
 */
export function makeConfigFilter(mode: ConfigSyncMode, configDir: string): (entry: Entry) => boolean {
	const never = makeExcluder(CONFIG_NEVER);
	const wanted = makeExcluder(CONFIG_PLUGIN_FILES);

	return (entry) => {
		if (entry.path !== configDir && !entry.path.startsWith(`${configDir}/`)) return true;
		if (mode === "off" || entry.isDir) return false;
		const inner = entry.path.slice(configDir.length + 1);
		if (never(inner)) return false;
		return mode === "all" || wanted(inner);
	};
}

/** Files as `[seconds, size]`, folders as bare paths. Roughly a third smaller than the obvious shape. */
interface StoredSnapshot {
	v: 2;
	f: Record<string, [number, number]>;
	d: string[];
}

export function encodeSnapshot(snapshot: Snapshot): StoredSnapshot {
	const out: StoredSnapshot = { v: 2, f: {}, d: [] };
	for (const [path, e] of Object.entries(snapshot)) {
		if (e.isDir) out.d.push(path);
		else out.f[path] = [Math.round(e.mtime / 1000), e.size];
	}
	return out;
}

export function decodeSnapshot(raw: unknown): Snapshot {
	const out: Snapshot = {};
	if (!raw || typeof raw !== "object") return out;

	const stored = raw as Partial<StoredSnapshot>;
	if (stored.v === 2) {
		for (const [path, [seconds, size]] of Object.entries(stored.f ?? {})) {
			out[path] = { mtime: seconds * 1000, size, isDir: false };
		}
		for (const path of stored.d ?? []) out[path] = { mtime: 0, size: 0, isDir: true };
		return out;
	}

	// Converts the older `{path: {mtime, size, isDir}}` file so upgrading does not look like a
	// device that has never synced.
	for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
		const e = value as { mtime?: unknown; size?: unknown; isDir?: unknown };
		if (typeof e?.mtime !== "number" || typeof e?.size !== "number") continue;
		out[path] = { mtime: e.mtime, size: e.size, isDir: e.isDir === true };
	}
	return out;
}

/**
 * Narrows a bidirectional plan to one direction.
 *
 * Actions that would write to the wrong side are not simply dropped. A file the other side
 * deleted is put back from the authoritative side instead, because dropping the action would
 * leave the same decision to be made again on every future sync, and the two sides would never
 * agree.
 */
export function applyDirection(actions: Action[], direction: SyncDirection): Action[] {
	if (direction === "both") return actions;
	if (direction === "none") return [];

	const out: Action[] = [];
	for (const a of actions) {
		if (a.type === "typeClash" || a.type === "forget") {
			out.push(a);
		} else if (direction === "push") {
			if (a.type === "upload" || a.type === "mkdirRemote" || a.type === "delRemote") out.push(a);
			else if (a.type === "conflict") out.push({ type: "upload", path: a.path });
			else if (a.type === "delLocal") {
				out.push(a.isDir ? { type: "mkdirRemote", path: a.path } : { type: "upload", path: a.path });
			}
		} else {
			if (a.type === "download" || a.type === "mkdirLocal" || a.type === "delLocal" || a.type === "conflict") {
				out.push(a);
			} else if (a.type === "delRemote") {
				out.push(a.isDir ? { type: "mkdirLocal", path: a.path } : { type: "download", path: a.path });
			}
		}
	}
	return out;
}
