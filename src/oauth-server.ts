import http from "http";

const PORT = 42813;

export function startOAuthCallbackServer(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

			if (url.pathname === "/callback") {
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				res.writeHead(200, { "Content-Type": "text/html" });
				if (code) {
					res.end(
						"<html><body><h2>Gmail CRM connected!</h2><p>You can close this tab and return to Obsidian.</p></body></html>"
					);
					server.close();
					resolve(code);
				} else {
					res.end(
						`<html><body><h2>Authorization failed</h2><p>${error ?? "Unknown error"}</p></body></html>`
					);
					server.close();
					reject(new Error(error ?? "OAuth callback error"));
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		server.listen(PORT, "127.0.0.1");

		// Timeout after 2 minutes
		setTimeout(() => {
			server.close();
			reject(new Error("OAuth callback timed out"));
		}, 120_000);
	});
}
