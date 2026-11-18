import http from "http";

const PORT = 42813;
const HOST = "127.0.0.1";

export function startOAuthCallbackServer(expectedState: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

			if (url.pathname === "/callback") {
                if (req.method !== "GET" || url.searchParams.get("state") !== expectedState) {
                    res.writeHead(400, { "Content-Type": "text/plain" });
                    res.end("Invalid authorization state. Return to Obsidian and try again.");
                    return;
                }
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				res.writeHead(200, { "Content-Type": "text/html" });
				if (code) {
					res.end(
						"<html><body><h2>People Plugin connected!</h2><p>You can close this tab and return to Obsidian.</p></body></html>"
					);
					settled = true;
					server.close();
					resolve(code);
				} else {
					res.end(
						"<html><body><h2>Authorization failed</h2><p>Return to Obsidian and try connecting again.</p></body></html>"
					);
					settled = true;
					server.close();
					reject(new Error(error ?? "OAuth callback error"));
				}
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		let timer: ReturnType<typeof setTimeout>;
		server.once("close", () => clearTimeout(timer));
		server.once("error", (error) => {
            clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});

		server.listen(PORT, HOST);

		// Timeout after 2 minutes
		timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				server.close();
				reject(new Error("OAuth callback timed out"));
			}
		}, 120_000);
	});
}
