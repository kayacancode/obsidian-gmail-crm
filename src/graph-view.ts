export const HOSTED_PEOPLE_GRAPH_URL = "https://people-graph.kayarjones901.workers.dev/";

export function graphViewUrl(configuredUrl: string): string | null {
	const value = configuredUrl.trim();
	if (!value) return HOSTED_PEOPLE_GRAPH_URL;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}
