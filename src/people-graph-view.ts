import { shell } from "electron";
import { ItemView, type WorkspaceLeaf } from "obsidian";

export const PEOPLE_GRAPH_VIEW = "gmail-crm-people-graph";

/** Hosted content stays isolated from the vault and plugin JavaScript. */
export class PeopleGraphView extends ItemView {
 constructor(leaf: WorkspaceLeaf, private readonly getUrl: () => string | null) {
  super(leaf);
 }
 private stopListening?: () => void;
 getViewType() { return PEOPLE_GRAPH_VIEW; }
 getDisplayText() { return "People graph"; }
 getIcon() { return "git-fork"; }
 async onOpen() { this.render(); }
 private render() {
  this.stopListening?.();
  const root = this.contentEl;
  root.empty();
  root.addClass("gmail-crm-people-graph");
  const toolbar = root.createDiv({ cls: "gmail-crm-people-graph-toolbar" });
  const refresh = toolbar.createEl("button", { text: "Refresh" });
  refresh.onclick = () => this.render();
  const browser = toolbar.createEl("button", { text: "Open in browser" });
  browser.onclick = () => {
   const url = this.getUrl();
   if (url) void shell.openExternal(url);
  };
  root.createEl("p", {
   cls: "gmail-crm-people-graph-help",
   text: "Online people workspace. Choose your shared network in the app. Sign in using your browser, approve the connection, then return here.",
  });
  const url = this.getUrl();
  browser.disabled = !url;
  if (!url) {
   root.createEl("p", { text: "Set a valid HTTP or HTTPS graph URL in plugin settings, then refresh." });
   return;
  }
  const frame = root.createEl("iframe", { cls: "gmail-crm-people-graph-frame" });
  frame.title = "People personal and shared networks";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads");
  frame.referrerPolicy = "no-referrer";
  const embedded = new URL(url);
  embedded.searchParams.set("obsidian", "1");
  const receive = (event: MessageEvent<unknown>) => {
   const data = event.data;
   if (!data || typeof data !== "object" || !("type" in data) || !("url" in data) || typeof data.url !== "string") return;
   if (event.source !== frame.contentWindow || event.origin !== embedded.origin || data.type !== "people:browser-signin") return;
   try {
    const target = new URL(data.url);
    if (target.origin !== embedded.origin || target.pathname !== "/desktop-signin.html" || !/^#[a-f0-9]{64}$/.test(target.hash)) return;
    void shell.openExternal(target.href);
   } catch { /* Ignore malformed remote messages. */ }
  };
  window.addEventListener("message", receive);
  this.stopListening = () => window.removeEventListener("message", receive);
  frame.src = embedded.href;
 }
 async onClose() { this.stopListening?.(); this.stopListening = undefined; this.contentEl.empty(); }
}
