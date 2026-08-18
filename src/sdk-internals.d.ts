// @filen/sdk ships types for its public surface only. We reach into one internal
// module to cap the retry count (see the comment in filen.ts).
declare module "@filen/sdk/dist/browser/api/client.js" {
	export const APIClientDefaults: {
		maxRetries: number;
		retryTimeout: number;
	};
}
