import {
	debounce,
	Notice,
	normalizePath,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type TAbstractFile,
} from "obsidian";
import type { FilenSDKConfig } from "@filen/sdk";
import { FilenRemote } from "./filen.ts";
import { LocalVault } from "./local.ts";
import {
	applyDirection,
	conflictPath,
	decodeSnapshot,
	encodeSnapshot,
	makeConfigFilter,
	makeExcluder,
	MTIME_TOLERANCE,
	plan,
	type Action,
	type ConfigSyncMode,
	type Entry,
	type SyncDirection,
} from "./sync.ts";

interface SyncOptions {
	ignoreSnapshot?: boolean;
}

interface FilenSyncSettings {
	credentials: FilenSDKConfig | null;
	accountEmail: string;
	remoteRoot: string;
	direction: SyncDirection;
	intervalMinutes: number;
	idleSeconds: number;
	configSync: ConfigSyncMode;
	syncOnStartup: boolean;
	excludes: string;
}

const DEFAULT_SETTINGS: FilenSyncSettings = {
	credentials: null,
	accountEmail: "",
	remoteRoot: "",
	direction: "both",
	intervalMinutes: 0,
	idleSeconds: 0,
	configSync: "off",
	syncOnStartup: true,
	excludes: "",
};

const TRANSFER_CONCURRENCY = 4;

type CredentialKind = "email" | "password" | "code";

/**
 * Password managers append newlines and authenticator apps display `123 456`. Spaces go
 * everywhere except passwords, where they can be part of the secret.
 */
function normalizeCredential(kind: CredentialKind, raw: string): string {
	return kind === "password" ? raw.replace(/[\r\n]+/g, "") : raw.replace(/\s+/g, "");
}

