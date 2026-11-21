# Agentic People sub-project 4: why-now, contrast, widen, bridges and the fringe atlas

Status: draft for review. It plugs into the answer envelope and `ask` from `2026-11-20-agentic-people-design.md` (sub-projects 2 and 5).

## Intent

The essay's three questions are:

- **Recency** says *when* to reconnect.
- **Context** says *why*.
- **Judgment** says *whether*.

Sub-projects 1–3 answer "tell me about Maya". Sub-project 4 answers the questions that need the *shape* of the owner's network:

| Question | Intent |
|---|---|
| "Who should I reach out to this week, and why now?" | `why_now` |
| "Who outside my usual circle would see robotics hiring differently?" | `contrast` |
| "Am I only talking to the same people?" | `widen` |
| "Who in my network should meet each other?" | `bridges` |
| "Show me the landscape around climate fintech." | `atlas` |

The fringe rule from the essay applies throughout. A fringe candidate needs **relevance to the owner's intent and distance from the owner's usual circles**. Relevance alone is the recommendation trap; distance alone is noise.

## What exists (verified 2026-11-21)

- **Co-occurrence edges.**
  - `mail_edges` holds pairs from threads with at most 20 people. It has no date; dates join through `messages` and `contributions`.
  - `granola_edges` holds meeting co-attendees.
  - Both are merged in `mergedEdges()` with person aliases applied.
  - Calendar attendees build no edges.
- **Per-message activity.**
  - `contributions(account, canonical, email, date, sent, received)` has one row per participant per message, so direction is known.
  - `granola_attendees ⨝ granola_notes.meeting_at`.
  - `calendar_events` holds `CalendarRecord {at, people[], acceptedPeople[]}` for the past year through the next 30 days.
- **Topics.**
  - `theme_signals(person_id, theme_id, observed_at, summary, …)` covers Gmail subject themes and Granola statements.
  - `helperContext()` holds first-hand work passages (building / need / experience).
  - The Lens has `{focus, needs, offers}`.
  - `searchPeople` does a keyword rank over evidence, then optional Jev scoring.
- **What does not exist.** No clustering or community detection, no embeddings, no why-now scoring (`reconnect` is oldest-first), no widen detector, and no finder for missing connections.

## Shared building block: clusters and distance

### Clusters (`NetworkClusters`)

**Graph.**
- Nodes are the owner's own graph contacts, not the owner and not shared-only people.
- An edge's weight is the number of threads plus the number of meetings that two contacts share in the last 365 days.
- Pairs whose only shared evidence is threads of more than 20 people are already excluded.

**Algorithm.** Weighted label propagation, chosen because it is deterministic, needs no dependency, and runs in O(edges × iterations):
- Nodes are visited in sorted-id order.
- Ties in label weight go to the smallest label.
- It stops after at most 20 iterations, or earlier when no label changes.

**Clusters.**
- A cluster with fewer than 3 members dissolves: its members are `unclustered`.
- Each cluster gets a stable id: the hash of its sorted member ids, truncated to 12 hex digits.
- Each cluster gets a label `{companies: top 2 company names or domains, themes: top 2 theme names among members' last-180-day theme signals}`. The label is plain data, never model text.

**Cache.** Results are stored in the owner's Durable Object, keyed by `connectionsRevision` plus the day. They are rebuilt on demand and cost at most one rebuild per revision per day.

**Limits.** At most 1,500 nodes and 5,000 edges, the existing graph caps. Above the caps, the strongest edges are kept.

### Usual circles and distance

**Usual circles.**
1. Count the owner's interactions in the last 90 days: one per email row with `sent + received > 0`, one per Granola meeting attended, and one per accepted calendar event shared with a contact.
2. Attribute each interaction to the contact's cluster.
3. The **usual circles** are the smallest set of clusters, taken largest-first, that together cover at least 60% of those interactions.

**`distance(s)`:**

| Value | When |
|---|---|
| `0` | `s` is in a usual circle and has a direct edge to one of the owner's 10 most-interacted contacts in the last 90 days |
| `0.5` | `s` is in a usual circle without such an edge, or `s` is unclustered with at most one edge into a usual circle |
| `1` | `s` is in a cluster outside the usual circles, unclustered with no edge into one, or a shared-network person reachable only through an introducer |

