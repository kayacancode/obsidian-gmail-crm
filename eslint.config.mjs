import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

// Extend the default brands and acronyms from the plugin
const defaultBrands = [
	"iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
	"Obsidian", "Obsidian Sync", "Obsidian Publish",
	"Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
	"YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
	"Readwise", "Zotero", "Excalidraw", "Mermaid",
	"Markdown", "LaTeX", "JavaScript", "TypeScript", "Node.js",
	"npm", "pnpm", "Yarn", "Git", "GitHub",
	"GitLab", "Notion", "Evernote", "Roam Research", "Logseq", "Anki", "Reddit",
	"VS Code", "Visual Studio Code", "IntelliJ IDEA", "WebStorm", "PyCharm",
];

const defaultAcronyms = [
	"API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL",
	"FTP", "SFTP", "SMTP", "JSON", "XML", "HTML", "CSS", "PDF", "CSV", "YAML",
	"SQL", "PNG", "JPG", "JPEG", "GIF", "SVG", "2FA", "MFA", "JWT", "LDAP",
	"SAML", "SDK", "IDE", "CLI", "GUI", "CRUD", "REST", "SOAP", "CPU", "GPU",
	"RAM", "SSD", "USB", "UI", "OK", "RSS", "S3", "WebDAV", "ID", "UUID",
	"GUID", "SHA", "MD5", "ASCII", "UTF-8", "UTF-16", "DOM", "CDN", "FAQ",
	"AI", "ML",
];

export default tseslint.config(
	{
		files: ["src/**/*.ts"],
		plugins: {
			obsidianmd,
		},
		languageOptions: {
			parser: tseslint.parser,
		},
		rules: {
			"obsidianmd/ui/sentence-case": ["error", {
				brands: [
					...defaultBrands,
					// Plugin-specific brands
					"Gmail", "OAuth", "OAuth2", "Google Cloud Console",
					"Anthropic", "Claude", "Harper",
				],
				acronyms: [
					...defaultAcronyms,
					// Plugin-specific acronyms
					"CRM",
				],
				enforceCamelCaseLower: true,
			}],
			"obsidianmd/settings-tab/no-problematic-settings-headings": "error",
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/commands/no-plugin-id-in-command-id": "error",
			"obsidianmd/commands/no-plugin-name-in-command-name": "error",
		},
	},
);
