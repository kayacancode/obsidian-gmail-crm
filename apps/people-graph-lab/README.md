# People graph visualization lab

Three experimental browser views using the existing web graph payload shape:

- **Connector Atlas:** company clusters, relationship edges, introduction rings.
- **Relationship Pulse:** strength versus days since last contact; unknown dates/scores have a separate lane.
- **Context Orbits:** search names, companies, or edge context and reorganize the matching network.

Run from the repository root:

```sh
python3 -m http.server 4182 --bind 127.0.0.1 --directory apps/people-graph-lab
```

Open http://127.0.0.1:4182. This is a local prototype, not a deployed update to the Settings link.
The default network is fictional. **Open graph JSON** accepts an existing `GraphPayload` or `{graph: GraphPayload}`; files are parsed in memory, not uploaded or persisted. No new raw email or note exports are needed.

Click a person for evidence, use topic chips or search, and switch views while retaining the selection. Connector reach counts distinct companies among neighbors. Introduction counts are incident edges tagged `introduced` or `introduced_by`; the merged snapshot does not establish introduction direction or success. Context matching is literal text matching, not semantic AI retrieval. Scores and dates come from the snapshot; no trend or event history is inferred.

The lab accepts up to 1,500 nodes / 20,000 edges but the visual design is optimized for small filtered networks. Dense graph layout and unknown-date lane overlap are prototype limitations. The production authenticated viewer remains in `apps/people-graph` on the release branch. Integration/deployment is a separate step after choosing a direction.

```sh
node --test apps/people-graph-lab/model.test.mjs
```

D3 v7 is reused from the existing web viewer; its license header is retained.

## Spatial discovery

Open `spatial.html` for a fourth experiment inspired by the supplied wireframes: a perspective-projected 3D scene with orbit and zoom controls, plus a results → person → company → editable local draft flow and session-only shortlist. Soft gradient background and translucent context cards. All people, memories, locations, and company updates are fictional. Three curated query scenarios are supported; arbitrary AI search, live availability, email sending, and scheduling are not connected.