Every answer that uses distance carries `distance: {value, cluster: label|null, reason}`. Example reason: "Outside your usual circles: no shared threads or meetings with Acme or Beta Labs people".

## `why_now`: who to contact now, with reasons

**Candidates.** Graph nodes not suppressed, deleted, snoozed or past their `notBefore` date. Feedback, the existing judgment, is honoured.

**Triggers.** Each trigger is evidence with `source`, `observedAt` and `attribution: first_hand`:

| Trigger | Rule | Weight |
|---|---|---|
| `meeting_soon` | A calendar event with them in the next 48 hours | 3 |
| `owes_reply` | Their latest message is newer than the owner's latest message to them, received in the last 21 days, in a thread the owner was addressed in | 2 |
| `fresh_signal` | An `open` or `personal` life signal observed in the last 14 days | 2 |
| `job_move` | A stint starting in the last 60 days, or a pending job-move proposal | 2 |
| `going_cold` | Strength ≥ 50 and 75–130 days since contact, so momentum is crossing below about 40 | 1.5 |
| `topic_overlap` | A theme or work passage from them in the last 30 days that matches the Lens `focus` or `needs` keywords | 1.5 |

**Score.** $\text{score} = \sum \text{weights} \times (0.5 + \text{strength}/200)$. It returns up to 10 people with at least one trigger, highest score first.

**Rules.**
- Sensitive life signals never trigger and never rank. In a brief they remain `tone_only`.
- With no trigger anywhere, the result is empty `answers` plus a gap ("Nothing time-sensitive; `reconnect` lists people going quiet").

## `contrast`: relevant and distant, including disagreement

**Input:** `{topic, claim?}`. `claim` is an optional assumption to test, e.g. "nurses won't adopt scheduling apps".

**Steps.**
1. **Relevance.** Run `searchPeople(topic)` over evidence (keyword rank, then Jev when configured) and keep candidates with relevance ≥ 0.3.
2. **Fringe filter.** Keep candidates with `distance ≥ 0.5`. If fewer than 3 pass, the gap says so, and the nearest relevant people are returned with `distance: 0` marked.
3. **Stance (only with `claim`).** For the top 8 candidates, one Workers AI JSON-schema call labels each candidate's evidence relative to the claim as `supports`, `differs` or `challenges`, quoting nothing. The model sees only the claim and short summaries. `challenges` and `differs` rank higher (×1.25 and ×1.1): disconfirming evidence counts as relevant.
4. **Rank** by relevance × (0.5 + distance) × stance factor, and return up to 5.

## `widen`: notice a narrowing pattern

**Window.** The last 30 days of interactions, attributed to clusters as for usual circles.

**Trigger.** At least 12 interactions, and one cluster holding at least 70% of them.

**Output.**
- `pattern {cluster label, share, interactions, days: 30}`.
- **One** person outside that cluster, chosen as the highest relevance to the Lens `focus` among contacts with distance 1, strength ≥ 30 and no contact in the last 30 days. The fallback is the highest-strength such person.
- `why` cites both the pattern and that person's evidence.

**Below threshold:** empty `answers`, plus the gap "Your last 30 days are spread out (top circle N%)".

Surprise rationing (at most one `widen` or fringe moment a day) belongs to moments in sub-project 5. The direct command is always allowed.

## `bridges`: people who should know each other

**Pairs.** `(a, b)` such that:
- both have `combined ≥ 30`;
- they are in different clusters, or either is unclustered;
- no edge exists between them in `mail_edges`, `granola_edges`, `shared_edges` or recorded introductions;
- they share evidence: the same `theme_id` in the last 180 days, or at least 2 shared non-stopword keywords between their work passages.

**With `topic`.** Both people must match the topic.

**Output.** At most 5 pairs, each `{people: [a, b], sharedEvidence[], distanceBetween}`. These are proposals only: making the introduction is sub-project 6, and the answer says so in `gaps`.

**Connectors.** The result also lists up to 3 **connectors**: owner contacts with edges into at least 2 distinct clusters, ranked by the number of clusters they touch. These are the people who already link the owner's circles.

## `atlas`: the landscape around one topic

`Atlas` (typed object, `schemas/v1/atlas.json`):

