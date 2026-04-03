import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { ContactIndex, Contact } from "./types";

export const VIEW_TYPE_GMAIL_CRM = "gmail-crm-view";

type SortKey = "lastContact" | "totalExchanges" | "name";

export class GmailCrmView extends ItemView {
	private contactIndex: ContactIndex | null = null;
	private sortBy: SortKey = "lastContact";
	private filterText = "";
	private onContactClick: (contact: Contact) => void;

	constructor(leaf: WorkspaceLeaf, onContactClick: (contact: Contact) => void) {
		super(leaf);
		this.onContactClick = onContactClick;
	}

	getViewType(): string {
		return VIEW_TYPE_GMAIL_CRM;
	}

	getDisplayText(): string {
		return "Gmail CRM";
	}

	getIcon(): string {
		return "contact";
	}

	setContactIndex(index: ContactIndex) {
		this.contactIndex = index;
		this.render();
	}

	async onOpen() {
		this.render();
	}

	private render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("gmail-crm-container");

		// Header
		const header = container.createDiv({ cls: "gmail-crm-header" });
		header.createEl("h4", { text: "Gmail CRM" });

		if (this.contactIndex) {
			const meta = header.createDiv({ cls: "gmail-crm-meta" });
			meta.createSpan({
				text: `${Object.keys(this.contactIndex.contacts).length} contacts`,
			});
			meta.createSpan({
				text: ` \u00B7 synced ${this.relativeTime(this.contactIndex.lastSync)}`,
				cls: "gmail-crm-faded",
			});
		}

		// Controls
		const controls = container.createDiv({ cls: "gmail-crm-controls" });

		const searchInput = controls.createEl("input", {
			type: "text",
			placeholder: "Filter contacts...",
			cls: "gmail-crm-search",
		});
		searchInput.value = this.filterText;
		searchInput.addEventListener("input", () => {
			this.filterText = searchInput.value;
			this.renderList(listEl);
		});

		const sortSelect = controls.createEl("select", { cls: "gmail-crm-sort" });
		const sortOptions: { value: SortKey; label: string }[] = [
			{ value: "lastContact", label: "Recent" },
			{ value: "totalExchanges", label: "Frequency" },
			{ value: "name", label: "Name" },
		];
		for (const opt of sortOptions) {
			const option = sortSelect.createEl("option", {
				value: opt.value,
				text: opt.label,
			});
			if (opt.value === this.sortBy) option.selected = true;
		}
		sortSelect.addEventListener("change", () => {
			this.sortBy = sortSelect.value as SortKey;
			this.renderList(listEl);
		});

		// Contact list
		const listEl = container.createDiv({ cls: "gmail-crm-list" });

		if (!this.contactIndex) {
			listEl.createDiv({
				cls: "gmail-crm-empty",
				text: "No contacts synced yet. Open settings to connect Gmail.",
			});
			return;
		}

		this.renderList(listEl);
	}

	private renderList(listEl: HTMLElement) {
		listEl.empty();

		if (!this.contactIndex) return;

		let contacts = Object.values(this.contactIndex.contacts);

		if (this.filterText) {
			const q = this.filterText.toLowerCase();
			contacts = contacts.filter(
				(c) =>
					c.name.toLowerCase().includes(q) ||
					c.email.toLowerCase().includes(q)
			);
		}

		contacts.sort((a, b) => {
			switch (this.sortBy) {
				case "lastContact":
					return b.lastContact.localeCompare(a.lastContact);
				case "totalExchanges":
					return b.totalExchanges - a.totalExchanges;
				case "name":
					return a.name.localeCompare(b.name);
			}
		});

		// Render top 200 for performance
		const visible = contacts.slice(0, 200);

		for (const contact of visible) {
			const row = listEl.createDiv({ cls: "gmail-crm-row" });
			row.addEventListener("click", () => this.onContactClick(contact));

			const avatar = row.createDiv({ cls: "gmail-crm-avatar" });
			avatar.setText(this.initials(contact.name));

			const info = row.createDiv({ cls: "gmail-crm-info" });
			info.createDiv({ cls: "gmail-crm-name", text: contact.name });

			const stats = info.createDiv({ cls: "gmail-crm-stats" });
			stats.createSpan({ text: contact.email, cls: "gmail-crm-email" });
			stats.createSpan({
				text: ` \u00B7 ${contact.totalExchanges} emails`,
				cls: "gmail-crm-faded",
			});

			const dateEl = row.createDiv({ cls: "gmail-crm-date" });
			dateEl.setText(this.relativeTime(contact.lastContact));
		}

		if (contacts.length > 200) {
			listEl.createDiv({
				cls: "gmail-crm-faded",
				text: `+ ${contacts.length - 200} more (use filter)`,
			});
		}
	}

	private initials(name: string): string {
		const parts = name.split(/\s+/);
		if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
		return name.slice(0, 2).toUpperCase();
	}

	private relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}
}
