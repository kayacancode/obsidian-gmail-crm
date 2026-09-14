import {
  emptyIntelligence,
  mergeEvents,
  type IntelligenceState,
  type Interaction,
} from "./intelligence-model";
interface Adapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}
/** Kept outside contact-index.json so older CLI versions cannot erase history. */
export class IntelligenceStore {
  state = emptyIntelligence();
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private adapter: Adapter,
    private path: string,
  ) {}
  async load() {
    if (!(await this.adapter.exists(this.path))) return;
    const value = JSON.parse(
      await this.adapter.read(this.path),
    ) as IntelligenceState;
    if (
      value.version !== 1 ||
      !Array.isArray(value.events) ||
      !Array.isArray(value.goals) ||
      !value.feedback ||
      typeof value.feedback !== "object"
    )
      throw new Error(
        "Unrecognized people intelligence file; existing data was left untouched.",
      );
    this.state = { ...value, events: mergeEvents([], value.events) };
  }
  /**
   * Saves are serialized, not staged through a temp file: Obsidian's
   * FileSystemAdapter.rename throws "Destination file already exists!" rather
   * than overwriting, so tmp+rename only ever works for the very first save.
   */
  save(): Promise<void> {
    const content = JSON.stringify(this.state);
    const write = this.pending
      .catch(() => {})
      .then(() => this.adapter.write(this.path, content));
    this.pending = write;
    return write;
  }
  async record(events: Interaction[]) {
    this.state.events = mergeEvents(this.state.events, events);
    this.state.trackingSince ??= new Date().toISOString();
    await this.save();
  }
  async replaceCalendar(events: Interaction[]) {
    // Calendar sync is an authoritative rolling one-year snapshot, including cancellations.
    const cutoff = Date.now() - 365 * 86400000;
    this.state.events = mergeEvents(
      this.state.events.filter(
        (e) => e.kind !== "meeting" || Date.parse(e.date) < cutoff,
      ),
      events,
    );
    await this.save();
  }
}
