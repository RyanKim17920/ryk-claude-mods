// Made-up teammate deliveries (each less PREAMBLE and TRAILER): a prose report and the idle notice
// ("Teammate ... finished" when it has no idleReason) the same teammate raised after it. "drop" is a
// closing turn that only rewords the report, the kind a lead answers with a no-op turn; "pass" holds
// something its report did not.

import { idleNotice, teammateMessage } from './samples'

export type FinishedPair = {
  id: string
  expect: 'drop' | 'pass'
  teammate: string
  /** [when (ms), delivery] */
  report: readonly [number, string]
  notice: readonly [number, string]
}

const T0 = Date.UTC(2026, 0, 16, 14, 0, 0)
const at = (seconds: number): number => T0 + seconds * 1000

const report = (teammate: string, summary: string, body: string): string => teammateMessage(teammate, body, summary)
/** The closing notice: `idleReason` "available", or none ("Teammate ... finished"). */
const closing = (teammate: string, result: string, more: Record<string, unknown> = {}): string => idleNotice(teammate, result, more)
const finished = (teammate: string, result: string, more: Record<string, unknown> = {}): string =>
  idleNotice(teammate, result, { idleReason: undefined, ...more })

export const FINISHED_PAIRS: readonly FinishedPair[] = [
  {
    id: 'warehouse-sync-v1',
    expect: 'drop',
    teammate: 'warehouse-sync',
    report: [
      at(0),
      report(
        'warehouse-sync',
        'Stock sync job is built and checked: 12/12 fixtures match',
        'The stock sync job is built and checked: 12/12 fixtures match the warehouse export.\n\n**Where:** branch `feat/stock-sync`, head `6a41d0e2b`, pushed for review. The job lives in `jobs/stock_sync/` with a design note in `jobs/stock_sync/NOTES.md`.\n\n**What it does:** every 15 minutes it reads the warehouse export, converts pack counts to single units, and writes the stock level per product and store. Reserved units are taken off before the level is written, so a product in an open cart is never sold twice.\n\n**Checks:**\n| fixture set | match |\n|---|---|\n| single store | 4/4 |\n| multi store | 5/5 |\n| pack sizes | 3/3 |\n\nRuntime is 2.4 s for the full catalogue. The review checklist in the design note is complete.',
      ),
    ],
    notice: [
      at(27),
      closing(
        'warehouse-sync',
        'I sent the team lead the full report. The stock sync job is built and checked, and 12/12 fixtures match the warehouse export.\n\n- **Where:** branch `feat/stock-sync`, head `6a41d0e2b`, pushed for review, with the design note in `jobs/stock_sync/NOTES.md`.\n- **What it does:** it reads the warehouse export every 15 minutes, converts pack counts to single units, takes reserved units off, and writes the stock level per product and store.\n- **Checks:** single store 4/4, multi store 5/5, pack sizes 3/3; the full catalogue runs in 2.4 s.',
      ),
    ],
  },
  {
    id: 'warehouse-sync-v2',
    // A lead could read it as a repeat, but it names the day-7 returns, which its report did not: it enters.
    expect: 'pass',
    teammate: 'warehouse-sync',
    report: [
      at(1200),
      report(
        'warehouse-sync',
        'Stock sync v2 is pushed: returns are counted, 16/16 fixtures match',
        'Stock sync v2 is pushed at `b72e9c014` on `feat/stock-sync` and 16/16 fixtures match.\n\n**What changed:** returned units are now counted back into stock once the warehouse marks them as restocked, and a return that is never restocked stays out. The four new fixtures cover a return, a partial return, a damaged return and a return to another store.\n\n**Unchanged:** the 15 minute schedule, the pack conversion and the reserved units.',
      ),
    ],
    notice: [
      at(1222),
      closing(
        'warehouse-sync',
        'Stock sync v2 is pushed at `b72e9c014` and 16/16 fixtures match.\n\n- **Returns:** returned units are counted back into stock once the warehouse marks them as restocked; the day-7 returns that are never restocked stay out.\n- **Fixtures:** the four new ones cover a return, a partial return, a damaged return and a return to another store.',
      ),
    ],
  },
  {
    id: 'pricing-model-v1',
    expect: 'drop',
    teammate: 'pricing-model',
    report: [
      at(2400),
      report(
        'pricing-model',
        'Discount rules v1 are live on staging at a41c93e02',
        "Discount rules v1 are live on staging at `a41c93e02` on `feat/discount-rules`. 15 of 15 rule tests match on the same seed carts, with totals unchanged.\n\n**What changed:**\n- **Rule order:** rules now run in a fixed order, cart total first, so two coupons always apply the same way.\n- **`rules.yaml`:** I removed the rows that duplicated the coupon table: stacking limit, minimum spend and the loyalty bonus. 22 rows remain.\n- **Rounding:** every discount is rounded to the cent once, at the end, instead of once per rule.\n\nThe release notes are in `docs/discounts.md`.",
      ),
    ],
    notice: [
      at(2421),
      closing(
        'pricing-model',
        'I put discount rules v1 live on staging and sent the team lead the head and the rule test table. Head is `a41c93e02` on `feat/discount-rules`; 15 of 15 rule tests match on the same seed carts, with totals unchanged.\n\n**What changed:**\n- **Rule order:** a fixed order, cart total first, so two coupons always apply the same way.\n- **`rules.yaml`:** I removed the rows that duplicated the coupon table (stacking limit, minimum spend, loyalty bonus); 22 rows remain.\n- **Rounding:** once, to the cent, at the end instead of once per rule.',
      ),
    ],
  },
  {
    // The case this class was written for: a rewording with a signal ("Decision for you") its report already held.
    id: 'pricing-model-handoff',
    expect: 'drop',
    teammate: 'pricing-model',
    report: [
      at(6000),
      report(
        'pricing-model',
        'Discount scoring redesign drafted, not implemented; handing off',
        "I've drafted the discount scoring redesign but not implemented it. I hit my context limit, so I'm handing off rather than starting the code. Nothing was redeployed, per your hold until the pricing review. The branch is unchanged at `5be21c07d`.\n\n**Proposed scoring:** five rules of equal weight. The share of rules met goes in `score.json` as the headline score; `eligible.txt` stays binary.\n1. Cart total above the threshold\n2. Loyalty tier (new field)\n3. Region (new field)\n4. Coupon stacking limit\n5. Fraud check (credited only when rule 4 passes)\n\n**Projected scores:** a cart that meets every rule scores 1.0; the common partial case scores 0.6; a cart that fails the fraud check scores 0.4 at most.\n\n**Decision for you:** keep `eligible.txt` binary, or switch it to the graded score? I recommend keeping it binary until the pricing review signs off.\n\nHandoff notes are in `notes/scoring-handoff.md`.",
      ),
    ],
    notice: [
      at(6026),
      finished(
        'pricing-model',
        "I've drafted the graded discount scoring redesign but not implemented it, and I'm handing off because I hit my context limit. Nothing was redeployed and the branch is unchanged at `5be21c07d`.\n\n- **Scoring:** five rules of equal weight; the share of rules met goes in `score.json` as the headline score, and `eligible.txt` stays binary.\n- **Projected scores:** 1.0 for a cart that meets every rule, 0.6 for the common partial case, 0.4 at most for a cart that fails the fraud check.\n- **Decision for you:** keep `eligible.txt` binary or switch it to the graded score; I recommend binary until the pricing review signs off.\n\nHandoff notes are in `notes/scoring-handoff.md`.",
      ),
    ],
  },
  {
    id: 'ledger-fix',
    expect: 'pass',
    teammate: 'ledger-fix',
    report: [
      at(9000),
      report(
        'ledger-fix',
        'Refund rounding gap found; fix in progress on fix/refund-rounding',
        'The refund rounding gap is real: a partial refund on a discounted line is rounded twice, so the ledger drifts by a cent on about 1 in 300 refunds.\n\n- **Where:** `billing/refunds.ts`, in the split between the line discount and the order discount.\n- **Fix:** round once, after the split. I am writing it on `fix/refund-rounding` and will run the billing suite and the ledger replay when it builds.',
      ),
    ],
    notice: [
      at(9016),
      finished(
        'ledger-fix',
        "The refund rounding gap is fixed at `cd4528ce` on `fix/refund-rounding`; the ledger replay has not finished at that head.\n\n- **Billing suite:** 320 passed, 0 failed on the laptop.\n- **Ledger replay:** still running against last month's refunds, so there is no drift number yet. If it shows any drift over 0 cents I will reopen the split.",
      ),
    ],
  },
  {
    id: 'perf-bisect',
    expect: 'pass',
    teammate: 'perf-bisect',
    report: [
      at(12000),
      report(
        'perf-bisect',
        'Checkout latency bisect queued',
        'The checkout latency bisect is queued: 14 commits between `3e8a01f` and `9b2c7d4`, run as a load test of 200 rps per commit on the staging runners. Expect results within the hour.',
      ),
    ],
    notice: [
      at(12078),
      finished(
        'perf-bisect',
        "Blocked on runner capacity for the checkout latency bisect, and waiting on the lead's decision; the culprit commit is not identified yet.\n\n**Blocker.** My bisect job is queued behind two release builds, and all 8 runners are held. The lead or release-1 needs to pause one release build; then the bisect takes those runners.\n\n**Narrowed so far:** the slowdown is between `5f0d2aa` and `9b2c7d4`, 6 commits.",
        { summary: '[to qa-2] Bisect split: what I am running on the runners' },
      ),
    ],
  },
  {
    id: 'search-relevance',
    expect: 'pass',
    teammate: 'search-relevance',
    report: [
      at(15000),
      report(
        'search-relevance',
        'Search ranking change offered; offline eval done',
        'The search ranking change is offered on `feat/ranking-boost` at `321bddf0`: in-stock products get a boost of 0.3. Offline eval on the saved query set: click-through on the top 5 results goes from 0.41 to 0.47.',
      ),
    ],
    notice: [
      at(15075),
      finished(
        'search-relevance',
        'The online test of the ranking change is still running, so no live click-through is confirmed yet.\n\n- **Branch:** `feat/ranking-boost` at `321bddf0`, offered to the lead; decision pending.\n- **Early numbers:** after 2 hours, 4.1% of sessions saw the boost and click-through is 0.45 for them against 0.43 for the rest. Too early to call.',
      ),
    ],
  },
]
