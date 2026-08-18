// Obsidian mobile's WebView has no Buffer or process; the SDK expects both.
import { Buffer } from "buffer";
const process = { env: {}, browser: true, version: "", nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)) };
export { Buffer, process };
