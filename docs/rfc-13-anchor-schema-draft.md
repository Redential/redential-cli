# RFC #13 — anchor record schema (discussion draft)

**Status:** reserved for schema ceremony — not wired, not validated by CI yet.
**Thread:** [issue #13](https://github.com/Redential/redential-cli/issues/13)
**Machine-readable sketch:** `schema/anchor.v0.discussion.json`

This draft closes the backdating window called out in the
[#13 vault thread](https://github.com/Redential/redential-cli/issues/13)
and incorporates jpbelmo's 2026-07-22 acceptance: chain forks over silent
splices, `0600` config-dir vault placement, and **coarse time buckets +
gap non-exposure as the default privacy profile** (not an opt-in).

**2026-07-23 maintainer pushbacks (adopted here):** anchors fire on
`submit` only, or via an explicit voluntary `redential anchor` one-shot —
never an assumed heartbeat cadence. Chain depth is a **visible property
inside Attested** (e.g. "26 anchors over 6 months"), not a new trust tier.
Bookends are **`session start` / `session finish`** (naming settled).

---

## When an anchor fires (network boundary)

Today only `login` and `submit` touch the network. The vault must not
quietly add a third assumed cadence.

| Trigger | Network? | Notes |
| --- | --- | --- |
| `redential submit` | yes (existing) | Anchor summary rides the submit the operator already reviewed |
| `redential anchor` | yes (new, voluntary) | Explicit one-shot; operator opts in per anchor |
| Background / weekly heartbeat | **forbidden** | Would break principle 1's network story |

**Honest price:** infrequent submitters get wider backdating windows between
anchors. ε (below) is generous and keyed to time since last anchor — not
to an imagined weekly schedule.

---

## Design posture

| Layer | Stored where | Leaves machine? |
| --- | --- | --- |
| Receipt chain (full) | `~/.config/redential/vault.json` (`0600`) | Only on `submit`, after byte-for-byte review |
| Anchor record (summary) | Redential server | Yes — **coarse aggregates only** |
| Per-session timestamps | Local receipt only | Never on server in default profile |
| Gap pattern | — | **Never exposed** to verifiers or hiring UI |

Head-only anchoring is sufficient **if** each anchor carries enough summary
fields for the server to reject impossible segments at submit time.

---

## Anchor record (server-side)

One row per successful `submit` that opts into vault anchoring.

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `schema_version` | const `"anchor.v0.discussion"` | yes | Pins ceremony; bump before merge |
| `identity_hash` | string | yes | Salted author identity (same family as bundle) |
| `chain_id` | uuid | yes | Stable lineage per credential identity |
| `seq` | integer ≥ 0 | yes | Monotonic per `chain_id`; resets only on fork |
| `prev_anchor_hash` | string \| null | yes | Hash of prior anchor payload; `null` on genesis |
| `head_hash` | string | yes | SHA-256 of local vault head at submit |
| `receipt_count_total` | integer ≥ 0 | yes | Cumulative receipts in this `chain_id` |
| `receipt_count_since_prev` | integer ≥ 0 | yes | Receipts since last anchor (segment size) |
| `max_finished_at_claimed` | ISO-8601 | yes | Max `finished_at` across segment receipts (client-claimed) |
| `received_at_server` | ISO-8601 | yes | Authoritative server clock at ingest |
| `activity_period` | closed enum | yes | **Coarse bucket** — see below |
| `first_anchor_at` | ISO-8601 | yes | Genesis anchor time for this `chain_id` |
| `reset_reason` | enum \| null | yes | `null` on normal append; set on fork |
| `privacy_profile` | const `"default"` | yes | Only profile at launch; gap-safe |

### Deviations from #13 thread pin

The [#13 settlement](https://github.com/Redential/redential-cli/issues/13) named a
smaller field set. This draft **extends** it deliberately; the pin is honest about
what changed:

| #13 thread | This draft | Rationale |
| --- | --- | --- |
| `receipt_count` (single) | `receipt_count_total` + `receipt_count_since_prev` | Segment size vs cumulative depth for `chain_verify` without gap exposure |
| (implicit identity) | `identity_hash` | Explicit server-side lineage key (bundle-compatible family) |
| (not named) | `activity_period` | Coarse quarter bucket — default privacy profile |
| (not named) | `first_anchor_at` | Detect anchor-timing arbitrage (`anchor_timing_suspect`) |
| (not named) | `schema_version` | Ceremony pin before `anchor.v1` |
| (not named) | `privacy_profile` | Closed profile id; only `"default"` at launch |

### `activity_period` (coarse buckets — default)

Closed vocabulary — **quarter granularity**, no day/week precision:

```
YYYY-Q1 | YYYY-Q2 | YYYY-Q3 | YYYY-Q4
```

Server stores the bucket of `received_at_server`, not per-receipt dates.
Verifiers see at most: "activity anchored in 2026-Q2" — not a daily grid.

**Gap non-exposure (non-negotiable):** hiring UI and challenger APIs must
not render inter-anchor silence, session spacing, or "days since last
receipt." Those patterns are human-shaped (vacation, bench, leave) and
discriminatory. Chain depth and aggregate `receipt_count_*` are allowed;
temporal lacunae are not.

### `reset_reason` (chain fork — revoke forward, not delete)

| Value | Meaning |
| --- | --- |
| `null` | Continuous lineage; `seq` incremented |
| `genesis` | First anchor for a new `chain_id` |
| `operator_reset` | User typed confirmation (private-label rules); old `chain_id` frozen |
| `device_migration` | Cross-signed export/import; old `chain_id` frozen |

A local vault splice without `operator_reset` or `device_migration` must
**fork** `chain_id`. Verifiers see discontinuity — chain A stopped, chain B
started — not a seamless narrative.

### Clock skew rule (ε)

Default `ε = 7 days` per [#13](https://github.com/Redential/redential-cli/issues/13)
and the `backdated-segment` fixture (`epsilon_days: 7`).

**Within this submit** (client claim vs server ingest) — **future bound only**:

```
max_finished_at_claimed - received_at_server ≤ ε
```

A `max_finished_at_claimed` beyond `received_at_server + ε` → **reject**
(`clock_suspect`). There is **no** within-submit past bound: honest infrequent
submitters may anchor sessions older than ε (e.g. work in January, submit in
March). The past direction is governed entirely by the prior-anchor rule below.

**Vs prior anchor** (segment must not backdate before the last honest anchor):

```
max_finished_at_claimed ≥ prior_anchor.received_at_server - ε
```

Violation → **reject** (`segment_backdate_suspect`). On **genesis** (no prior
anchor), pre-anchor history is not hard-rejected here — `first_anchor_at` plus
low verifier weight for pre-anchor claims handles resume-padding without punishing
first-timers with real old history.

---

## Attested display (no new tiers)

Chain depth is shown **inside Attested** — e.g. "26 anchors over 6 months",
`receipt_count_total` — not a separate trust tier name. The vocabulary stays
small: Attested (metadata) and Attested + defended (audio). Chain never
outranks defended (`faq.md` rule holds).

---

## Local vault file (client-side)

Path: `~/.config/redential/vault.json` (never repo cwd; same config-dir family as
`credentials.json`). Mode: **`0600`**. Included
in secret-scan paths before any upload.

Append-only receipt chain. Each receipt links `prev_receipt_hash`. Receipt
body follows sketch v2 floor (hashes, dirty booleans, `commits_count`, etc.).

**Principle 2** (merged [#37](https://github.com/Redential/redential-cli/pull/37)) —
constitution this draft points at. Vault readers: `session finish`, voluntary
`redential anchor` (future), and `submit`. No resident process; anchors ride
submit or explicit one-shot only.

---

## `chain_verify` (challenger API — sketch)

Inputs: full receipt segment + prior anchor history for `identity_hash`.

Outputs (closed enum verdicts only):

| Verdict | When |
| --- | --- |
| `ok` | Hash chain intact, head matches, ε satisfied, no fork anomaly |
| `segment_backdate_suspect` | `max_finished_at` vs prior anchor window |
| `chain_splice_suspect` | `seq` gap or `prev_anchor_hash` mismatch without `reset_reason` |
| `anchor_timing_suspect` | `first_anchor_at ≈ received_at_server` and `receipt_count_total ≫ 1` |
| `clock_suspect` | Large skew between claimed finish times and server receipt (heuristic) |

No verdict may cite gap duration, session spacing, or calendar holes.

---

## Relation to bundle `integrity.date_forensics`

Vault anchors add **session-granularity** time binding; `date_forensics`
adds **commit-granularity** replay detection. Complementary — not merged.
Vault receipts must not smuggle per-commit dates that bypass bundle bounds.

---

## Next ceremony steps

1. Promote `anchor.v0.discussion` → `anchor.v1.json` after maintainer review
2. ~~Principle 2 amendment~~ — **done** ([#37](https://github.com/Redential/redential-cli/pull/37))
3. Land `fixture:backdated-segment` negative test (companion PR) before vault code ships
4. Privacy pass: vault JSON through `assertNoSecrets` + hostile fixture

*ΔΣ=42 — discussion draft; not the trust contract until schema ceremony.*
