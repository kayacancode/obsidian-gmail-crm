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
      - total_exchanges
      - staleness_label
      - relationship_strength
      - days_since_contact
      - nudge
    sort:
      - property: days_since_contact
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - last_subject
      - total_exchanges
      - staleness_label
      - relationship_strength
      - days_since_contact
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
      - total_exchanges
      - relationship_strength
      - nudge
    filters:
      and:
        - relationship_strength = "strong" OR relationship_strength = "moderate"
        - staleness_label = "stale" OR staleness_label = "dormant" OR staleness_label = "cooling"
    sort:
      - property: total_exchanges
        direction: DESC
    columns:
      - file.name
      - company
      - last_subject
      - days_since_contact
      - total_exchanges
      - relationship_strength
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
      - relationship_strength
    sort:
      - property: company
        direction: ASC
      - property: total_exchanges
        direction: DESC
    columns:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_strength
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
      - sent
      - received
    filters:
      and:
        - staleness_label = "active" OR staleness_label = "warm"
    sort:
      - property: last_contact
        direction: DESC
    columns:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - sent
      - received
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
