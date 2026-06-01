import { ItemView, WorkspaceLeaf, TFile, TFolder, Notice, normalizePath } from "obsidian";
import { FrontmatterManager } from "./frontmatter";
import type GmailCrmPlugin from "./main";

export const VIEW_TYPE_GMAIL_CRM_RECONNECT = "gmail-crm-reconnect";

// How long a "Reached out" card stays hidden before it can resurface (if the
// person is still in the re-engage quadrant — usually a real reply moves them
// out via the next sync, so this only catches "I marked it but never emailed").
const RECONTACT_COOLDOWN_DAYS = 60;
const SNOOZE_DAYS = 30;

interface ReconnectCard {
	name: string;
	path: string;
	company: string | null;
	email: string | null;
	combinedScore: number;
	strengthScore: number;
	momentumScore: number;
	daysSinceContact: number | null;
	nudge: string | null;
}

export class ReconnectView extends ItemView {
	private plugin: GmailCrmPlugin;
	private cards: ReconnectCard[] = [];
	private index = 0;

	constructor(leaf: WorkspaceLeaf, plugin: GmailCrmPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_GMAIL_CRM_RECONNECT;
	}

	getDisplayText(): string {
		return "Reconnect";
	}

	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		await this.reload();
	}

	private async reload(): Promise<void> {
		this.cards = await this.loadCards();
		this.index = 0;
		this.render();
	}

	// Pull re-engage (strong + dormant) people straight from People-page
	// frontmatter — the same fields update-staleness writes — and drop anyone
	// already actioned (dismissed, recently contacted, or snoozed).
	private async loadCards(): Promise<ReconnectCard[]> {
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(this.plugin.settings.peopleFolder)
		);
		if (!(folder instanceof TFolder)) return [];

		const today = isoDate(new Date());
		const cards: ReconnectCard[] = [];

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			const content = await this.app.vault.cachedRead(child);
			const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (!fmMatch) continue;
			const yaml = fmMatch[1];

			if (readField(yaml, "quadrant") !== "re-engage") continue;

			const status = readField(yaml, "reconnect_status");
			if (status === "dismissed") continue;
			if (status === "contacted") {
				const last = readField(yaml, "last_reconnect");
				if (last && daysSince(last) < RECONTACT_COOLDOWN_DAYS) continue;
			}

			const snooze = readField(yaml, "reconnect_snooze_until");
			if (snooze && snooze > today) continue; // ISO dates compare lexicographically

			cards.push({
				name: child.basename,
				path: child.path,
				company: cleanLink(readField(yaml, "company")),
				email: readField(yaml, "email"),
				combinedScore: readNumber(yaml, "combined_score") ?? 0,
				strengthScore: readNumber(yaml, "strength_score") ?? 0,
				momentumScore: readNumber(yaml, "momentum_score") ?? 0,
				daysSinceContact: readNumber(yaml, "days_since_contact"),
				nudge: readField(yaml, "nudge"),
			});
		}

		cards.sort((a, b) => b.combinedScore - a.combinedScore);
		return cards;
	}

	private render(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("gmail-crm-container", "gmail-crm-reconnect");

		const header = root.createDiv({ cls: "gmail-crm-header" });
		header.createEl("h4", { text: "Reconnect" });

		if (this.cards.length === 0) {
			root.createDiv({
				cls: "gmail-crm-empty",
				text: "Nobody to reconnect with right now — your re-engage queue is clear. \u{1F389}",
			});
			return;
		}

		if (this.index >= this.cards.length) {
			root.createDiv({
				cls: "gmail-crm-empty",
				text: `Done — you went through all ${this.cards.length} suggestions.`,
			});
			const again = root.createEl("button", { text: "Start over", cls: "gmail-crm-rc-btn" });
			again.addEventListener("click", () => { void this.reload(); });
			return;
		}

		header
			.createDiv({ cls: "gmail-crm-meta gmail-crm-faded" })
			.setText(`${this.index + 1} of ${this.cards.length}`);

		const card = this.cards[this.index];
		const cardEl = root.createDiv({ cls: "gmail-crm-rc-card" });
		cardEl.setAttribute("tabindex", "0");

		const name = cardEl.createDiv({ cls: "gmail-crm-rc-name" });
		name.setText(card.name);
		if (card.company) {
			cardEl.createDiv({ cls: "gmail-crm-rc-company gmail-crm-faded" }).setText(card.company);
		}

		const last =
			card.daysSinceContact === null
				? "No recorded contact"
				: card.daysSinceContact === 0
					? "Last contact today"
					: `Last contact ${card.daysSinceContact} day${card.daysSinceContact === 1 ? "" : "s"} ago`;
		cardEl.createDiv({ cls: "gmail-crm-rc-last" }).setText(last);

		const scores = cardEl.createDiv({ cls: "gmail-crm-rc-scores" });
		scores.createSpan({ cls: "gmail-crm-rc-pill", text: `score ${card.combinedScore}` });
		scores.createSpan({ cls: "gmail-crm-rc-pill", text: `strength ${card.strengthScore}` });
		scores.createSpan({ cls: "gmail-crm-rc-pill", text: `momentum ${card.momentumScore}` });

		if (card.nudge) {
			cardEl.createDiv({ cls: "gmail-crm-rc-nudge" }).setText(card.nudge);
		}

		// Actions
		const actions = root.createDiv({ cls: "gmail-crm-rc-actions" });
		this.actionButton(actions, "Reached out", "mod-cta", () => this.act(card, "contacted"));
		this.actionButton(actions, `Snooze ${SNOOZE_DAYS}d`, "", () => this.act(card, "snooze"));
		this.actionButton(actions, "Dismiss", "", () => this.act(card, "dismissed"));
		this.actionButton(actions, "Skip", "", () => this.advance());
		this.actionButton(actions, "Open page", "", () => { void this.openPage(card); });

		root.createDiv({ cls: "gmail-crm-faded gmail-crm-rc-hint" }).setText(
			"← skip  ·  r reached out  ·  s snooze  ·  d dismiss  ·  enter open"
		);

		// Keyboard shortcuts + horizontal swipe
		cardEl.focus();
		this.registerDomEvent(cardEl, "keydown", (evt: KeyboardEvent) => this.onKey(evt, card));
		this.registerSwipe(cardEl, card);
	}

	private actionButton(
		parent: HTMLElement,
		label: string,
		cls: string,
		onClick: () => void
	): void {
		const btn = parent.createEl("button", { text: label, cls: `gmail-crm-rc-btn ${cls}`.trim() });
		btn.addEventListener("click", onClick);
	}

	private onKey(evt: KeyboardEvent, card: ReconnectCard): void {
		switch (evt.key) {
			case "ArrowLeft":
			case "ArrowRight":
				evt.preventDefault();
				this.advance();
				break;
			case "r":
				void this.act(card, "contacted");
				break;
			case "s":
				void this.act(card, "snooze");
				break;
			case "d":
				void this.act(card, "dismissed");
				break;
			case "Enter":
				void this.openPage(card);
				break;
		}
	}

	private registerSwipe(cardEl: HTMLElement, card: ReconnectCard): void {
		let startX = 0;
		let dragging = false;

		this.registerDomEvent(cardEl, "pointerdown", (e: PointerEvent) => {
			dragging = true;
			startX = e.clientX;
			cardEl.setPointerCapture(e.pointerId);
		});
		this.registerDomEvent(cardEl, "pointermove", (e: PointerEvent) => {
			if (!dragging) return;
			const dx = e.clientX - startX;
			cardEl.style.transform = `translateX(${dx}px)`;
			cardEl.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 400));
		});
		const end = (e: PointerEvent) => {
			if (!dragging) return;
			dragging = false;
			const dx = e.clientX - startX;
			cardEl.style.transform = "";
			cardEl.style.opacity = "";
			if (dx > 120) {
				void this.act(card, "contacted"); // swipe right = reached out
			} else if (dx < -120) {
				this.advance(); // swipe left = skip
			}
		};
		this.registerDomEvent(cardEl, "pointerup", end);
		this.registerDomEvent(cardEl, "pointercancel", end);
	}

	private advance(): void {
		this.index++;
		this.render();
	}

	private async act(card: ReconnectCard, action: "contacted" | "dismissed" | "snooze"): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (!(file instanceof TFile)) {
			new Notice(`Could not find ${card.name}`);
			return;
		}
		const fm = new FrontmatterManager(this.app.vault, this.plugin.settings.companiesFolder);
		const today = isoDate(new Date());

		if (action === "snooze") {
			await fm.setReconnectAction(file, {
				status: "snoozed",
				snoozeUntil: isoDate(addDays(new Date(), SNOOZE_DAYS)),
			});
		} else {
			await fm.setReconnectAction(file, { status: action, lastReconnect: today });
		}

		// Remove the actioned card so the queue stays accurate, then re-render in place.
		this.cards.splice(this.index, 1);
		this.render();
	}

	private async openPage(card: ReconnectCard): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
	}
}

function readField(yaml: string, key: string): string | null {
	const m = yaml.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
	if (!m) return null;
	return m[1].replace(/^["']|["']$/g, "").trim();
}

function readNumber(yaml: string, key: string): number | null {
	const v = readField(yaml, key);
	if (v === null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// Company is stored as a quoted wiki link, e.g. "[[Companies/Betaworks|Betaworks]]".
// Show the display label only.
function cleanLink(val: string | null): string | null {
	if (!val) return null;
	const m = val.match(/\[\[[^|\]]*\|([^\]]+)\]\]/) ?? val.match(/\[\[([^\]]+)\]\]/);
	return m ? m[1] : val;
}

function isoDate(d: Date): string {
	return d.toISOString().split("T")[0];
}

function addDays(d: Date, days: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + days);
	return copy;
}

function daysSince(iso: string): number {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
	return Math.floor((Date.now() - then) / 86_400_000);
}
