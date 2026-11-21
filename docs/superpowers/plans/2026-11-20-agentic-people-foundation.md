# Agentic People: Foundation (sub-project 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PeopleGraph CLI answer agents from the right data with honest matching. Name matching stops returning the owner and email-substring false positives; single-person commands accept names; empty results carry hints; vault discovery cannot silently pick a demo vault; every response states its backend, source and owner; one agent skill.

**Architecture:** All matching, resolution, hint and discovery changes live in the Rust CLI (`crates/peoplegraph/src/main.rs`), next to the functions they replace. Provenance is added at the three dispatch boundaries: local dispatch in `run_with_profile`, legacy remote in `remote_run`, and hosted calls in `web_client.rs`, `people_client.rs`, `hosted.rs` and `sources.rs`. No new modules; no web-service changes except one test assertion.

**Tech Stack:** Rust 2024, clap 4, serde_json, strsim (`jaro_winkler`); Node test for the hosted CLI integration check.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md` (sections "Shared contract: the answer envelope" → `stats`, and "Sub-project 0: Foundation").

## Global Constraints

- Every command returns the existing envelope: `ok`, `command`, `data`, `stats`, `error{kind,message}`.
- `stats` on every response gains `backend` (`hosted` | `local` | `legacy_remote`), `source` (origin URL or absolute cache path) and `owner`.
- Email-address substring matching applies only when the query contains `@`.
- A name substring hit counts only at a word boundary and is labelled `partial`. Jaro-Winkler hits are labelled `fuzzy`. Results are ordered by confidence.
- The owner's own addresses (`userEmail` and its aliases) are excluded unless `--include-self` is passed.
- `score`, `contact-card`, `get-neighbors` and `get-edges` accept a name or an email. One identity group resolves; several return `ambiguous_person` with candidates; none returns `not_found` with hints.
- `who-knows` and `find-person` return `data.hints`: up to 3 nearest company/domain or name values with Jaro-Winkler ≥ 0.80.
- Vault auto-discovery skips vault paths with any hidden path segment (a segment starting with `.`). If more than one remaining vault has a cache, it fails with `ambiguous_cache`, listing the paths. `--cache` and `PEOPLEGRAPH_CACHE` are unaffected.
- Merge `skills/gmail-crm` into `skills/peoplegraph`; the installer and release ship the one skill.
- Messages never contain tokens.
- Run `cargo test --locked` from `crates/peoplegraph`. The current baseline is 121 passing tests.

## Review Focus

- Owner row missing (`userEmail` null or not in `contacts`): exclusion is a no-op, with no panic and no rows hidden.
- A bare `@` or very short email fragment (`@`, `a@`) would substring-match every address: email substring matching requires at least 3 characters other than `@`.
- Non-ASCII names ("José García"): `normalize` turns `é` into a token break, and the query goes through the same `normalize`, so "José" still finds the row as `partial`.
- `obsidian.json` that is missing, malformed or lists nonexistent vault paths: discovery yields no candidate and falls through to `cache_not_found`; it never panics or errors as `ambiguous_cache`.
- A relative `--cache ./x.json`: `stats.source` is reported as an absolute path.
- Two rows that share a `canonical_id` (one human, two addresses) resolve as one identity group, never `ambiguous_person`.

Each line has a pinned test in the owning task below.

## File Structure

| File | Responsibility in this plan |
|---|---|
| `crates/peoplegraph/src/main.rs` | Matching (`match_confidence`, `NameMatchKind`), owner identity, hints, person resolution, discovery, local/legacy provenance, CLI args, `describe` notes, unit tests |
| `crates/peoplegraph/src/web_client.rs` | Hosted graph-query provenance (`backend: hosted`, `source: origin`); rejects `--include-self` |
| `crates/peoplegraph/src/people_client.rs` | Provenance for private hosted commands routed through `Client::request_http` |
| `crates/peoplegraph/src/hosted.rs`, `crates/peoplegraph/src/sources.rs` | Same provenance on their direct `ok(...)` responses |
| `crates/peoplegraph/tests/discovery_cli.rs` (new) | Binary-level tests for vault discovery and local provenance |
| `apps/people-graph/tests/cli-integration.mjs` | Updated backend assertion (`hosted`) |
| `skills/peoplegraph/SKILL.md`, `skills/gmail-crm/` (deleted), `.github/workflows/peoplegraph-release.yml`, docs | One skill; documented new labels, errors, hints and provenance |

---

### Task 1: Honest name matching and owner exclusion

**Files:**
- Modify: `crates/peoplegraph/src/main.rs`: `NameMatchKind` and `name_match_label` (~4372-4383), `match_confidence` (~4398-4450), `find_person` (~1316-1447), `FindPersonArgs` (~147-157), the dispatch call (~711-719), `describe_payload` find-person notes (~4994)
- Modify: `crates/peoplegraph/src/web_client.rs`: `query_credential`, `FindPerson` arm (~299-310)
- Test: `crates/peoplegraph/src/main.rs` `mod tests`

**Interfaces:**
- Produces: `enum NameMatchKind { Exact, Reordered, Partial, Fuzzy }` with labels `"exact" | "reordered" | "partial" | "fuzzy"`.
- Produces: `fn contains_token_run(haystack: &str, needle: &str) -> bool`.
- Produces: `struct OwnerIdentity { emails: HashSet<String>, canonical_ids: HashSet<String> }`, `fn owner_identity(index: &ContactIndex) -> OwnerIdentity`, `fn is_owner_row(owner: &OwnerIdentity, row: &ContactRow) -> bool`.
- Produces: `fn find_person(index: &ContactIndex, query: &str, limit: usize, strict_name_order: bool, include_self: bool, start: Instant) -> Response`.
- Confidence values used by later tasks: exact full name `0.99`, exact email/alias `1.0`, reordered `0.91`, whole-token partial `0.90`, query-contains-name partial `0.86`, email substring partial `0.96`, fuzzy is the raw Jaro-Winkler score above `0.84`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `main.rs` (next to `exact_alias_match_is_confident`):

```rust
    fn matching_index() -> ContactIndex {
        let mut contacts = HashMap::new();
        contacts.insert(
            "kaya@betaworks.com".to_string(),
            Contact {
                name: "Kaya Jones".to_string(),
                email: "kaya@betaworks.com".to_string(),
                aliases: vec!["kayajones901@gmail.com".to_string()],
                ..empty_contact()
            },
        );
        contacts.insert(
            "kj@other.com".to_string(),
            Contact {
                name: "Kaya Jones".to_string(),
                email: "kj@other.com".to_string(),
                canonical_id: Some("owner-1".to_string()),
                ..empty_contact()
            },
        );
        contacts.insert(
            "jon@chin.dev".to_string(),
            Contact {
                name: "Jon Chin".to_string(),
                email: "jon@chin.dev".to_string(),
                ..empty_contact()
            },
        );
        contacts.insert(
            "jose@example.com".to_string(),
            Contact {
                name: "José García".to_string(),
                email: "jose@example.com".to_string(),
                ..empty_contact()
            },
        );
        // Owner row carries the canonical id shared with kj@other.com.
        contacts.get_mut("kaya@betaworks.com").unwrap().canonical_id = Some("owner-1".to_string());
        ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: Some("kaya@betaworks.com".to_string()),
            contacts,
            edges: vec![],
        }
    }

    fn match_names(response: &Response) -> Vec<(String, String)> {
        response.data.as_ref().unwrap()["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| (value_str(m, "name"), value_str(m, "name_match")))
            .collect()
    }

    #[test]
    fn name_query_never_matches_email_substrings_or_the_owner() {
        let index = matching_index();
        let response = find_person(&index, "Jon", 10, false, false, Instant::now());
        assert_eq!(match_names(&response), vec![("Jon Chin".to_string(), "partial".to_string())]);
    }

    #[test]
    fn include_self_restores_owner_rows() {
        let index = matching_index();
        let hidden = find_person(&index, "Kaya Jones", 10, false, false, Instant::now());
        assert!(match_names(&hidden).is_empty());
        let shown = find_person(&index, "Kaya Jones", 10, false, true, Instant::now());
        let names = match_names(&shown);
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|(name, kind)| name == "Kaya Jones" && kind == "exact"));
    }

    #[test]
    fn owner_identity_without_user_email_hides_nothing() {
        let mut index = matching_index();
        index.user_email = None;
        let response = find_person(&index, "Kaya Jones", 10, false, false, Instant::now());
        assert_eq!(match_names(&response).len(), 2);
    }

    #[test]
    fn email_queries_need_three_real_characters() {
        let index = matching_index();
        for query in ["@", "a@", "@x"] {
            let response = find_person(&index, query, 10, false, true, Instant::now());
            assert!(match_names(&response).is_empty(), "{query} matched rows");
        }
        let response = find_person(&index, "@chin.dev", 10, false, false, Instant::now());
        assert_eq!(match_names(&response), vec![("Jon Chin".to_string(), "partial".to_string())]);
    }

    #[test]
    fn non_ascii_names_match_by_whole_tokens() {
        let index = matching_index();
        let response = find_person(&index, "José", 10, false, false, Instant::now());
        assert_eq!(match_names(&response), vec![("José García".to_string(), "partial".to_string())]);
    }

    #[test]
    fn fuzzy_hits_are_labelled_fuzzy() {
        let index = matching_index();
        let response = find_person(&index, "Jon Chinn", 10, false, false, Instant::now());
        assert_eq!(match_names(&response), vec![("Jon Chin".to_string(), "fuzzy".to_string())]);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/peoplegraph && cargo test --locked name_query_never include_self owner_identity_without email_queries_need non_ascii fuzzy_hits 2>&1 | tail -20`
Expected: compile error, because `find_person` takes 5 arguments and not 6.

- [ ] **Step 3: Implement matching labels and token-run helper**

Replace `NameMatchKind` and `name_match_label`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NameMatchKind {
    Exact,
    Reordered,
    Partial,
    Fuzzy,
}

fn name_match_label(kind: NameMatchKind) -> &'static str {
    match kind {
        NameMatchKind::Exact => "exact",
        NameMatchKind::Reordered => "reordered",
        NameMatchKind::Partial => "partial",
        NameMatchKind::Fuzzy => "fuzzy",
    }
}

/// True when every token of `needle` appears contiguously, as whole tokens, in `haystack`.
fn contains_token_run(haystack: &str, needle: &str) -> bool {
    let hay: Vec<&str> = haystack.split_whitespace().collect();
    let need: Vec<&str> = needle.split_whitespace().collect();
    !need.is_empty() && need.len() <= hay.len() && hay.windows(need.len()).any(|w| w == need.as_slice())
}

/// An email query must contain `@` and at least three other characters.
fn is_email_query(query_email: &str) -> bool {
    query_email.contains('@') && query_email.chars().filter(|c| *c != '@').count() >= 3
}
```

Replace the body of `match_confidence` (same signature):

```rust
fn match_confidence(
    row: &ContactRow,
    query_norm: &str,
    query_email: &str,
    query_token_key: &str,
    strict_name_order: bool,
) -> Option<(f64, NameMatchKind)> {
    if query_email.contains('@') {
        if !is_email_query(query_email) {
            return None;
        }
        let exact = row.email == query_email
            || row.contact.email.trim().eq_ignore_ascii_case(query_email)
            || row.contact.aliases.iter().any(|alias| alias.trim().eq_ignore_ascii_case(query_email));
        if exact {
            return Some((1.0, NameMatchKind::Exact));
        }
        let partial = row.email.contains(query_email)
            || row.contact.aliases.iter().any(|alias| alias.to_ascii_lowercase().contains(query_email));
        return partial.then_some((0.96, NameMatchKind::Partial));
    }

    let name_norm = normalize(&row.contact.name);
    if query_norm.is_empty() || name_norm.is_empty() {
        return None;
    }
    if name_norm == query_norm {
        return Some((0.99, NameMatchKind::Exact));
    }
    if !strict_name_order && !query_token_key.is_empty() && sorted_token_key(&row.contact.name) == query_token_key {
        return Some((0.91, NameMatchKind::Reordered));
    }
    if contains_token_run(&name_norm, query_norm) {
        return Some((0.90, NameMatchKind::Partial));
    }
    if name_norm.len() >= 4 && contains_token_run(query_norm, &name_norm) {
        return Some((0.86, NameMatchKind::Partial));
    }
    let score = jaro_winkler(&name_norm, query_norm);
    (score > 0.84).then_some((score, NameMatchKind::Fuzzy))
}
```

- [ ] **Step 4: Implement owner identity and wire `find_person`**

Add near `rows()`:

```rust
#[derive(Default)]
struct OwnerIdentity {
    emails: HashSet<String>,
    canonical_ids: HashSet<String>,
}

fn owner_identity(index: &ContactIndex) -> OwnerIdentity {
    let mut owner = OwnerIdentity::default();
    let Some(user) = index
        .user_email
        .as_deref()
        .map(|email| email.trim().to_ascii_lowercase())
        .filter(|email| !email.is_empty())
    else {
        return owner;
    };
    if let Some(row) = find_by_email_or_alias(index, &user) {
        owner.emails.insert(row.email.clone());
        for alias in &row.contact.aliases {
            owner.emails.insert(alias.trim().to_ascii_lowercase());
        }
        if let Some(id) = row.contact.canonical_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            owner.canonical_ids.insert(id.to_string());
        }
    }
    owner.emails.insert(user);
    owner
}

fn is_owner_row(owner: &OwnerIdentity, row: &ContactRow) -> bool {
    owner.emails.contains(&row.email)
        || row.contact.aliases.iter().any(|alias| owner.emails.contains(&alias.trim().to_ascii_lowercase()))
        || row
            .contact
            .canonical_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|id| owner.canonical_ids.contains(id))
}
```

In `find_person`, add the `include_self: bool` parameter after `strict_name_order`. Build `let owner = owner_identity(index);` and filter `rows` before matching:

```rust
    let owner = owner_identity(index);
    let mut excluded_self = 0usize;
    let rows: Vec<ContactRow> = rows(index)
        .into_iter()
        .filter(|row| {
            let mine = !include_self && is_owner_row(&owner, row);
            excluded_self += usize::from(mine);
            !mine
        })
        .collect();
```

Iterate `rows.into_iter()` in the existing `filter_map`, and add `"excluded_self": excluded_self, "include_self": include_self` to the stats object. In `FindPersonArgs` add:

```rust
    /// Include the owner's own addresses in results.
    #[arg(long)]
    include_self: bool,
```

Update the dispatch call to pass `args.include_self`. Update every other `find_person(` call in `mod tests` to pass `false` before `Instant::now()`.

In `web_client.rs` `Commands::FindPerson(a)`, reject the flag next to the `strict_name_order` check:

```rust
            if a.include_self {
                return fail(
                    command,
                    "unsupported_operation",
                    "--include-self is available only with --local.".into(),
                    start,
                );
            }
```

Change the `describe_payload` find-person `notes` to: `"Matches name token permutations by default. Each match carries name_match ('exact' | 'reordered' | 'partial' | 'fuzzy'), identity_group, is_primary and name_variants. Email substrings are searched only when the query contains '@'. The owner's own addresses are excluded unless --include-self is passed. Pass --strict-name-order to disable reordered matching."`, and its usage to `"peoplegraph find-person <query> [--strict-name-order] [--include-self]"`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd crates/peoplegraph && cargo test --locked 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: every suite `ok`. `find_person_groups_token_permutations` still sees `exact` and `reordered`, because "Bruce Jaffe" equals its row exactly.

- [ ] **Step 6: Commit**

```bash
git add crates/peoplegraph/src/main.rs crates/peoplegraph/src/web_client.rs
git commit -m "fix(cli): stop matching names against email substrings and hide the owner by default"
```

---

### Task 2: Hints on empty results

**Files:**
- Modify: `crates/peoplegraph/src/main.rs`: `who_knows` (~1504-1576), `find_person`
- Test: `crates/peoplegraph/src/main.rs` `mod tests`

**Interfaces:**
- Consumes: `owner_identity`, `is_owner_row` (Task 1).
- Produces: `fn nearest_values(candidates: impl IntoIterator<Item = String>, score: impl Fn(&str) -> f64) -> Vec<String>` (≤ 3 values, score ≥ 0.80, deduped by `normalize`).
- Produces: `fn name_hints(index: &ContactIndex, query_norm: &str, owner: &OwnerIdentity, include_self: bool) -> Vec<String>`.
- Produces: `data.hints: [string]` on every `find-person` and `who-knows` response (empty when results exist).

- [ ] **Step 1: Write the failing tests**

```rust
    fn company_index() -> ContactIndex {
        let mut contacts = HashMap::new();
        contacts.insert(
            "roelof@sequoiacap.com".to_string(),
            Contact {
                name: "Maya Rivera".to_string(),
                email: "roelof@sequoiacap.com".to_string(),
                company: Some("Sequoia Capital".to_string()),
                domain: "sequoiacap.com".to_string(),
                ..empty_contact()
            },
        );
        ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: None,
            contacts,
            edges: vec![],
        }
    }

    fn empty_feedback() -> FeedbackStore {
        FeedbackStore { schema_version: 1, updated_at_unix: 0, entries: HashMap::new() }
    }

    #[test]
    fn who_knows_miss_suggests_near_companies() {
        let response = who_knows(&company_index(), &empty_feedback(), "Sequoya", 10, Instant::now());
        let data = response.data.unwrap();
        assert!(data["people"].as_array().unwrap().is_empty());
        let hints: Vec<String> = serde_json::from_value(data["hints"].clone()).unwrap();
        assert!(hints.contains(&"Sequoia Capital".to_string()), "{hints:?}");
    }

    #[test]
    fn who_knows_hit_has_empty_hints() {
        let response = who_knows(&company_index(), &empty_feedback(), "sequoia", 10, Instant::now());
        let data = response.data.unwrap();
        assert_eq!(data["people"].as_array().unwrap().len(), 1);
        assert_eq!(data["hints"], json!([]));
    }

    #[test]
    fn find_person_miss_suggests_near_names() {
        let response = find_person(&company_index(), "Rivra", 10, false, false, Instant::now());
        let data = response.data.unwrap();
        assert!(data["matches"].as_array().unwrap().is_empty());
        assert_eq!(data["hints"], json!(["Maya Rivera"]));
    }
```

If `Contact.domain` is not a plain `String`, adapt only the literal; check the `Contact` struct (~335).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/peoplegraph && cargo test --locked who_knows_miss who_knows_hit find_person_miss 2>&1 | tail -15`
Expected: FAIL, because `data["hints"]` is `null`.

- [ ] **Step 3: Implement**

Add near `normalize_company`:

```rust
fn nearest_values(
    candidates: impl IntoIterator<Item = String>,
    score: impl Fn(&str) -> f64,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut scored: Vec<(f64, String)> = candidates
        .into_iter()
        .filter_map(|display| {
            let key = normalize(&display);
            if key.is_empty() || !seen.insert(key) {
                return None;
            }
            let value = score(&display);
            (value >= 0.80).then_some((value, display))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(3).map(|(_, display)| display).collect()
}

fn name_hints(index: &ContactIndex, query_norm: &str, owner: &OwnerIdentity, include_self: bool) -> Vec<String> {
    if query_norm.is_empty() {
        return vec![];
    }
    nearest_values(
        rows(index)
            .into_iter()
            .filter(|row| include_self || !is_owner_row(owner, row))
            .map(|row| row.contact.name),
        |display| {
            let name = normalize(display);
            name.split_whitespace()
                .map(|token| jaro_winkler(token, query_norm))
                .fold(jaro_winkler(&name, query_norm), f64::max)
        },
    )
}

fn company_hints(index: &ContactIndex, company_norm: &str) -> Vec<String> {
    if company_norm.is_empty() {
        return vec![];
    }
    let mut candidates = Vec::new();
    for row in rows(index) {
        if let Some(company) = display_company(&row.contact) {
            candidates.push(company);
        }
        let domain = row.contact.domain.trim().to_ascii_lowercase();
        if !domain.is_empty() && !is_generic_email_domain(&domain) {
            if let Some(label) = domain.split('.').next() {
                candidates.push(label.to_string());
            }
        }
    }
    nearest_values(candidates, |display| jaro_winkler(&normalize_company(display), company_norm))
}
```

In `who_knows`, compute `let hints = if total == 0 { company_hints(index, &company_norm) } else { vec![] };` and add `"hints": hints` to `data`. In `find_person`, compute `let hints = if total == 0 { name_hints(index, &query_norm, &owner, include_self) } else { vec![] };` and add `"hints": hints` to `data`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crates/peoplegraph && cargo test --locked 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "feat(cli): suggest near names and companies when lookups come back empty"
```

---

### Task 3: Name resolution for single-person commands

**Files:**
- Modify: `crates/peoplegraph/src/main.rs`: `score_person` (~1449), `get_neighbors` (~1949), `get_edges` (~2004), `contact_card` (~2042); delete `find_contact_for_query` (~3475) once unused; `EmailArg` doc (~159); `describe_payload` usages for score/get-neighbors/get-edges/contact-card
- Test: `crates/peoplegraph/src/main.rs` `mod tests`

**Interfaces:**
- Consumes: `match_confidence`, `owner_identity`, `is_owner_row`, `name_hints`, `contact_brief`.
- Produces: `enum PersonResolution { Found(ContactRow), Ambiguous(Vec<ContactRow>), NotFound(Vec<String>) }`, `fn resolve_person(index: &ContactIndex, query: &str) -> PersonResolution`, `fn person_failure(command: &'static str, resolution: PersonResolution, index: &ContactIndex, start: Instant) -> Response` (failures only).
- Error kinds: `ambiguous_person`, with `data.candidates: [contact_brief]` (≤ 5); `not_found`, with `data.hints: [string]`.

- [ ] **Step 1: Write the failing tests**

```rust
    fn resolution_index() -> ContactIndex {
        let mut index = matching_index();
        index.contacts.insert(
            "maya@acme.com".to_string(),
            Contact { name: "Maya Rivera".to_string(), email: "maya@acme.com".to_string(), canonical_id: Some("maya-1".to_string()), ..empty_contact() },
        );
        index.contacts.insert(
            "maya.r@gmail.com".to_string(),
            Contact { name: "Maya Rivera".to_string(), email: "maya.r@gmail.com".to_string(), canonical_id: Some("maya-1".to_string()), ..empty_contact() },
        );
        index.contacts.insert(
            "maya@zeta.io".to_string(),
            Contact { name: "Maya Chen".to_string(), email: "maya@zeta.io".to_string(), ..empty_contact() },
        );
        index
    }

    #[test]
    fn shared_canonical_id_resolves_as_one_person() {
        match resolve_person(&resolution_index(), "Maya Rivera") {
            PersonResolution::Found(row) => assert_eq!(row.contact.name, "Maya Rivera"),
            _ => panic!("expected one person"),
        }
    }

    #[test]
    fn first_name_shared_by_two_people_is_ambiguous() {
        let response = score_person(&resolution_index(), &empty_feedback(), "Maya", Instant::now());
        assert_eq!(response.error.as_ref().unwrap().kind, "ambiguous_person");
        assert_eq!(response.data.unwrap()["candidates"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn name_resolution_never_returns_the_owner() {
        let response = score_person(&resolution_index(), &empty_feedback(), "Kaya Jones", Instant::now());
        assert_eq!(response.error.as_ref().unwrap().kind, "not_found");
    }

    #[test]
    fn score_accepts_a_name() {
        let response = score_person(&resolution_index(), &empty_feedback(), "Jon Chin", Instant::now());
        assert!(response.ok);
        assert_eq!(response.data.unwrap()["email"], "jon@chin.dev");
    }

    #[test]
    fn unknown_name_returns_hints() {
        let response = score_person(&resolution_index(), &empty_feedback(), "Rivra", Instant::now());
        assert_eq!(response.error.as_ref().unwrap().kind, "not_found");
        assert_eq!(response.data.unwrap()["hints"], json!(["Maya Rivera"]));
    }

    #[test]
    fn neighbors_keep_unknown_email_passthrough() {
        let response = get_neighbors(&resolution_index(), "stranger@else.com", Instant::now());
        assert!(response.ok);
        assert_eq!(response.data.unwrap()["email"], "stranger@else.com");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/peoplegraph && cargo test --locked shared_canonical first_name_shared name_resolution_never score_accepts unknown_name_returns neighbors_keep 2>&1 | tail -15`
Expected: compile error, because `resolve_person` / `PersonResolution` are not defined.

- [ ] **Step 3: Implement resolution**

Add after `find_by_email_or_alias`:

```rust
enum PersonResolution {
    Found(ContactRow),
    Ambiguous(Vec<ContactRow>),
    NotFound(Vec<String>),
}

fn identity_key(row: &ContactRow) -> String {
    row.contact
        .canonical_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| format!("id:{id}"))
        .unwrap_or_else(|| format!("name:{}", sorted_token_key(&row.contact.name)))
}

fn resolve_person(index: &ContactIndex, query: &str) -> PersonResolution {
    let query = query.trim();
    let query_lower = query.to_ascii_lowercase();
    if query.contains('@') {
        return match find_by_email_or_alias(index, &query_lower) {
            Some(row) => PersonResolution::Found(row),
            None => PersonResolution::NotFound(vec![]),
        };
    }
    let owner = owner_identity(index);
    let query_norm = normalize(query);
    let query_token_key = sorted_token_key(query);
    let mut groups: Vec<(String, f64, ContactRow)> = Vec::new();
    for row in rows(index).into_iter().filter(|row| !is_owner_row(&owner, row)) {
        let Some((confidence, _)) = match_confidence(&row, &query_norm, &query_lower, &query_token_key, false)
            .filter(|(confidence, _)| *confidence >= 0.72)
        else {
            continue;
        };
        let key = identity_key(&row);
        match groups.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, best, primary)) => {
                *best = best.max(confidence);
                if infer_score(&row.contact).combined > infer_score(&primary.contact).combined {
                    *primary = row;
                }
            }
            None => groups.push((key, confidence, row)),
        }
    }
    groups.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.2.contact.name.cmp(&b.2.contact.name)));
    match groups.len() {
        0 => PersonResolution::NotFound(name_hints(index, &query_norm, &owner, false)),
        1 => PersonResolution::Found(groups.remove(0).2),
        _ if groups[0].1 >= 0.99 && groups[1].1 < 0.99 => PersonResolution::Found(groups.remove(0).2),
        _ => PersonResolution::Ambiguous(groups.into_iter().take(5).map(|(_, _, row)| row).collect()),
    }
}

fn person_failure(command: &'static str, resolution: PersonResolution, index: &ContactIndex, start: Instant) -> Response {
    let (kind, message, data) = match resolution {
        PersonResolution::Ambiguous(rows) => (
            "ambiguous_person",
            "Several people match; ask which one and retry with their email.".to_string(),
            json!({"candidates": rows.iter().map(contact_brief).collect::<Vec<_>>()}),
        ),
        PersonResolution::NotFound(hints) => (
            "not_found",
            "No contact matches that name or email.".to_string(),
            json!({"hints": hints}),
        ),
        PersonResolution::Found(_) => unreachable!("person_failure takes failures only"),
    };
    let mut response = fail(command, kind, message, start);
    response.data = Some(data);
    response.stats = Some(json!({
        "matched": 0,
        "last_sync": &index.last_sync,
        "user_email": &index.user_email,
        "ms": elapsed_ms(start)
    }));
    response
}
```

Check `contact_brief`'s signature (~4343, `fn contact_brief(row: &ContactRow) -> Value`) and adapt the `map` if it differs.

Wire the commands:

- **`score_person`:** replace the `find_by_email_or_alias` lookup and the hand-built not-found response with:
  ```rust
  let row = match resolve_person(index, email) {
      PersonResolution::Found(row) => row,
      other => return person_failure("score", other, index, start),
  };
  ```
  The existing test `score_not_found_includes_source_identity_and_freshness_without_contact_data` asserts `data.is_none()`. Change that assertion to `assert_eq!(response.data.unwrap()["hints"], json!([]));`, because email misses now return empty hints.
- **`contact_card`:** replace `find_contact_for_query(&index, &args.query)` with the same `match` (command `command`), then delete `find_contact_for_query`.
- **`get_neighbors` and `get_edges`:** add a helper and use it for each argument:
  ```rust
  fn edge_endpoint(index: &ContactIndex, query: &str) -> Result<String, PersonResolution> {
      if query.contains('@') {
          return Ok(resolve_email(index, query));
      }
      match resolve_person(index, query) {
          PersonResolution::Found(row) => Ok(row.email),
          other => Err(other),
      }
  }
  ```
  `let email_norm = match edge_endpoint(index, email) { Ok(e) => e, Err(r) => return person_failure("get-neighbors", r, index, start) };`, and the same for `from`/`to` in `get_edges` with command `"get-edges"`.

Change the `EmailArg` field doc to `/// Email address or name.`. Change the describe usages to `peoplegraph score <email-or-name>`, `peoplegraph get-neighbors <email-or-name>` and `peoplegraph get-edges --from <email-or-name> --to <email-or-name>`, and add `"notes": "Names resolve to one identity group; several return ambiguous_person with candidates; none returns not_found with hints."` to each of score, contact-card, get-neighbors and get-edges.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crates/peoplegraph && cargo test --locked 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: all `ok`.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "feat(cli): resolve names for score, contact-card and edge commands with ambiguity errors"
```

---

### Task 4: Safe vault discovery

**Files:**
- Modify: `crates/peoplegraph/src/main.rs`: `resolve_cache_path` (~4821), `resolve_obsidian_cache_path` (~4859), callers at ~938 (`serve_http`), ~1284 (`load_index`), ~1755 (`load_feedback`), ~1797 (`feedback`)
- Create: `crates/peoplegraph/tests/discovery_cli.rs`

**Interfaces:**
- Produces: `fn resolve_cache_path(explicit: Option<&Path>) -> Result<PathBuf, (&'static str, String)>`, where the kind is `cache_not_found` or `ambiguous_cache`.
- Produces: `fn discover_vault_cache(config: &Value) -> Result<Option<PathBuf>, Vec<String>>`, where `Err` lists ambiguous cache paths.

- [ ] **Step 1: Write the failing integration tests**

Create `crates/peoplegraph/tests/discovery_cli.rs`:

```rust
use serde_json::{Value, json};
use std::{fs, path::{Path, PathBuf}, process::Command};

const SAMPLE: &str = include_str!("../fixtures/contact-index.sample.json");

fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pg-discovery-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn vault(root: &Path) -> PathBuf {
    let cache = root.join(".obsidian/plugins/gmail-crm/contact-index.json");
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    fs::write(&cache, SAMPLE).unwrap();
    cache
}

fn obsidian(home: &Path, vaults: &[&Path]) {
    let dir = home.join("Library/Application Support/obsidian");
    fs::create_dir_all(&dir).unwrap();
    let mut map = serde_json::Map::new();
    for (i, path) in vaults.iter().enumerate() {
        map.insert(format!("v{i}"), json!({"path": path, "ts": i, "open": i == 0}));
    }
    fs::write(dir.join("obsidian.json"), json!({"vaults": map}).to_string()).unwrap();
}

fn run(home: &Path, args: &[&str]) -> Value {
    let mut c = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for k in ["PEOPLEGRAPH_WEB_URL", "PEOPLEGRAPH_WEB_TOKEN", "PEOPLEGRAPH_HOST", "PEOPLEGRAPH_TOKEN", "PEOPLEGRAPH_CACHE", "XDG_CONFIG_HOME", "APPDATA"] {
        c.env_remove(k);
    }
    let out = c.env("HOME", home).current_dir(home).args(args).output().unwrap();
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn hidden_demo_vaults_are_skipped() {
    let h = home("hidden");
    let demo = h.join(".codex/artifacts/demo-vault");
    let real = h.join("Notes");
    vault(&demo);
    let real_cache = vault(&real);
    obsidian(&h, &[&demo, &real]);
    let v = run(&h, &["--local", "find-person", "Maya Rivera"]);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["stats"]["backend"], "local");
    assert_eq!(v["stats"]["source"], fs::canonicalize(real_cache).unwrap().display().to_string());
    assert_eq!(v["stats"]["owner"], "owner@example.com");
}

#[test]
fn two_real_vaults_are_ambiguous() {
    let h = home("ambiguous");
    let a = h.join("A");
    let b = h.join("B");
    vault(&a);
    vault(&b);
    obsidian(&h, &[&a, &b]);
    let v = run(&h, &["--local", "find-person", "Maya"]);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["kind"], "ambiguous_cache");
    let message = v["error"]["message"].as_str().unwrap();
    assert!(message.contains("/A/") && message.contains("/B/"), "{message}");
}

#[test]
fn malformed_or_missing_vaults_fall_through_to_not_found() {
    let h = home("malformed");
    let dir = h.join("Library/Application Support/obsidian");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("obsidian.json"), "{not json").unwrap();
    assert_eq!(run(&h, &["--local", "find-person", "Maya"])["error"]["kind"], "cache_not_found");
    obsidian(&h, &[&h.join("does-not-exist")]);
    assert_eq!(run(&h, &["--local", "find-person", "Maya"])["error"]["kind"], "cache_not_found");
}

#[test]
fn relative_cache_flag_reports_an_absolute_source() {
    let h = home("relative");
    fs::write(h.join("cache.json"), SAMPLE).unwrap();
    let v = run(&h, &["--cache", "./cache.json", "find-person", "Maya"]);
    let source = v["stats"]["source"].as_str().unwrap();
    assert!(Path::new(source).is_absolute(), "{source}");
}
```

The `stats.backend`/`source` assertions pass only after Task 5. Run them then; this task's gate is the `ambiguous_cache` and `cache_not_found` behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/peoplegraph && cargo test --locked --test discovery_cli 2>&1 | tail -20`
Expected: `two_real_vaults_are_ambiguous` FAILS (it currently picks the open vault); the provenance assertions FAIL.

- [ ] **Step 3: Implement discovery**

Replace `resolve_obsidian_cache_path` and add helpers:

```rust
fn has_hidden_segment(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, std::path::Component::Normal(segment) if segment.to_string_lossy().starts_with('.'))
    })
}

fn discover_vault_cache(config: &Value) -> Result<Option<PathBuf>, Vec<String>> {
    let Some(vaults) = config.get("vaults").and_then(Value::as_object) else {
        return Ok(None);
    };
    let mut found: Vec<PathBuf> = vaults
        .values()
        .filter_map(|vault| vault.get("path").and_then(Value::as_str).map(PathBuf::from))
        .filter(|path| !has_hidden_segment(path))
        .map(|path| path.join(".obsidian/plugins/gmail-crm/contact-index.json"))
        .filter(|cache| cache.exists())
        .collect();
    found.sort();
    found.dedup();
    match found.len() {
        0 => Ok(None),
        1 => Ok(found.pop()),
        _ => Err(found.iter().map(|path| path.display().to_string()).collect()),
    }
}

fn resolve_obsidian_cache_path() -> Result<Option<PathBuf>, Vec<String>> {
    let Some(config_path) = obsidian_config_path() else { return Ok(None) };
    let Ok(content) = fs::read_to_string(config_path) else { return Ok(None) };
    let Ok(config) = serde_json::from_str::<Value>(&content) else { return Ok(None) };
    discover_vault_cache(&config)
}
```

Change `resolve_cache_path` to return `Result<PathBuf, (&'static str, String)>`. Every existing `Err(message)` becomes `Err(("cache_not_found", message))`, and the vault step becomes:

```rust
    match resolve_obsidian_cache_path() {
        Ok(Some(path)) => return Ok(path),
        Ok(None) => {}
        Err(paths) => {
            return Err((
                "ambiguous_cache",
                format!(
                    "found contact caches in {} Obsidian vaults: {}. Pass --cache <path> or set PEOPLEGRAPH_CACHE.",
                    paths.len(),
                    paths.join(", ")
                ),
            ));
        }
    }
```

Callers:
- `load_index`: `Err((kind, message)) => return Err(Box::new(fail(command, kind, message, start)))`.
- `serve_http` and `feedback`: same pattern with their existing `fail` calls, now using `kind`.
- `load_feedback` (returns `Result<_, String>`): `let cache_path = resolve_cache_path(cli.cache.as_deref()).map_err(|(_, message)| message)?;`.

- [ ] **Step 4: Run the discovery tests**

Run: `cd crates/peoplegraph && cargo test --locked --test discovery_cli two_real_vaults malformed 2>&1 | tail -10`
Expected: both PASS. The provenance assertions in the other two tests stay red until Task 5.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs crates/peoplegraph/tests/discovery_cli.rs
git commit -m "fix(cli): skip hidden vaults and refuse ambiguous cache discovery"
```

---

### Task 5: Provenance on every response

**Files:**
- Modify: `crates/peoplegraph/src/main.rs`: `run_with_profile` (~592-765), new `set_provenance`, `local_source`
- Modify: `crates/peoplegraph/src/web_client.rs` (~355-360), `crates/peoplegraph/src/people_client.rs` (~131-135), `crates/peoplegraph/src/hosted.rs` (~292-296), `crates/peoplegraph/src/sources.rs` (~454-457)
- Modify: `apps/people-graph/tests/cli-integration.mjs:43`
- Test: `crates/peoplegraph/tests/discovery_cli.rs` (from Task 4), plus `mod tests` in `web_client.rs` and `people_client.rs`

**Interfaces:**
- Consumes: `resolve_cache_path` (Task 4).
- Produces: `pub(crate) fn set_provenance(response: Response, backend: &str, source: Option<String>, owner: Option<String>) -> Response`. `owner` falls back to `stats.user_email`. `stats` keys are `backend`, `source` and `owner`.
- The backend label values are exactly `"local"`, `"legacy_remote"` and `"hosted"`. The persisted web profile field `backend: "people-web"` in `web_profile.rs` is a different concept and stays unchanged.

- [ ] **Step 1: Write the failing unit tests**

In `main.rs` `mod tests`:

```rust
    #[test]
    fn provenance_fills_owner_from_user_email_and_keeps_existing_stats() {
        let response = ok("find-person", json!({}), json!({"matched": 0, "user_email": "owner@example.com"}));
        let response = set_provenance(response, "local", Some("/v/contact-index.json".into()), None);
        let stats = response.stats.unwrap();
        assert_eq!(stats["backend"], "local");
        assert_eq!(stats["source"], "/v/contact-index.json");
        assert_eq!(stats["owner"], "owner@example.com");
        assert_eq!(stats["matched"], 0);
    }

    #[test]
    fn provenance_on_failures_without_stats() {
        let mut response = fail("score", "cache_not_found", "x".into(), Instant::now());
        response.stats = None;
        let stats = set_provenance(response, "legacy_remote", Some("http://h".into()), None).stats.unwrap();
        assert_eq!(stats["backend"], "legacy_remote");
        assert!(stats.get("owner").is_none());
    }
```

In `people_client.rs` `mod tests`, extend the existing success-path test that asserts `stats` (or add one next to it, using the same local `TcpListener` fixture pattern already in that file) with:

```rust
assert_eq!(result.stats.as_ref().unwrap()["backend"], "hosted");
assert_eq!(result.stats.as_ref().unwrap()["source"], origin);
```

where `origin` is the fixture server's `http://127.0.0.1:<port>` string that the test passes to the client.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crates/peoplegraph && cargo test --locked provenance 2>&1 | tail -10`
Expected: compile error, because `set_provenance` is not defined.

- [ ] **Step 3: Implement `set_provenance` and the local/legacy boundaries**

In `main.rs`, next to `ok`/`fail`:

```rust
pub(crate) fn set_provenance(
    mut response: Response,
    backend: &str,
    source: Option<String>,
    owner: Option<String>,
) -> Response {
    let stats = response.stats.get_or_insert_with(|| json!({}));
    if let Some(map) = stats.as_object_mut() {
        map.insert("backend".into(), json!(backend));
        if let Some(source) = source {
            map.insert("source".into(), json!(source));
        }
        let owner = owner.or_else(|| map.get("user_email").and_then(Value::as_str).map(str::to_string));
        if let Some(owner) = owner {
            map.insert("owner".into(), json!(owner));
        }
    }
    response
}

fn local_source(cli: &Cli) -> Option<String> {
    let path = resolve_cache_path(cli.cache.as_deref()).ok()?;
    Some(fs::canonicalize(&path).unwrap_or(path).display().to_string())
}
```

In `run_with_profile`:
- Change `return remote_run(cli, command, start);` to `return set_provenance(remote_run(cli, command, start), "legacy_remote", effective_host(cli), None);`.
- Bind the final `match &cli.command { ... }` to `let response = match &cli.command { ... };`, then end the function with `set_provenance(response, "local", local_source(cli), None)`.

- [ ] **Step 4: Implement the hosted boundaries**

- **`web_client.rs` `query_credential`:** replace `stats["backend"] = json!("people-web");` with:
  ```rust
  stats["backend"] = json!("hosted");
  stats["source"] = json!(origin);
  ```
- **`people_client.rs` `Client::request_http`:** change the success stats to `json!({"ms":elapsed_ms(start),"backend":"hosted","source":self.target})`. In `ClientError::response`, callers don't know the origin, so leave failures as is: only success responses carry `source` here.
- **`hosted.rs` status:** change `json!({"ms":elapsed_ms(start),"backend":"people_web"})` to `json!({"ms":elapsed_ms(start),"backend":"hosted","source":credential.origin})`; `credential` is in scope at line ~290.
- **`sources.rs` `run`:** change the success arm to:
  ```rust
  Ok(data) => {
      let source = config::resolve(args.web.url.as_deref()).ok().map(|c| c.origin);
      ok("sources", data, json!({"ms":elapsed_ms(start),"backend":"hosted","source":source}))
  }
  ```
  If `args.web` is not the field path, use the expression already used at `sources.rs:369`.
- **`apps/people-graph/tests/cli-integration.mjs:43`:** change `assert.equal(data.stats.backend,'people-web')` to `assert.equal(data.stats.backend,'hosted')`.

Verify there are no stray labels: `rg -n '"people_web"|stats\["backend"\] = json!\("people-web"\)' crates/peoplegraph/src` must print nothing.

- [ ] **Step 5: Run all Rust tests, including Task 4's discovery tests**

Run: `cd crates/peoplegraph && cargo test --locked 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: all `ok`, including `discovery_cli` (4 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/peoplegraph/src apps/people-graph/tests/cli-integration.mjs crates/peoplegraph/tests/discovery_cli.rs
git commit -m "feat(cli): report backend, source and owner on every response"
```

---

### Task 6: One agent skill and documented contract

**Files:**
- Delete: `skills/gmail-crm/SKILL.md` (and the directory)
- Modify: `skills/peoplegraph/SKILL.md`; `.github/workflows/peoplegraph-release.yml` (~118, the `cp skills/gmail-crm/...` line); `docs/peoplegraph-cli-parity.md`; `docs/people-agent-onboarding.md` and `scripts/install-peoplegraph.sh`/`scripts/install-peoplegraph.test.mjs` only where they reference the `gmail-crm` skill or "both skills"
- Test: `node --test scripts/install-peoplegraph.test.mjs`

**Interfaces:**
- Consumes: the labels, error kinds and stats keys from Tasks 1-5.

- [ ] **Step 1: Find every reference to the compatibility skill**

Run: `rg -n "gmail-crm-SKILL|skills/gmail-crm|both (agent )?skills|compatibility skill" --glob '!**/node_modules/**' --glob '!**/target/**' --glob '!docs/superpowers/**' --glob '!docs/releases/**'`
Expected: the release workflow line, plus any installer/onboarding mentions. Release notes are historical and stay unchanged.

- [ ] **Step 2: Remove the compatibility skill and its packaging**

Delete `skills/gmail-crm/` and the workflow `cp skills/gmail-crm/SKILL.md release/gmail-crm-SKILL.md` line. In each file from Step 1, change "both skills"/`gmail-crm-SKILL.md` wording so only `peoplegraph-SKILL.md` is described. If `install-peoplegraph.test.mjs` asserts the gmail-crm asset, update that assertion to expect only `peoplegraph-SKILL.md`.

- [ ] **Step 3: Update `skills/peoplegraph/SKILL.md`**

- Change the description's trigger list so it also covers the old gmail-crm triggers: "who do I know at", "when did I last talk to", "who should I reconnect with", "can anyone intro me".
- Add a "Supported harnesses" line: Claude, Codex, ChatGPT (MCP), OpenClaw/Botwick, Hermes; any harness that can run a CLI or call MCP.
- In "Graph and local commands", add these rules:

```markdown
Every response carries `stats.backend` (`hosted`, `local` or `legacy_remote`), `stats.source` (origin or absolute cache path) and `stats.owner`. Check them before answering; if the source is not the owner's real data, say so.

`find-person` labels matches `exact`, `reordered`, `partial` or `fuzzy`, never treats a name as an email fragment, and hides the owner's own addresses unless `--include-self`. `score`, `contact-card`, `get-neighbors` and `get-edges` accept a name: `ambiguous_person` returns `data.candidates`; ask which one. `not_found` and empty `find-person`/`who-knows` results return `data.hints`; offer them as "did you mean", never as answers. `ambiguous_cache` lists the vault caches found; ask the owner which to use and pass `--cache`.
```

- [ ] **Step 4: Update `docs/peoplegraph-cli-parity.md`**

Add a "Local query behavior" section with the same paragraph as Step 3, so the offline guide bundled by the installer matches the skill.

- [ ] **Step 5: Run the installer tests and formatting**

Run: `node --test scripts/install-peoplegraph.test.mjs 2>&1 | tail -5 && cd crates/peoplegraph && cargo fmt --check && cargo test --locked 2>&1 | grep -E "^test result|FAILED"`
Expected: installer tests pass, `cargo fmt --check` prints nothing, Rust tests all `ok`.

- [ ] **Step 6: Commit**

```bash
git add -A skills .github/workflows/peoplegraph-release.yml docs/peoplegraph-cli-parity.md docs/people-agent-onboarding.md scripts
git commit -m "docs(skill): merge gmail-crm into the peoplegraph skill and document query provenance"
```

---

### Task 7: Verify against real data and install locally

**Files:** none changed unless verification fails.

- [ ] **Step 1: Build the release binary**

Run: `cd crates/peoplegraph && cargo build --release --locked 2>&1 | tail -2`
Expected: `Finished`.

- [ ] **Step 2: Exercise the reported failures against this machine's vaults (read-only)**

Run from the repository root:

```bash
B=crates/peoplegraph/target/release/peoplegraph
$B --local find-person Jon | jq -c '{ok, err:.error.kind, src:.stats.source, m:[.data.matches[]?|{name,name_match}]}'
$B --local who-knows --company sequoia | jq -c '{n:(.data.people|length), hints:.data.hints, src:.stats.source}'
$B --local score "jon chin" | jq -c '{ok, err:.error.kind, cand:(.data.candidates|length?)}'
```

Expected:
- `ok:true` with `src` under `~/Library/Mobile Documents/...`. It must not be under `~/.codex/artifacts`.
- No `Kaya Jones` rows in the results.
- `score` either succeeds, or returns `ambiguous_person` / `not_found` with candidates or hints.

Record the actual outputs for the report.

- [ ] **Step 3: Install over the old 0.3.11 binary (owner-approved operational step)**

Run:

```bash
cp /opt/homebrew/bin/peoplegraph /tmp/peoplegraph-0.3.11.bak
rm -f /opt/homebrew/bin/peoplegraph
cp crates/peoplegraph/target/release/peoplegraph /opt/homebrew/bin/peoplegraph
codesign --force --sign - /opt/homebrew/bin/peoplegraph
hash -r; peoplegraph version | jq -c .data
```

Expected: the version reported by Cargo.toml (0.3.17 until a release bump). The `rm` before `cp` avoids the macOS AMFI kill when overwriting a signed binary.

- [ ] **Step 4: Owner login (interactive, owner performs it)**

Ask the owner to run `peoplegraph login` and approve it in the browser. Then run `peoplegraph status | jq -c '{ok, owner:.data.owner, origin:.data.origin}'`.
Expected: `ok:true` with the owner's account. Hosted queries then report `stats.backend: "hosted"`.
