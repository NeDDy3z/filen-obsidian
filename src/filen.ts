import FilenSDK, { type FilenSDKConfig } from "@filen/sdk";
import { APIClientDefaults } from "@filen/sdk/dist/browser/api/client.js";
import type { CloudItemTree } from "@filen/sdk/dist/types/cloud";
import type { Entry } from "./sync.ts";

// The SDK defaults to 3600 retries a second apart, so an offline phone would hammer for an
// hour. Filen's own API errors skip the retry loop, so this only shortens transport failures.
APIClientDefaults.maxRetries = 5;
APIClientDefaults.retryTimeout = 1000;

/**
 * The Filen side.
 *
 * Avoids sdk.fs() throughout: those helpers resolve paths through an internal cache that only
 * sdk.fs().readdir() fills, and sdk.fs().writeFile() is node-only. Driving cloud() directly off
 * one getDirectoryTree() call is the browser-safe path, on desktop and mobile alike.
 */
export class FilenRemote {
	readonly sdk: FilenSDK;
	private items = new Map<string, CloudItemTree>();
	private dirs = new Map<string, string>();
	private rootUUID = "";
	private mkdirChain: Promise<void> = Promise.resolve();

	constructor(config: FilenSDKConfig) {
		this.sdk = new FilenSDK({ metadataCache: true, connectToSocket: false, ...config });
	}

	/** Returns only the derived keys, so the password never needs storing. */
	static async login(email: string, password: string, twoFactorCode?: string): Promise<FilenSDKConfig> {
		const sdk = new FilenSDK({ metadataCache: true, connectToSocket: false });
		await sdk.login({ email, password, twoFactorCode: twoFactorCode || undefined });
		const { apiKey, masterKeys, publicKey, privateKey, authVersion, baseFolderUUID, userId } = sdk.config;
		return { email, apiKey, masterKeys, publicKey, privateKey, authVersion, baseFolderUUID, userId };
	}

	get loggedIn(): boolean {
		return Boolean(this.sdk.config.apiKey && this.sdk.config.baseFolderUUID);
	}

	async accountEmail(): Promise<string> {
		return (await this.sdk.user().account()).email;
	}

	async connect(rootPath: string): Promise<void> {
		if (!this.loggedIn) throw new Error("Not logged in to Filen.");
		let uuid = this.sdk.config.baseFolderUUID as string;
		for (const part of rootPath.split("/").filter(Boolean)) {
			const children = await this.sdk.cloud().listDirectory({ uuid, onlyDirectories: true });
			const hit = children.find((c) => c.type === "directory" && c.name === part);
			uuid = hit ? hit.uuid : await this.sdk.cloud().createDirectory({ name: part, parent: uuid });
		}
		this.rootUUID = uuid;
	}

	/** One request for the whole subtree, decrypted client side. */
	async walk(): Promise<Entry[]> {
		const tree = await this.sdk.cloud().getDirectoryTree({ uuid: this.rootUUID, skipCache: true });
		this.items.clear();
		this.dirs.clear();

		const out: Entry[] = [];
		for (const [key, item] of Object.entries(tree)) {
			// Keyed the same way the vault reports paths, so an accented name stored here in
			// decomposed form still matches its local counterpart instead of looking like a
			// separate file. Lookups keep the item, so requests still use its uuid, not this path.
			const path = key.replace(/^\/+/, "").normalize("NFC");
			if (path === "") continue;
			this.items.set(path, item);
			if (item.type === "directory") {
				this.dirs.set(path, item.uuid);
				out.push({ path, isDir: true, mtime: 0, size: 0 });
			} else {
				out.push({ path, isDir: false, mtime: item.lastModified, size: item.size });
			}
		}
		return out;
	}

	async read(path: string): Promise<ArrayBuffer> {
		const item = this.items.get(path);
		if (!item || item.type !== "file") throw new Error(`Not a file on Filen: ${path}`);
		if (item.size === 0) return new ArrayBuffer(0);
		const stream = this.sdk.cloud().downloadFileToReadableStream({
			uuid: item.uuid,
			bucket: item.bucket,
			region: item.region,
			version: item.version,
			key: item.key,
			size: item.size,
			chunks: item.chunks,
		});
		return await new Response(stream).arrayBuffer();
	}

	async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		const slash = path.lastIndexOf("/");
		const name = slash < 0 ? path : path.slice(slash + 1);
		const parent = slash < 0 ? this.rootUUID : await this.mkdir(path.slice(0, slash));
		// uploadWebFile copies File.lastModified into the remote metadata, which is how mtime
		// survives the round trip.
		const item = await this.sdk.cloud().uploadWebFile({
			file: new File([data], name, { lastModified: mtime }),
			parent,
			name,
		});
		this.items.set(path, item);
	}

	/** Serialized: parallel uploads into one new folder would otherwise each create it. */
	async mkdir(path: string): Promise<string> {
		const inFront = this.mkdirChain;
		let done!: () => void;
		this.mkdirChain = new Promise((resolve) => (done = resolve));
		await inFront;
		try {
			return await this.mkdirUnlocked(path);
		} finally {
			done();
		}
	}

	private async mkdirUnlocked(path: string): Promise<string> {
		const known = this.dirs.get(path);
		if (known) return known;
		let uuid = this.rootUUID;
		let built = "";
		for (const part of path.split("/").filter(Boolean)) {
			built = built ? `${built}/${part}` : part;
			uuid = this.dirs.get(built) ?? (await this.sdk.cloud().createDirectory({ name: part, parent: uuid }));
			this.dirs.set(built, uuid);
		}
		return uuid;
	}

	/** To the Filen trash, so a wrong decision stays recoverable. */
	async trash(path: string, isDir: boolean): Promise<void> {
		const item = this.items.get(path);
		if (!item) return;
		if (isDir) await this.sdk.cloud().trashDirectory({ uuid: item.uuid });
		else await this.sdk.cloud().trashFile({ uuid: item.uuid });
		this.items.delete(path);
		this.dirs.delete(path);
	}

	async checkConnection(): Promise<void> {
		const name = `.filen-sync-check-${Date.now()}`;
		const sent = new TextEncoder().encode(`check ${name}`);
		await this.write(name, sent.buffer, Date.now());
		await this.walk();
		const back = new Uint8Array(await this.read(name));
		await this.trash(name, false);
		if (back.length !== sent.length || !back.every((b, i) => b === sent[i])) {
			throw new Error("Downloaded test file did not match what was uploaded.");
		}
	}
}
