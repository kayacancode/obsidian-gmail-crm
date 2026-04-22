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
  note.recent_subjects:
    displayName: Recent Subjects
  note.last_thread_depth:
    displayName: Thread Msgs
  note.max_thread_depth:
    displayName: Deepest Thread
  note.back_and_forth_threads:
    displayName: Conversations
  note.domain:
    displayName: Domain
  note.strength_score:
    displayName: Strength
  note.momentum_score:
    displayName: Momentum
  note.quadrant:
    displayName: Quadrant
views:
  - type: table
    name: CRM
    order:
      - file.name
      - company
      - last_contact
      - recent_subjects
      - last_thread_depth
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - staleness_label
      - quadrant
      - nudge
    sort:
      - property: strength_score
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - recent_subjects
      - last_thread_depth
      - total_exchanges
      - strength_score
      - momentum_score
      - quadrant
      - nudge
    columnSize:
      file.name: 200
      company: 160
      recent_subjects: 350
      nudge: 300
    summaries:
      total_exchanges: Sum
  - type: table
    name: Re-engage
    order:
      - file.name
      - company
      - recent_subjects
      - days_since_contact
      - strength_score
      - momentum_score
      - back_and_forth_threads
      - total_exchanges
      - nudge
    filters:
      and:
        - quadrant = re-engage
    sort:
      - property: strength_score
        direction: DESC
    columns:
      - file.name
      - company
      - recent_subjects
      - days_since_contact
      - strength_score
      - momentum_score
      - back_and_forth_threads
      - total_exchanges
      - nudge
    columnSize:
      file.name: 200
      company: 160
      recent_subjects: 350
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
    name: Nurture
    order:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - back_and_forth_threads
    filters:
      and:
        - quadrant = nurture
    sort:
      - property: strength_score
        direction: DESC
    columns:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - back_and_forth_threads
    columnSize:
      file.name: 200
      company: 160
  - type: table
    name: Developing
    order:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - quadrant
    filters:
      and:
        - quadrant = developing
    sort:
      - property: momentum_score
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
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
		try {
			await vault.create(basePath, BASE_CONTENT);
		} catch {
			// File already exists but wasn't indexed yet
			await vault.adapter.write(basePath, BASE_CONTENT);
		}
	}
	return basePath;
}
