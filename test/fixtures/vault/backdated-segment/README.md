# fixture:backdated-segment

**Status:** negative fixture — reserved for vault `chain_verify` ceremony.
**Attack:** anchor-timing arbitrage + intra-segment backdating.
**Thread:** [RFC #13 issue #13](https://github.com/Redential/redential-cli/issues/13)

## Story

An honest operator anchored twice:

1. **2026-03-15** — week-1 head, 4 receipts, `activity_period: 2026-Q1`
2. **2026-06-20** — week-16 head, 3 receipts, `activity_period: 2026-Q2`

Real work happened in those windows. The operator never submitted the full
chain.

On **2026-07-22** (hiring push), an attacker fabricates **12 receipts**
claiming `finished_at` spread across **2026-04-01 .. 2026-06-10** (the gap
between honest anchors), splices them into a hash chain, and submits with
`max_finished_at_claimed: 2026-06-10T18:00:00Z`.

## Expected verifier outcome

| Check | Result |
| --- | --- |
| Hash chain internal consistency | passes (attacker recomputed hashes) |
| `head_hash` matches uploaded segment tail | passes |
| `max_finished_at_claimed` vs prior anchor `received_at_server` + ε | **fail** → `segment_backdate_suspect` |
| `first_anchor_at` for chain vs `received_at_server` at submit | **fail** → `anchor_timing_suspect` (if first server sighting is submit day with `receipt_count_total ≫ 1`) |
| Gap duration exposed to hiring UI | **must not happen** (privacy default) |

## Files

| File | Role |
| --- | --- |
| `honest-server-anchors.json` | Prior anchors already on server |
| `forged-submit-segment.json` | Client upload attempt |
| `expectations.json` | Machine-readable verdict contract |

## Privacy note

This fixture tests **backdating detection**, not gap surveillance. A correct
implementation flags the segment as suspect without revealing *why the honest
user had a quiet April* — only that claimed finish times are inconsistent
with prior anchor windows.
