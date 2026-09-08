import type { ContactEdge, ContactIndex } from "./types";
import {
  attention,
  identityMap,
  edgeLabel,
  introductionPaths,
  lastInteraction,
  matchGoal,
  resolvePeople,
  weeklyActivity,
  type Goal,
  type IntelligenceState,
  type Person,
  type SourcedNote,
} from "./intelligence-model";
export interface WorkspaceData {
  index: ContactIndex;
  notes: SourcedNote[];
  state: IntelligenceState;
}
export interface WorkspaceActions {
  save: () => Promise<void>;
  openNote: (path: string) => void;
  refresh: () => Promise<void>;
}
type Tab = "Attention" | "Timeline" | "Goals" | "Paths" | "Graph";
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: HTMLElement,
  text?: string,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  parent.appendChild(node);
  return node;
}
function button(
  parent: HTMLElement,
  text: string,
  action: () => void,
  cls = "pi-button",
): HTMLButtonElement {
  const b = el("button", parent, text, cls);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
function select(
  parent: HTMLElement,
  label: string,
  options: [string, string][],
  value: string,
  change: (s: string) => void,
) {
  const wrap = el("label", parent, undefined, "pi-field");
  el("span", wrap, label);
  const input = el("select", wrap);
  for (const [id, name] of options) {
    const o = el("option", input, name);
    o.value = id;
  }
  input.value = value;
  input.onchange = () => change(input.value);
  return input;
}
function dateLabel(date: string | number): string {
  const d = new Date(
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date + "T12:00:00"
      : date,
  );
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Unknown";
}
export class PeopleWorkspace {
  private tab: Tab = "Attention";
  private query = "";
  private company = "";
  private goalId = "";
  private health = "";
  private edgeType = "";
  private days = "";
  private selected = "";
  private limit = 40;
  private people: Person[] = [];
  private main!: HTMLElement;
  private panel!: HTMLElement;
  private results!: HTMLElement;
  private status!: HTMLElement;
  private goalCache = new Map<string, ReturnType<typeof matchGoal>>();
  constructor(
    private root: HTMLElement,
    private data: WorkspaceData,
    private actions: WorkspaceActions,
  ) {
    this.update(data);
  }
  update(data: WorkspaceData) {
    this.data = data;
    this.people = resolvePeople(data.index, data.notes, data.state.events);
    this.goalCache.clear();
    this.render();
  }
  destroy() {
    this.root.replaceChildren();
  }
  private match(p: Person, g: Goal) {
    const key = p.contact.email + "\n" + g.id;
    let m = this.goalCache.get(key);
    if (!m) {
      m = matchGoal(p, g);
      this.goalCache.set(key, m);
    }
    return m;
  }
  private async save() {
    try {
      await this.actions.save();
      this.status.textContent = "Saved locally";
    } catch (e) {
      this.status.textContent = `Could not save changes: ${e instanceof Error ? e.message : String(e)}. Retry saving before closing.`;
      button(this.status, "Retry save", () => void this.save());
    }
  }
  private render() {
    this.root.replaceChildren();
    this.root.classList.add("pi-workspace");
    const header = el("header", this.root, undefined, "pi-header");
    const title = el("div", header);
    el("div", title, "PEOPLE / RELATIONSHIP INTELLIGENCE", "pi-eyebrow");
    el("h1", title, "Your people, in context.");
    el(
      "p",
      title,
      `${this.people.length.toLocaleString()} people · ${this.data.state.events.length.toLocaleString()} recorded interactions · Synced ${dateLabel(this.data.index.lastSync)}`,
      "pi-muted",
    );
    const refresh = button(header, "↻ Refresh", () => {
      refresh.disabled = true;
      void this.actions
        .refresh()
        .catch((e) => {
          this.status.textContent = `Refresh failed: ${String(e)}`;
        })
        .finally(() => {
          refresh.disabled = false;
        });
    });
    this.status = el("div", this.root, undefined, "pi-status");
    this.status.setAttribute("role", "status");
    const nav = el("nav", this.root, undefined, "pi-tabs");
    nav.setAttribute("aria-label", "People views");
    for (const tab of [
      "Attention",
      "Timeline",
      "Goals",
      "Paths",
      "Graph",
    ] as Tab[]) {
      const b = button(
        nav,
        tab,
        () => {
          this.tab = tab;
          this.limit = 40;
          this.render();
        },
        `pi-tab ${this.tab === tab ? "is-active" : ""}`,
      );
      b.setAttribute("aria-current", String(this.tab === tab));
    }
    const toolbar = el("div", this.root, undefined, "pi-toolbar");
    const search = el("input", toolbar);
    search.type = "search";
    search.placeholder = "Find a person, company or role…";
    search.setAttribute("aria-label", "Search people");
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.limit = 40;
      this.renderResults();
    };
    const companies = [
      ...new Set(
        this.people
          .map(
            (p) => p.contact.company || p.contact.orgName || p.contact.domain,
          )
          .filter(Boolean),
      ),
    ].sort();
    select(
      toolbar,
      "Company",
      [
        ["", "All companies"],
        ...companies.map((c) => [c, c] as [string, string]),
      ],
      this.company,
      (v) => {
        this.company = v;
        this.limit = 40;
        this.renderResults();
      },
    );
    select(
      toolbar,
      "Goal",
      [
        ["", "All goals"],
        ...this.data.state.goals.map(
          (g) => [g.id, g.title] as [string, string],
        ),
      ],
      this.goalId,
      (v) => {
        this.goalId = v;
        this.limit = 40;
        this.renderResults();
        this.renderPanel();
      },
    );
    select(
      toolbar,
      "Relationship",
      [
        ["", "All activity"],
        ["quiet", "Worth reconnecting"],
        ["growing", "Activity increasing"],
        ["slowing", "Activity slowing"],
        ["important", "Marked important"],
        ["later", "Saved for later"],
      ],
      this.health,
      (v) => {
        this.health = v;
        this.renderResults();
      },
    );
    button(toolbar, "Reset filters", () => {
      this.query = "";
      this.company = "";
      this.goalId = "";
      this.health = "";
      this.days = "";
      this.edgeType = "";
      this.render();
    });
    const layout = el("div", this.root, undefined, "pi-layout");
    this.main = el("main", layout, undefined, "pi-main");
    this.panel = el("aside", layout, undefined, "pi-panel");
    this.panel.setAttribute("aria-label", "Person details");
    this.renderResults();
    this.renderPanel();
  }
  private filtered() {
    const q = this.query.toLocaleLowerCase();
    const goal = this.data.state.goals.find((g) => g.id === this.goalId);
    return this.people
      .filter((p) => {
        const c = p.contact;
        const company = c.company || c.orgName || c.domain;
        if (this.company && company !== this.company) return false;
        if (
          q &&
          ![c.name, c.email, company, c.role, c.orgTitle]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(q)
        )
          return false;
        if (goal && !this.match(p, goal).score) return false;
        if (this.health === "important" || this.health === "later")
          return this.data.state.feedback[c.email] === this.health;
        return (
          !this.health ||
          attention(p, Date.now(), this.data.state.trackingSince).kind ===
            this.health
        );
      })
      .sort((a, b) => {
        const importance = (p: Person) =>
          this.data.state.feedback[p.contact.email] === "important"
            ? 100
            : this.data.state.feedback[p.contact.email] === "later"
              ? -100
              : 0;
        return (
          (goal ? this.match(b, goal).score - this.match(a, goal).score : 0) ||
          importance(b) - importance(a) ||
          attention(b, Date.now(), this.data.state.trackingSince).priority -
            attention(a, Date.now(), this.data.state.trackingSince).priority ||
          a.contact.name.localeCompare(b.contact.name)
        );
      });
  }
  private renderResults() {
    this.main.replaceChildren();
    const people = this.filtered();
    const descriptions: Record<Tab, [string, string]> = {
      Attention: [
        "Where to put your attention",
        "Evidence and context for your next conversation. Mark the relationships that matter to you.",
      ],
      Timeline: [
        "Relationships over time",
        "12 weeks of recorded email and mutually accepted calendar events. Blank cells mean no recorded events, not proof of no contact.",
      ],
      Goals: [
        "The right people for your work",
        "Match explicit keywords or phrases against profiles and sourced notes. Subject matches are hints, not established expertise.",
      ],
      Paths: [
        "Find a way in",
        "Potential connectors supported by introductions or shared meetings. Every route needs a human check.",
      ],
      Graph: [
        "Explore your connections",
        "A focused neighborhood around a selected person. Line styles distinguish documented connections from note references.",
      ],
    };
    el("h2", this.main, descriptions[this.tab][0]);
    el("p", this.main, descriptions[this.tab][1], "pi-muted");
    if (this.tab === "Goals") this.goalEditor();
    if (this.tab === "Timeline")
      el(
        "p",
        this.main,
        this.data.state.trackingSince
          ? `Email tracking began ${dateLabel(this.data.state.trackingSince)}. Historical imports may be partial. Calendar sync supplies up to one year of accepted events.`
          : this.data.state.events.length
            ? "Imported interaction history is available. Run Gmail sync to start tracking email activity. Historical coverage may be partial."
            : "No interaction history yet. Run Gmail sync and calendar sync to begin recording. Existing totals are not plotted as historical events.",
        "pi-notice",
      );
    el(
      "p",
      this.main,
      `${people.length.toLocaleString()} matching people`,
      "pi-count",
    );
    this.results = el("div", this.main, undefined, "pi-results");
    if (!people.length) {
      el(
        "div",
        this.results,
        "No matching people. Try resetting filters, or sync contacts if your index is empty.",
        "pi-empty",
      );
      return;
    }
    if (this.tab === "Paths") {
      this.paths(people);
      return;
    }
    if (this.tab === "Graph") {
      this.graph(people);
      return;
    }
    const visible = people.slice(0, this.limit);
    if (this.tab === "Attention")
      for (const p of visible) this.attentionCard(p);
    if (this.tab === "Timeline") this.timeline(visible);
    if (this.tab === "Goals") this.matrix(visible);
    if (people.length > this.limit)
      button(
        this.main,
        `Show next ${Math.min(40, people.length - this.limit)} people`,
        () => {
          this.limit += 40;
          this.renderResults();
        },
      );
  }
  private choose(p: Person) {
    this.selected = p.contact.email;
    this.renderPanel();
    if (this.tab === "Paths" || this.tab === "Graph") this.renderResults();
    if (this.root.clientWidth < 740)
      this.panel.scrollIntoView({ block: "start" });
  }
  private personButton(parent: HTMLElement, p: Person) {
    const b = button(
      parent,
      p.contact.name || p.contact.email,
      () => this.choose(p),
      "pi-person",
    );
    b.setAttribute("aria-label", `View ${p.contact.name || p.contact.email}`);
    return b;
  }
  private attentionCard(p: Person) {
    const a = attention(p, Date.now(), this.data.state.trackingSince);
    const card = el("article", this.results, undefined, "pi-card");
    const identity = el("div", card, undefined, "pi-card-title");
    el(
      "span",
      identity,
      (p.contact.name || p.contact.email)
        .split(/\s+/)
        .map((s) => s[0])
        .slice(0, 2)
        .join("")
        .toUpperCase(),
      "pi-avatar",
    );
    const heading = el("div", identity);
    this.personButton(heading, p);
    el(
      "div",
      heading,
      p.contact.role ||
        p.contact.orgTitle ||
        p.contact.company ||
        p.contact.orgName ||
        p.contact.email,
      "pi-muted",
    );
    el("span", identity, a.label, `pi-badge pi-${a.kind}`);
    el("p", card, a.reason);
    const goal = this.data.state.goals.find((g) => g.id === this.goalId);
    if (goal) {
      const m = this.match(p, goal);
      el(
        "p",
        card,
        `${goal.title}: ${m.evidence[0]?.text ?? "No evidence"}`,
        "pi-context",
      );
    }
    const bottom = el("div", card, undefined, "pi-card-bottom");
    this.sparkline(bottom, p);
    el(
      "span",
      bottom,
      this.data.state.feedback[p.contact.email] === "important"
        ? "★ Important"
        : this.data.state.feedback[p.contact.email] === "later"
          ? "Saved for later"
          : "12 weeks of recorded activity",
      "pi-muted",
    );
  }
  private sparkline(parent: HTMLElement, p: Person) {
    const wrap = el("div", parent, undefined, "pi-sparkline");
    const weeks = weeklyActivity(p.events);
    const max = Math.max(1, ...weeks.map((w) => w.emails + w.meetings));
    wrap.setAttribute("role", "img");
    wrap.setAttribute(
      "aria-label",
      `Weekly recorded activity: ${weeks.map((w) => w.emails + w.meetings).join(", ")}`,
    );
    for (const w of weeks) {
      const bar = el("span", wrap);
      bar.style.height = `${Math.max(2, ((w.emails + w.meetings) / max) * 28)}px`;
      bar.className = w.emails + w.meetings ? "has-events" : "";
      bar.title = `Week of ${w.start}: ${w.emails} emails, ${w.meetings} meetings`;
    }
  }
  private timeline(people: Person[]) {
    const scroll = el("div", this.results, undefined, "pi-table-scroll");
    const table = el("table", scroll, undefined, "pi-timeline");
    const head = el("tr", el("thead", table));
    el("th", head, "Person");
    for (const week of weeklyActivity([]))
      el("th", head, dateLabel(week.start).replace(/, \d{4}/, ""));
    const body = el("tbody", table);
    for (const p of people) {
      const row = el("tr", body);
      const name = el("th", row);
      name.scope = "row";
      this.personButton(name, p);
      for (const w of weeklyActivity(p.events)) {
        const cell = el("td", row);
        const n = w.emails + w.meetings;
        const b = button(
          cell,
          n ? String(n) : "·",
          () => {
            this.choose(p);
            if (n) this.showWeek(p, w.start, w.events);
          },
          `pi-heat pi-heat-${n === 0 ? 0 : n < 3 ? 1 : n < 7 ? 2 : 3}`,
        );
        b.title = `${p.contact.name}, week of ${w.start}: ${w.emails} emails and ${w.meetings} meetings`;
        b.setAttribute("aria-label", b.title);
      }
    }
    el(
      "p",
      this.results,
      "Lighter → darker = more recorded activity. Select a cell to inspect its events.",
      "pi-muted",
    );
  }
  private showWeek(p: Person, start: string, events: Person["events"]) {
    const section = this.inspection();
    el("h3", section, `Week of ${dateLabel(start)}`);
    this.eventList(section, events);
  }
  private inspection() {
    const section = document.createElement("section");
    section.className = "pi-inspection";
    this.panel.insertBefore(section, this.panel.querySelector(".pi-stats"));
    return section;
  }
  private goalEditor() {
    const details = el("details", this.main, undefined, "pi-goal-editor");
    details.open = this.data.state.goals.length === 0;
    el("summary", details, `Manage goals (${this.data.state.goals.length})`);
    for (const g of this.data.state.goals) {
      const row = el("div", details, undefined, "pi-goal-row");
      el("strong", row, g.title);
      el("span", row, g.terms.join(", "), "pi-muted");
      button(row, "Edit", () => {
        name.value = g.title;
        terms.value = g.terms.join(", ");
        editing = g.id;
        submit.textContent = "Save goal";
        name.focus();
      });
      button(row, "Remove", () => {
        this.data.state.goals = this.data.state.goals.filter(
          (x) => x.id !== g.id,
        );
        if (this.goalId === g.id) this.goalId = "";
        this.goalCache.clear();
        this.render();
        void this.save();
      });
    }
    const form = el("form", details, undefined, "pi-goal-form");
    let editing = "";
    const nameLabel = el("label", form, "Goal name");
    const name = el("input", nameLabel);
    name.required = true;
    name.maxLength = 100;
    name.placeholder = "Find developer-tool design partners";
    const termsLabel = el(
      "label",
      form,
      "Keywords or phrases, separated by commas",
    );
    const terms = el("input", termsLabel);
    terms.required = true;
    terms.maxLength = 500;
    terms.placeholder = "developer infrastructure, CTO, platform engineering";
    const submit = el("button", form, "Add goal", "pi-button");
    submit.type = "submit";
    form.onsubmit = (e) => {
      e.preventDefault();
      const title = name.value.trim();
      const values = [
        ...new Set(
          terms.value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ].slice(0, 20);
      if (!title || !values.length) {
        terms.setCustomValidity("Enter at least one keyword or phrase.");
        terms.reportValidity();
        return;
      }
      terms.setCustomValidity("");
      const goal = { id: editing || crypto.randomUUID(), title, terms: values };
      const old = this.data.state.goals.findIndex((g) => g.id === editing);
      if (old >= 0) this.data.state.goals[old] = goal;
      else this.data.state.goals.push(goal);
      this.goalCache.clear();
      this.render();
      void this.save();
    };
    terms.oninput = () => terms.setCustomValidity("");
  }
  private matrix(people: Person[]) {
    if (!this.data.state.goals.length) {
      el(
        "div",
        this.results,
        "Add your first goal above. Choose phrases you expect to find in your people notes or profiles.",
        "pi-empty",
      );
      return;
    }
    const table = el(
      "table",
      el("div", this.results, undefined, "pi-table-scroll"),
      undefined,
      "pi-matrix",
    );
    const head = el("tr", el("thead", table));
    el("th", head, "Person");
    for (const goal of this.data.state.goals) el("th", head, goal.title);
    for (const p of people) {
      const row = el("tr", elBody(table));
      const name = el("th", row);
      name.scope = "row";
      this.personButton(name, p);
      for (const goal of this.data.state.goals) {
        const m = this.match(p, goal);
        const td = el("td", row);
        const b = button(
          td,
          m.score >= 60 ? "● Evidence" : m.score ? "◌ Hint" : "—",
          () => {
            this.selected = p.contact.email;
            this.renderPanel();
            const section = this.inspection();
            el("h3", section, goal.title);
            this.evidenceList(section, m.evidence);
          },
          `pi-match ${m.score >= 60 ? "pi-match-strong" : m.score ? "pi-match-hint" : ""}`,
        );
        b.title =
          m.evidence.map((e) => e.text).join("\n") || "No matching evidence";
      }
    }
  }
  private targetPicker(people: Person[]) {
    const selected =
      people.find((p) => p.contact.email === this.selected) ?? people[0];
    const changed = this.selected !== selected.contact.email;
    this.selected = selected.contact.email;
    if (changed) this.renderPanel();
    select(
      this.results,
      "Focus person",
      people.map((p) => [p.contact.email, p.contact.name || p.contact.email]),
      this.selected,
      (v) => {
        this.selected = v;
        this.renderResults();
        this.renderPanel();
      },
    );
    return selected;
  }
  private paths(people: Person[]) {
    const target = this.targetPicker(people);
    const routes = introductionPaths(
      this.people,
      this.data.index.edges,
      target.contact.email,
    );
    el(
      "p",
      this.results,
      "These are potential routes through people you have exchanged messages with. Shared attendance does not establish a close relationship.",
      "pi-notice",
    );
    if (!routes.length) {
      el(
        "div",
        this.results,
        "No supported introduction paths for this person. Run relationship mapping or add a documented introduction to your notes. Incidental mentions are excluded.",
        "pi-empty",
      );
      return;
    }
    for (const route of routes.slice(0, this.limit)) {
      const card = el("article", this.results, undefined, "pi-path");
      const chain = el("div", card, undefined, "pi-path-chain");
      el("span", chain, "You", "pi-you");
      el("span", chain, "→");
      this.personButton(chain, route.connector);
      el("span", chain, "→");
      this.personButton(chain, target);
      el("span", card, edgeLabel(route.edge), "pi-badge");
      el("p", card, route.reason);
    }
    if (routes.length > this.limit)
      button(this.results, "Show more routes", () => {
        this.limit += 40;
        this.renderResults();
      });
  }
  private graph(people: Person[]) {
    const focus = this.targetPicker(people);
    const controls = el("div", this.results, undefined, "pi-toolbar");
    select(
      controls,
      "Connection",
      [
        ["", "All evidence"],
        ["introduced", "Introductions"],
        ["shared_meeting", "Shared meetings"],
        ["wiki_link", "Note links"],
        ["text_mention", "Mentions"],
      ],
      this.edgeType,
      (v) => {
        this.edgeType = v;
        this.renderResults();
      },
    );
    select(
      controls,
      "People active within",
      [
        ["", "Any time"],
        ["30", "30 days"],
        ["90", "90 days"],
        ["365", "One year"],
      ],
      this.days,
      (v) => {
        this.days = v;
        this.renderResults();
      },
    );
    const allowed = identityMap(people);
    const groups = new Map<string, { person: Person; edges: ContactEdge[] }>();
    for (const edge of this.data.index.edges) {
      const a = allowed.get(edge.sourceEmail.toLowerCase()),
        b = allowed.get(edge.targetEmail.toLowerCase());
      const other = a === focus ? b : b === focus ? a : undefined;
      if (!other || other === focus) continue;
      if (
        this.edgeType &&
        edge.type !== this.edgeType &&
        !(this.edgeType === "introduced" && edge.type === "introduced_by")
      )
        continue;
      const last = lastInteraction(other);
      if (
        this.days &&
        (last === null || Date.now() - last > Number(this.days) * 86400000)
      )
        continue;
      const entry = groups.get(other.contact.email) ?? {
        person: other,
        edges: [],
      };
      entry.edges.push(edge);
      groups.set(other.contact.email, entry);
    }
    const neighbors = [...groups.values()].slice(0, 16);
    if (!neighbors.length) {
      el(
        "div",
        this.results,
        "No connections match these filters. Refresh after mapping relationships in Obsidian, or choose another person.",
        "pi-empty",
      );
      return;
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 800 480");
    svg.setAttribute("class", "pi-graph");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      `Connections around ${focus.contact.name}. Use the connection buttons below for details.`,
    );
    this.results.appendChild(svg);
    const draw = (
      tag: string,
      attrs: Record<string, string>,
      text?: string,
    ) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      svg.appendChild(n);
      return n;
    };
    const coords = neighbors.map((_, i) => ({
      x: 400 + 290 * Math.cos((2 * Math.PI * i) / neighbors.length),
      y: 240 + 175 * Math.sin((2 * Math.PI * i) / neighbors.length),
    }));
    neighbors.forEach((n, i) => {
      const { x, y } = coords[i];
      const strong = n.edges.some((e) =>
        ["introduced", "introduced_by", "shared_meeting"].includes(e.type),
      );
      draw("line", {
        x1: "400",
        y1: "240",
        x2: String(x),
        y2: String(y),
        class: strong ? "pi-edge" : "pi-edge pi-edge-weak",
      });
    });
    draw("circle", { cx: "400", cy: "240", r: "32", class: "pi-node-focus" });
    draw(
      "text",
      { x: "400", y: "289", "text-anchor": "middle", class: "pi-node-label" },
      focus.contact.name,
    );
    neighbors.forEach((n, i) => {
      const { x, y } = coords[i];
      const node = draw("circle", {
        cx: String(x),
        cy: String(y),
        r: "18",
        class: "pi-node",
        role: "button",
        tabindex: "0",
        "aria-label": `Focus ${n.person.contact.name}`,
      });
      node.addEventListener("click", () => this.choose(n.person));
      node.addEventListener("keydown", (event) => {
        const e = event as KeyboardEvent;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.choose(n.person);
        }
      });
      draw(
        "text",
        {
          x: String(x),
          y: String(y + 34),
          "text-anchor": "middle",
          class: "pi-node-label",
        },
        n.person.contact.name.length > 24
          ? n.person.contact.name.slice(0, 22) + "…"
          : n.person.contact.name,
      );
    });
    el(
      "p",
      this.results,
      `Solid: introductions / shared meetings · Dashed: note references. Showing ${neighbors.length} of ${groups.size} neighbors; narrow filters for larger networks.`,
      "pi-muted",
    );
    for (const n of neighbors) {
      const row = el("div", this.results, undefined, "pi-edge-row");
      this.personButton(row, n.person);
      for (const edge of n.edges) {
        const b = button(
          row,
          edgeLabel(edge),
          () => {
            this.selected = n.person.contact.email;
            this.renderPanel();
            const section = this.inspection();
            el("h3", section, "Connection evidence");
            el("p", section, edge.context);
          },
          "pi-evidence-button",
        );
        b.title = edge.context;
      }
    }
  }
  private renderPanel() {
    this.panel.replaceChildren();
    const p = this.people.find((p) => p.contact.email === this.selected);
    if (!p) {
      el(
        "div",
        this.panel,
        "A person, with the full picture.",
        "pi-panel-placeholder",
      );
      el(
        "p",
        this.panel,
        "Select someone in any view to see the relationship, evidence, and possible next step.",
        "pi-muted",
      );
      return;
    }
    button(this.panel, "Close details", () => {
      this.selected = "";
      this.renderPanel();
    });
    el("h2", this.panel, p.contact.name || p.contact.email);
    el(
      "p",
      this.panel,
      p.contact.role ||
        p.contact.orgTitle ||
        p.contact.company ||
        p.contact.orgName ||
        "",
      "pi-muted",
    );
    el("p", this.panel, p.contact.email, "pi-email");
    if (p.contact.aliases?.length)
      el(
        "p",
        this.panel,
        `Other addresses: ${p.contact.aliases.join(", ")}`,
        "pi-muted",
      );
    const a = attention(p, Date.now(), this.data.state.trackingSince);
    el("span", this.panel, a.label, "pi-badge");
    el("p", this.panel, a.reason);
    const stats = el("div", this.panel, undefined, "pi-stats");
    for (const [label, value] of [
      ["Sent", p.contact.sentCount],
      ["Received", p.contact.receivedCount],
      ["Meetings", p.contact.calendarAccepted ?? 0],
    ]) {
      const stat = el("div", stats);
      el("strong", stat, String(value));
      el("span", stat, String(label));
    }
    const feedback = el("div", this.panel, undefined, "pi-toolbar");
    for (const [value, label] of [
      ["important", "★ Important"],
      ["later", "Later"],
    ] as const) {
      const b = button(feedback, label, () => {
        if (this.data.state.feedback[p.contact.email] === value)
          delete this.data.state.feedback[p.contact.email];
        else this.data.state.feedback[p.contact.email] = value;
        this.renderResults();
        this.renderPanel();
        void this.save();
      });
      b.setAttribute(
        "aria-pressed",
        String(this.data.state.feedback[p.contact.email] === value),
      );
    }
    el("h3", this.panel, "Possible next step");
    el(
      "p",
      this.panel,
      a.kind === "quiet"
        ? "Review your last conversation and choose a reason to reconnect."
        : this.goalId
          ? "Review the goal evidence below before deciding whether to reach out."
          : "Read the latest context, or explore a potential connector.",
    );
    button(this.panel, "Explore introduction paths", () => {
      this.tab = "Paths";
      this.render();
    });
    for (const goal of this.data.state.goals) {
      const m = this.match(p, goal);
      if (!m.score) continue;
      el("h3", this.panel, goal.title);
      this.evidenceList(this.panel, m.evidence);
    }
    el("h3", this.panel, "Source notes");
    if (!p.notes.length)
      el(
        "p",
        this.panel,
        "No notes linked by an exact email or saved alias.",
        "pi-muted",
      );
    for (const note of p.notes) {
      button(
        this.panel,
        note.path,
        () => this.actions.openNote(note.path),
        "pi-note-link",
      );
      el(
        "p",
        this.panel,
        note.text.replace(/^---[\s\S]*?---\s*/, "").slice(0, 450),
        "pi-note-excerpt",
      );
    }
    el("h3", this.panel, "Recorded interactions");
    const history = el("div", this.panel);
    const sorted = [...p.events].sort(
      (a, b) => Date.parse(b.date) - Date.parse(a.date),
    );
    this.eventList(history, sorted.slice(0, 8));
    if (p.events.length > 8)
      button(
        this.panel,
        `Show ${Math.min(30, p.events.length)} recent events`,
        () => {
          history.replaceChildren();
          this.eventList(history, sorted.slice(0, 30));
        },
      );
  }
  private evidenceList(
    parent: HTMLElement,
    evidence: ReturnType<typeof matchGoal>["evidence"],
  ) {
    if (!evidence.length) el("p", parent, "No matching evidence.", "pi-muted");
    for (const e of evidence) {
      const box = el("div", parent, undefined, "pi-evidence");
      el(
        "span",
        box,
        e.source === "subject"
          ? "Subject hint · verify relevance"
          : e.source === "note"
            ? "From your notes · verify currency"
            : "Contact profile",
        "pi-eyebrow",
      );
      el("p", box, e.text);
      if (e.path)
        button(
          box,
          "Open source note",
          () => this.actions.openNote(e.path!),
          "pi-note-link",
        );
    }
  }
  private eventList(parent: HTMLElement, events: Person["events"]) {
    if (!events.length)
      el(
        "p",
        parent,
        "No events recorded for this period. Sync to collect metadata; past totals cannot establish a timeline.",
        "pi-muted",
      );
    for (const event of events) {
      const item = el("div", parent, undefined, "pi-event");
      el(
        "span",
        item,
        `${dateLabel(event.date)} · ${event.kind === "meeting" ? "Mutually accepted meeting" : event.direction === "sent" ? "Sent email" : "Received email"}`,
        "pi-muted",
      );
      el("div", item, event.title || "(No subject)");
      if (event.kind === "email") {
        const link = el("a", item, "Open email thread");
        link.href = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(this.data.index.userEmail)}#all/${encodeURIComponent(event.sourceId)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
  }
}
function elBody(table: HTMLTableElement) {
  return table.tBodies[0] ?? el("tbody", table);
}