function positiveOrZero(raw: string): number {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

export default class FilenSyncPlugin extends Plugin {
	settings: FilenSyncSettings = DEFAULT_SETTINGS;
	private status: HTMLElement | null = null;
	private syncing = false;
	private startupTimeout: number | null = null;
	private afterIdle: (() => void) | null = null;
	private rerunRequested = false;
	/** Paths this sync wrote, so its own vault events do not look like your edits. */
	private writtenByUs = new Set<string>();

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as (Partial<FilenSyncSettings> & { syncConfigDir?: boolean }) | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		if (!saved?.configSync && saved?.syncConfigDir) this.settings.configSync = "all";
		if (!this.settings.remoteRoot) this.settings.remoteRoot = `Obsidian/${this.app.vault.getName()}`;

		// Status bar items are desktop only, so mobile leans on notices instead.
		if (!Platform.isMobile) {
			this.status = this.addStatusBarItem();
			this.status.addClass("mod-clickable");
			this.status.setAttribute("aria-label", "Sync with Filen");
			this.registerDomEvent(this.status, "click", () => void this.sync());
			this.setStatus("idle");
		}

		this.addRibbonIcon("refresh-cw", "Sync with Filen", () => void this.sync());
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync() });
		this.addCommand({
			id: "force-sync",
			name: "Force sync, ignoring the last sync state",
			callback: () => void this.sync(false, { ignoreSnapshot: true }),
		});
		this.addSettingTab(new FilenSyncSettingTab(this.app, this));

		if (this.settings.direction === "none") return;

		if (this.settings.intervalMinutes > 0) {
			this.registerInterval(window.setInterval(() => void this.sync(true), this.settings.intervalMinutes * 60_000));
		}
		if (this.settings.idleSeconds > 0) {
			this.afterIdle = debounce(() => void this.sync(true), this.settings.idleSeconds * 1000, true);
			// Consumes one event per path this sync wrote, rather than ignoring everything while a
			// sync runs, so an edit made mid-sync still schedules the next one.
			const onChange = (file: TAbstractFile) => {
				if (this.writtenByUs.delete(file.path)) return;
				this.afterIdle?.();
			};
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
		}
		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				this.startupTimeout = window.setTimeout(() => void this.sync(true), 5_000);
			});
		}
	}

	onunload(): void {
		if (this.startupTimeout !== null) window.clearTimeout(this.startupTimeout);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	newRemote(): FilenRemote {
		if (!this.settings.credentials) throw new Error("Log in to Filen in the plugin settings first.");
		return new FilenRemote(this.settings.credentials);
	}

	private get stateDir(): string {
		return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
	}

	private setStatus(text: string): void {
		this.status?.setText(`Filen: ${text}`);
	}

	async sync(quiet = false, opts: SyncOptions = {}): Promise<void> {
		if (this.settings.direction === "none") {
			if (!quiet) new Notice("Filen: sync direction is set to off.");
			return;
		}
		if (this.syncing) {
			// Run once more afterwards instead of dropping the request.
			this.rerunRequested = true;
			if (!quiet) new Notice("Filen sync is already running, it will run again after.");
			return;
		}
		if (!this.settings.credentials) {
			if (!quiet) new Notice("Filen: log in from the plugin settings first.");
			return;
		}

		this.syncing = true;
		this.setStatus(opts.ignoreSnapshot ? "force syncing" : "syncing");
		try {
			const summary = await this.runSync(opts);
			this.setStatus(summary.status);
			if (!quiet || summary.notify) new Notice(`Filen sync: ${summary.message}`);
		} catch (err) {
			console.error("[filen-sync]", err);
			this.setStatus("error");
			new Notice(`Filen sync failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.syncing = false;
		}
		if (this.rerunRequested) {
			this.rerunRequested = false;
			await this.sync(true);
		}
	}

	private async runSync(opts: SyncOptions): Promise<{ status: string; message: string; notify: boolean }> {
		const local = new LocalVault(this.app, this.app.vault.configDir, this.stateDir);
		const remote = this.newRemote();
		await remote.connect(this.settings.remoteRoot);

		const snapshotPath = normalizePath(`${this.stateDir}/snapshot.json`);
		// An empty snapshot makes every difference look like a create, so no delete branch can
		// fire. That is what makes a force sync safe to reach for.
		const snapshot = opts.ignoreSnapshot ? {} : decodeSnapshot(await local.readJson(snapshotPath));

		const excluded = makeExcluder(this.settings.excludes.split("\n"));
		const configFilter = makeConfigFilter(this.settings.configSync, this.app.vault.configDir);
		const keep = (e: Entry) => !excluded(e.path) && configFilter(e);

		const [localAll, remoteAll] = await Promise.all([
			local.walk(this.settings.configSync !== "off"),
			remote.walk(),
		]);
		const localBy = new Map(localAll.filter(keep).map((e) => [e.path, e]));
		const remoteBy = new Map(remoteAll.filter(keep).map((e) => [e.path, e]));
		const direction = this.settings.direction;
		const actions = applyDirection(plan([...localBy.values()], [...remoteBy.values()], snapshot), direction);
		this.writtenByUs.clear();

		const errors: string[] = [];
		const clashes: string[] = [];
		let conflicts = 0;
		let done = 0;

		const record = (path: string, e: Entry) => {
			snapshot[path] = { mtime: e.mtime, size: e.size, isDir: e.isDir };
		};

		const apply = async (a: Action): Promise<void> => {
			switch (a.type) {
				case "mkdirRemote":
					await remote.mkdir(a.path);
					record(a.path, localBy.get(a.path)!);
					break;
				case "mkdirLocal":
					await local.mkdir(a.path);
					this.writtenByUs.add(a.path);
					record(a.path, remoteBy.get(a.path)!);
					break;
				case "upload": {
					const e = localBy.get(a.path)!;
					await remote.write(a.path, await local.read(a.path), e.mtime);
					record(a.path, e);
					break;
				}
				case "download": {
					const e = remoteBy.get(a.path)!;
					await local.write(a.path, await remote.read(a.path), e.mtime);
					this.writtenByUs.add(a.path);
					record(a.path, e);
					break;
				}
				case "conflict": {
					// Both copies survive. Merging is how sync plugins lose people's notes.
					const l = localBy.get(a.path)!;
					const r = remoteBy.get(a.path)!;
					const copy = normalizePath(conflictPath(a.path, new Date()));
					this.writtenByUs.add(copy);
					if (direction === "pull") {
						// Filen wins, but your version is kept beside it rather than overwritten.
						await local.write(copy, await local.read(a.path), l.mtime);
						await local.write(a.path, await remote.read(a.path), r.mtime);
						this.writtenByUs.add(a.path);
						record(a.path, r);
					} else {
						await local.write(copy, await remote.read(a.path), r.mtime);
						await remote.write(a.path, await local.read(a.path), l.mtime);
						record(a.path, l);
					}
					conflicts++;
					break;
				}
				case "delLocal":
					await local.trash(a.path, a.isDir);
					this.writtenByUs.add(a.path);
					delete snapshot[a.path];
					break;
				case "delRemote":
					await remote.trash(a.path, a.isDir);
					delete snapshot[a.path];
					break;
				case "typeClash":
					clashes.push(a.path);
					return;
				case "forget":
					delete snapshot[a.path];
					return;
			}
			done++;
		};

		const guarded = async (a: Action): Promise<void> => {
			try {
				await apply(a);
			} catch (err) {
				// One unreadable file must not stop the rest of the vault.
				errors.push(`${a.type} ${a.path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		};

		const group = (...types: Action["type"][]) => actions.filter((a) => types.includes(a.type));
		for (const a of group("mkdirRemote", "mkdirLocal")) await guarded(a);
		const transfers = group("upload", "download", "conflict");
		let n = 0;
		await pool(transfers, TRANSFER_CONCURRENCY, async (a) => {
			this.setStatus(`syncing ${++n}/${transfers.length}`);
			await guarded(a);
		});
		for (const a of group("delLocal", "delRemote")) await guarded(a);
		for (const a of group("typeClash", "forget")) await guarded(a);

		// Anything already identical on both sides also belongs in the snapshot, or deleting it
		// on one device later looks like a create on the other and it comes back.
		for (const [path, l] of localBy) {
			const r = remoteBy.get(path);
			if (!r || l.isDir !== r.isDir || snapshot[path]) continue;
			if (l.isDir || (l.size === r.size && Math.abs(l.mtime - r.mtime) <= MTIME_TOLERANCE)) record(path, l);
		}

		await local.writeJson(snapshotPath, encodeSnapshot(snapshot));

		if (clashes.length > 0) {
			new Notice(`Filen sync skipped ${clashes.length} path(s) that are a file on one side and a folder on the other.`);
		}
		if (errors.length > 0) console.error("[filen-sync] failures:\n" + errors.join("\n"));

		const parts = [`${done} change(s)`];
		if (conflicts > 0) parts.push(`${conflicts} conflict(s) kept as copies`);
		if (errors.length > 0) parts.push(`${errors.length} failed, see console`);
		if (opts.ignoreSnapshot) parts.unshift("forced");
		if (direction !== "both") parts.unshift(direction === "push" ? "vault to Filen" : "Filen to vault");
		return {
			status: errors.length > 0 ? `${errors.length} failed` : `synced ${done}`,
			message: actions.length === 0 ? "already up to date" : parts.join(", "),
			// Without a status bar, a quiet sync would leave no trace at all on mobile.
			notify: conflicts > 0 || errors.length > 0 || (Platform.isMobile && done > 0),
		};
	}
}

class FilenSyncSettingTab extends PluginSettingTab {
	private readonly plugin: FilenSyncPlugin;
	private email = "";
	private password = "";
	private twoFactor = "";

	constructor(app: App, plugin: FilenSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Mobile keyboards otherwise autocapitalise and autocorrect credentials into garbage. */
	private credentialField(
		root: HTMLElement,
		opts: { name: string; kind: CredentialKind; desc?: string; placeholder?: string; set: (v: string) => void },
	): void {
		const setting = new Setting(root).setName(opts.name);
		if (opts.desc) setting.setDesc(opts.desc);

		setting.addText((t) => {
			if (opts.placeholder) t.setPlaceholder(opts.placeholder);
			if (opts.kind === "password") t.inputEl.type = "password";
			// Attributes, not properties: the autocapitalize property reflects "off" back as "none".
			t.inputEl.setAttribute("autocapitalize", "off");
			t.inputEl.setAttribute("autocorrect", "off");
			t.inputEl.setAttribute("autocomplete", "off");
			t.inputEl.setAttribute("spellcheck", "false");
			// Fires for pasted text too, so a pasted value is cleaned up the same way.
			t.onChange((v) => opts.set(normalizeCredential(opts.kind, v)));
		});
	}

	display(): void {
		const { containerEl: root } = this;
		root.empty();

		new Setting(root).setName("Account").setHeading();

		if (this.plugin.settings.credentials) {
			new Setting(root)
				.setName("Logged in")
				.setDesc(this.plugin.settings.accountEmail || "Account connected.")
				.addButton((b) =>
					b.setButtonText("Log out").onClick(async () => {
						this.plugin.settings.credentials = null;
						this.plugin.settings.accountEmail = "";
						await this.plugin.saveSettings();
						this.display();
					}),
				);
			new Setting(root)
				.setName("Check connection")
				.setDesc("Uploads, downloads, compares and deletes a small test file.")
				.addButton((b) =>
					b.setButtonText("Run check").onClick(async () => {
						b.setDisabled(true).setButtonText("Checking");
						try {
							const remote = this.plugin.newRemote();
							await remote.connect(this.plugin.settings.remoteRoot);
							await remote.checkConnection();
							new Notice("Filen: connection works.");
						} catch (err) {
							console.error("[filen-sync]", err);
							new Notice(`Filen check failed: ${err instanceof Error ? err.message : String(err)}`);
						} finally {
							b.setDisabled(false).setButtonText("Run check");
						}
					}),
				);
		} else {
			this.credentialField(root, {
				name: "Email",
				kind: "email",
				placeholder: "you@example.com",
				set: (v) => {
					this.email = v;
				},
			});
			this.credentialField(root, {
				name: "Password",
				kind: "password",
				set: (v) => {
					this.password = v;
				},
			});
			this.credentialField(root, {
				name: "Two-factor code",
				kind: "code",
				desc: "Leave empty if two-factor is off. A recovery key works here too.",
				set: (v) => {
					this.twoFactor = v;
				},
			});
			new Setting(root)
				.setDesc("Only the derived account keys are stored. The password is never saved.")
				.addButton((b) =>
					b
						.setButtonText("Log in")
						.setCta()
						.onClick(async () => {
							b.setDisabled(true).setButtonText("Logging in");
							try {
								this.plugin.settings.credentials = await FilenRemote.login(this.email, this.password, this.twoFactor);
								this.password = "";
								this.twoFactor = "";
								this.plugin.settings.accountEmail = await this.plugin.newRemote().accountEmail();
								await this.plugin.saveSettings();
								new Notice(`Filen: logged in as ${this.plugin.settings.accountEmail}`);
								this.display();
							} catch (err) {
								console.error("[filen-sync]", err);
								new Notice(`Filen login failed: ${err instanceof Error ? err.message : String(err)}`);
								b.setDisabled(false).setButtonText("Log in");
							}
						}),
				);
		}

		new Setting(root).setName("Sync").setHeading();

		new Setting(root)
			.setName("Folder on Filen")
			.setDesc("Path inside your Filen drive. Created if it does not exist.")
			.addText((t) =>
				t.setValue(this.plugin.settings.remoteRoot).onChange(async (v) => {
					this.plugin.settings.remoteRoot = v.replace(/^\/+|\/+$/g, "");
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Direction")
			.setDesc(
				"One-way modes treat one side as the source of truth: anything the other side deleted " +
					"comes back on the next sync.",
			)
			.addDropdown((d) =>
				d
					.addOption("both", "Both ways")
					.addOption("push", "Vault to Filen only")
					.addOption("pull", "Filen to vault only")
					.addOption("none", "Off, do not sync")
					.setValue(this.plugin.settings.direction)
					.onChange(async (v) => {
						this.plugin.settings.direction = v as SyncDirection;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Sync after you stop typing")
			.setDesc(
				"Seconds of no edits before syncing. 0 turns it off. Waits for the whole vault to go quiet, " +
					"so it runs once after a writing session rather than once per keystroke. Applies after a reload.",
			)
			.addText((t) =>
				t.setValue(String(this.plugin.settings.idleSeconds)).onChange(async (v) => {
					this.plugin.settings.idleSeconds = positiveOrZero(v);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Auto-sync interval")
			.setDesc("Minutes between automatic syncs. 0 turns it off. Applies after a reload.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (v) => {
					this.plugin.settings.intervalMinutes = positiveOrZero(v);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName("Sync on startup")
			.setDesc("Runs one sync shortly after Obsidian opens, so you begin on the newest version of your notes.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
					this.plugin.settings.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(root)
			.setName(`Sync the ${this.app.vault.configDir} folder`)
			.setDesc(
				"Window layout is never synced in any mode, since Obsidian rewrites it constantly and devices " +
					"would fight over it.",
			)
			.addDropdown((d) =>
				d
					.addOption("off", "Off, notes only")
					.addOption("plugins", "Plugins and themes")
					.addOption("all", "Everything except window layout")
					.setValue(this.plugin.settings.configSync)
					.onChange(async (v) => {
						this.plugin.settings.configSync = v as ConfigSyncMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Exclude")
			.setDesc("One glob per line, matched against vault paths. * stops at /, ** does not.")
			.addTextArea((t) =>
				t
					.setPlaceholder("*.pdf\nattachments/**")
					.setValue(this.plugin.settings.excludes)
					.onChange(async (v) => {
						this.plugin.settings.excludes = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Force sync")
			.setDesc(
				"Reconciles as if this device had never synced. Nothing is deleted on either side. Files that " +
					"differ are kept as both copies.",
			)
			.addButton((b) =>
				b.setButtonText("Force sync now").onClick(async () => {
					b.setDisabled(true).setButtonText("Syncing");
					try {
						await this.plugin.sync(false, { ignoreSnapshot: true });
					} finally {
						b.setDisabled(false).setButtonText("Force sync now");
					}
				}),
			);
	}
}
