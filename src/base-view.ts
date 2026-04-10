import { Vault, TFile, normalizePath } from "obsidian";

const BASE_CONTENT = `filters:
  and:
    - staleness_label != null
properties:
  note.email:
    displayName: Email
  note.role:
    displayName: Role
  note.company:
    displayName: Company
  note.last_contact:
    displayName: Last Emailed
  note.total_exchanges:
    displayName: "# Emails"
  note.staleness_score:
    displayName: Freshness
  note.staleness_label:
    displayName: Status
  note.relationship_strength:
    displayName: Strength
  note.relationship_depth:
    displayName: Depth
  note.relationship_recency:
    displayName: Recency
  note.days_since_contact:
    displayName: Days Ago
  note.connections:
    displayName: Connections
  note.nudge:
    displayName: Nudge
  note.sent:
    displayName: Sent
  note.received:
    displayName: Received
  note.last_subject:
    displayName: Last Subject
  note.last_thread_depth:
    displayName: Thread Msgs
  note.max_thread_depth:
    displayName: Deepest Thread
  note.back_and_forth_threads:
    displayName: Conversations
  note.domain:
    displayName: Domain
views:
  - type: table
    name: CRM
    order:
      - file.name
      - company
      - last_contact
      - last_subject
      - last_thread_depth
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - staleness_label
      - nudge
    sort:
      - property: relationship_recency
        direction: ASC
    columns:
      - file.name
      - company
      - last_contact
      - last_subject
      - last_thread_depth
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - staleness_label
      - nudge
    columnSize:
      file.name: 200
      company: 160
      last_subject: 250
      nudge: 300
    summaries:
      total_exchanges: Sum
  - type: table
    name: Going Stale
    order:
      - file.name
      - company
      - last_subject
      - days_since_contact
      - relationship_depth
      - relationship_recency
      - back_and_forth_threads
      - total_exchanges
      - nudge
    filters:
      and:
        - relationship_depth >= 3
        - relationship_recency <= 2
    sort:
      - property: relationship_depth
        direction: DESC
    columns:
      - file.name
      - company
      - last_subject
      - days_since_contact
      - relationship_depth
      - relationship_recency
      - back_and_forth_threads
      - total_exchanges
      - nudge
    columnSize:
      file.name: 200
      company: 160
      last_subject: 250
      nudge: 350
  - type: table
    name: By Company
    order:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_depth
    sort:
      - property: company
        direction: ASC
      - property: relationship_depth
        direction: DESC
    columns:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_depth
    columnSize:
      file.name: 200
      company: 180
  - type: table
    name: Active
    order:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - back_and_forth_threads
    filters:
      and:
        - relationship_recency >= 4
    sort:
      - property: relationship_depth
        direction: DESC
    columns:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - back_and_forth_threads
    columnSize:
      file.name: 200
      company: 160
`;

export async function createBaseView(vault: Vault, peopleFolder: string): Promise<string> {
	const basePath = normalizePath(`${peopleFolder}/CRM.base`);
	const existing = vault.getAbstractFileByPath(basePath);
	if (existing instanceof TFile) {
		await vault.modify(existing, BASE_CONTENT);
	} else {
		await vault.create(basePath, BASE_CONTENT);
	}
	return basePath;
}
