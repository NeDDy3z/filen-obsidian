// Reached only via derKeyToPem, which @filen/sdk calls solely on its node and
// react-native paths. Throws loudly rather than silently misbehaving if that changes.
class Key {
	constructor() {
		throw new Error("js-crypto-key-utils is not available in the Obsidian build");
	}
}
module.exports = { Key };
module.exports.default = module.exports;
