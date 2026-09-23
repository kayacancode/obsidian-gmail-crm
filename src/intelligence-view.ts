import { ItemView, type WorkspaceLeaf } from "obsidian";
import {
  PeopleWorkspace,
  type WorkspaceActions,
  type WorkspaceData,
} from "./intelligence-workspace";
export const PEOPLE_INTELLIGENCE_VIEW = "gmail-crm-intelligence";
export class PeopleIntelligenceView extends ItemView {
  private workspace?: PeopleWorkspace;
  private generation = 0;
  constructor(
    leaf: WorkspaceLeaf,
    private loadData: (refreshNotes?: boolean) => Promise<WorkspaceData>,
    private actions: Omit<WorkspaceActions, "refresh">,
  ) {
    super(leaf);
  }
  getViewType() {
    return PEOPLE_INTELLIGENCE_VIEW;
  }
  getDisplayText() {
    return "People intelligence";
  }
  getIcon() {
    return "users";
  }
  async onOpen() {
    await this.refresh();
  }
  async refresh(refreshNotes = true) {
    const generation = ++this.generation;
    const root = this.contentEl;
    try {
      const data = await this.loadData(refreshNotes);
      if (generation !== this.generation) return;
      if (this.workspace) this.workspace.update(data);
      else
        this.workspace = new PeopleWorkspace(root, data, {
          ...this.actions,
          refresh: () => this.refresh(),
        });
    } catch (e) {
      if (generation !== this.generation) return;
      root.replaceChildren();
      const error = document.createElement("p");
      error.textContent = `Could not load people intelligence: ${e instanceof Error ? e.message : String(e)}`;
      root.appendChild(error);
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.onclick = () => void this.refresh();
      root.appendChild(retry);
      this.workspace = undefined;
    }
  }
  async onClose() {
    this.generation++;
    this.workspace?.destroy();
    this.workspace = undefined;
  }
}