```json
{
  "version": 1,
  "topic": "climate fintech",
  "generatedAt": "2026-11-21T10:00:00.000Z",
  "communities": [{"clusterId": "a1b2c3d4e5f6", "label": {"companies": ["Acme"], "themes": ["payments"]},
                   "size": 14, "usual": true, "topicPeople": 3}],
  "known": [{"personId": "p_…", "name": "Maya Rivera", "clusterId": "a1b2c3d4e5f6",
             "relevance": 0.82, "distance": 0, "evidence": [{"summary": "…", "source": "gmail", "observedAt": "…"}]}],
  "fringe": [{"personId": "p_…", "name": "…", "clusterId": null, "relevance": 0.61, "distance": 1,
              "evidence": [], "stance": null, "reach": {"kind": "direct"}}],
  "absent": [{"label": "Grid operators", "inferred": true}],
  "gaps": []
}
```

Fields:

| Field | Contents |
|---|---|
| `known` | Relevant people (relevance ≥ 0.3), at most 20 |
| `fringe` | The `contrast` selection without a claim, at most 8 |
| `communities` | Every cluster with at least one relevant member, plus the usual circles |
| `absent` | Up to 5 communities a topic like this usually involves that have no relevant member here |
| `reach` | `direct` or `via:<owner>` for shared-network people |

- `absent` comes from one model call that sees only the topic and the present community labels. Every entry is marked `inferred: true` and never names a person.
- The atlas is data for an interface, not a ranked list. The CLI prints JSON; the website may render it later.

## Surfaces

- **`ask` intents.** The new intents are `why_now`, `contrast {topic, claim?}`, `widen`, `bridges {topic?}` and `atlas {topic}`. The classifier prompt and validation gain them, and the eval set grows from 40 to 60 questions.
- **CLI (hosted):** `peoplegraph why-now [--limit 10]`, `contrast "<topic>" [--claim "<text>"]`, `widen`, `bridges [--topic "<text>"]`, `atlas "<topic>"`. Local mode returns `unsupported_locally`, because the cache has no edges or activity.
- **Routes** (`people:read`, session and machine): `GET /api/people/why-now`, `/api/people/contrast?topic=&claim=`, `/api/people/widen`, `/api/people/bridges?topic=`, `/api/people/atlas?topic=`.
- **MCP.** One new read tool, `get_atlas`. The other intents run through `ask`, which keeps the tool list small. Read tools go from 9 to 10, and read+write from 12 to 13.

## Privacy

Everything here is zone A/D: computed for the owner, from the owner's data, and shown only to the owner.
- Clusters and distances are never shared, exported to workspaces, or answered to peers or guests.
- Only `open` and `personal` life signals act as triggers, and never as quotes.
- Shared-network people appear only with what the shared network already shows the owner (`via`, band).
- Peers are never asked.

## Testing

- **Clusters.**
  - A synthetic fixture with two planted communities and one connector yields 2 clusters and the connector.
  - Identical input gives identical ids (determinism).
  - Clusters smaller than 3 dissolve.
- **Distance.** The 60% usual-circle cut, with each of the three distance values.
- **`why_now`.**
  - Each trigger, tested alone.
  - A sensitive signal never triggers.
  - Snoozed and suppressed people are excluded.
  - No triggers gives an empty answer with a gap.
- **`contrast`.**
  - The distance filter applies.
  - The stance ordering uses a mocked model, and a `challenges` candidate outranks `supports`.
  - Fewer than 3 distant candidates gives a gap.
- **`widen`.** Exactly 69% vs 70%, fewer than 12 interactions, and the one-person pick.
- **`bridges`.** Connected pairs are excluded, same-cluster pairs are excluded, and evidence is required.
- **`atlas`.**
  - Shape against the schema.
  - `absent` entries are always `inferred` and contain no person fields.
- **Partition.**
  - Cluster, distance and atlas data never reach workspace exports, peer answers or MCP write tools.
  - The MCP tool count goes to 10/13.
- **Eval.** 20 new questions, with recorded classifications.

## Out of scope

- Embeddings and vector search.
- Calendar-derived edges: noted as a follow-up option, not built.
- Visual atlas rendering.
- Moments and surprise rationing (sub-project 5).
- Making introductions (sub-project 6).
