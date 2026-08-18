import esbuild from "esbuild";

// @filen/sdk's browser build imports these at the top level but only calls into them behind
// `environment === "node"` guards, and Obsidian reports "browser" on desktop and mobile alike.
// The stream and agent stubs must stay constructible: the SDK subclasses them at module scope.
const NODE_STUBS = {
	"fs-extra": "export default {}",
	"progress-stream": "export default {}",
	fs: "export default {}",
	http: "export default {}",
	https: "export default {}",
	url: "export default {}",
	crypto: "export default {}",
	os: "export const tmpdir = () => '/tmp'\nexport default { tmpdir }",
	stream: `const nope = () => { throw new Error("node streams are unavailable in Obsidian") }
export class Readable { static from = nope }
export class Writable {}
export class Transform {}
export class Duplex {}
export const pipeline = nope
export default { Readable, Writable, Transform, Duplex, pipeline }`,
	agentkeepalive: "export class HttpsAgent {}\nexport class HttpAgent {}\nexport default HttpAgent",
	// Only reached from derKeyToPem, which the SDK calls solely on its node and react-native
	// paths. Stubbing it drops `elliptic` from the bundle, whose GHSA-848j advisory has no fix.
	"js-crypto-key-utils": `const nope = () => { throw new Error("js-crypto-key-utils is not used in the browser build") }
export class Key { constructor() { nope() } }
export default { Key }`,
};

const stubNodeModules = {
	name: "node-stubs",
	setup(build) {
		const filter = new RegExp(`^(${Object.keys(NODE_STUBS).join("|")})$`);
		build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "node-stub" }));
		build.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
			contents: NODE_STUBS[args.path],
			loader: "js",
		}));
	},
};

function bundleOptions({ minify = false, sourcemap = false } = {}) {
	return {
		entryPoints: ["src/main.ts"],
		bundle: true,
		outfile: "main.js",
		format: "cjs",
		target: "es2020",
		platform: "browser",
		mainFields: ["browser", "module", "main"],
		conditions: ["browser", "import", "default"],
		alias: { path: "path-browserify" },
		plugins: [stubNodeModules],
		inject: [new URL("globals.mjs", import.meta.url).pathname],
		define: { global: "globalThis" },
		external: ["obsidian"],
		minify,
		sourcemap,
		logLevel: "info",
	};
}

const prod = process.argv[2] === "production";
const ctx = await esbuild.context(bundleOptions({ minify: prod, sourcemap: prod ? false : "inline" }));
if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	console.log("built main.js");
} else {
	await ctx.watch();
	console.log("watching");
}
