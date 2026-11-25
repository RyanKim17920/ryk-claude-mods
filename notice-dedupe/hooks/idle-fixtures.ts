// A made-up team session: every teammate delivery a lead received while a team shipped the checkout
// rewrite of a web shop, oldest first: [when (ms), the delivery less PREAMBLE and TRAILER]. Each notice
// is written to one shape the judging must tell apart; the comment above it names the shape and its
// verdict with aggressiveIdle on. The mod is loaded at LOADED_AT; the half hour before it gives most
// teammates their last report.

import { idleNotice, teammateMessage } from './samples'

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0)
const at = (minutes: number): number => T0 + minutes * 60_000

export const LOADED_AT = at(30)

/** A teammate's prose report, its first line as the harness's summary. */
const report = (teammate: string, body: string): string => teammateMessage(teammate, body, body.split('\n')[0]?.slice(0, 80))
/** A teammate's idle notice raised at the end of a turn: no idleReason, as most come. */
const turnEnd = (teammate: string, result: string, more: Record<string, unknown> = {}): string =>
  idleNotice(teammate, result, { idleReason: undefined, ...more })
/** An idle notice that echoes a message the teammate just sent another teammate. */
const echo = (teammate: string, to: string, topic: string, result: string): string => turnEnd(teammate, result, { summary: `[to ${to}] ${topic}` })
/** Several blocks bundled into one delivery. */
const bundle = (...blocks: string[]): string => blocks.join('\n\n')

export const DELIVERIES: readonly (readonly [number, string])[] = [
  // Before the mod loads: the reports later notices are judged against.
  [
    at(5),
    report(
      'db-migrate',
      'All migrations are applied. The orders table migration ran on staging in 41 s with no lock waits, and the rollback script is in `db/rollback/0042_orders.sql`.',
    ),
  ],
  [at(6), turnEnd('db-migrate', 'Migration notes are in my report to the lead.')],
  [
    at(10),
    report(
      'docs-1',
      'The API reference is regenerated from the OpenAPI spec and published to the docs site. Every checkout endpoint has an example request and response.',
    ),
  ],
  [
    at(18),
    report(
      'api-1',
      "Checkout API refactor is pushed to `feat/checkout-v2` at 4f1c9a2e.\n\n- The cart service now reads prices from the pricing table, not the cache.\n- 212 passed, 0 failed on the API suite.\n\nNext I'll profile the order endpoint.",
    ),
  ],
  [
    at(20),
    report(
      'perf-2',
      "The load test harness is ready in `bench/load.ts`. Baseline p95 for the orders endpoint is 840 ms at 200 rps, and the slow path is the inventory join. I'm adding an index on inventory (sku, warehouse_id) and rerunning the load test against staging.",
    ),
  ],
  [
    at(22),
    report(
      'frontend-1',
      "The new cart page is behind the `cart_v2` flag on staging. Lighthouse performance is 91 on mobile and the bundle is 182 KB gzipped. I'm waiting on qa-1's smoke run before asking for the flag to go to 10% of users.",
    ),
  ],
  [
    at(25),
    report(
      'cache-2',
      'Cache warmer is deployed to staging. It primes the 500 most viewed product pages every five minutes, and the hit rate went from 62% to 88% in the first hour.',
    ),
  ],
  [
    at(27),
    report('search-index', "Search index rebuild is running on the staging server; 1.2M of 3.4M products are indexed. I'll report when it finishes."),
  ],

  // The mod is loaded.
  // An echo with no signal after a report: dropped.
  [at(30.5), echo('perf-2', 'db-migrate', 'Index question', 'Asked db-migrate whether the inventory index can be built online on staging.')],
  // An echo with no signal after a report: dropped.
  [at(31), echo('api-1', 'perf-2', 'Endpoint list', 'Sent perf-2 the list of checkout endpoints to add to the load test.')],
  // A plain idle notice that is one whole sentence of its report: dropped once, switch on or off.
  [at(32), idleNotice('db-migrate', 'All migrations are applied.')],
  // A closing notice after a report that left nothing open: dropped, switch on or off.
  [at(33), turnEnd('docs-1', "I'm done; nothing further to add.")],
  // An echo with no signal after a report, in backticks: dropped.
  [at(34), echo('frontend-1', 'qa-1', 'Smoke run', 'Asked qa-1 to run the smoke suite against the `cart_v2` flag on staging.')],
  // An echo with no signal after a report: dropped.
  [at(35), echo('cache-2', 'perf-2', 'Warmer timing', 'Told perf-2 the warmer runs every five minutes so its load test is not skewed.')],
  // A first contact (qa-1 never reported): enters, though it is only standing by.
  [at(36), idleNotice('qa-1', 'Oriented and standing by; nothing is actionable until a green staging build is reported.')],
  // A first contact echo, with a curly quote: enters.
  [at(37), echo('release-1', 'search-index', 'Reindex command', 'I’ve asked search-index for its reindex command so the release notes can quote it.')],
  // An echo with no signal after a report: dropped.
  [at(38), echo('search-index', 'release-1', 'Reindex command', 'Sent release-1 the reindex command.')],
  // An echo with a failure and a count: enters.
  [
    at(39),
    echo('perf-2', 'api-1', 'Pool size', 'Rerun failed on the orders endpoint: 37 errors at 200 rps; asked api-1 to check the database pool size.'),
  ],
  // An echo with a blocker: enters.
  [
    at(40),
    echo('api-1', 'frontend-1', 'Runner capacity', 'Blocked on CI runner capacity for the payment-flow bisect; the lead needs to free two runners.'),
  ],
  [at(40.5), report('audit-1', 'Started the audit of request logging across the API services.')],
  // An echo with no signal, held by the report bundled after it: enters.
  [
    at(41),
    bundle(
      echo('perf-2', 'cache-2', 'Bench script', 'Shared the bench script path with cache-2.'),
      report('cache-2', 'Warmer interval is now configurable through `WARMER_INTERVAL_S`; the default stays 300.'),
    ),
  ],
  // An echo with no signal, held by a failure bundled after it: both enter.
  [
    at(42),
    bundle(
      echo('frontend-1', 'docs-1', 'Screenshots', 'Pinged docs-1 about the cart page screenshots.'),
      turnEnd('api-1', 'Two contract tests failed after the rebase; fixing them now.'),
    ),
  ],
  // A pure waiting status, held by a first contact's blocker bundled after it: both enter.
  [
    at(43),
    bundle(
      turnEnd('frontend-1', "Waiting on qa-1's smoke run."),
      turnEnd('release-1', "Blocked: the release branch needs the lead's sign-off on the changelog."),
    ),
  ],
  // A report and, in the same delivery, a notice rewording it whose one signal the report held: held.
  [
    at(44),
    bundle(
      report(
        'api-1',
        "Rebased `feat/checkout-v2` onto main and fixed both contract tests; 214 passed, 0 failed at 7d3e0b91. The open item is the lead's decision on whether the inventory index ships with this release or the next one.",
      ),
      turnEnd('api-1', "Waiting on the lead's decision on whether the inventory index ships with this release."),
    ),
  ],
  // A rewording of its report with no signal: dropped.
  [at(45), turnEnd('perf-2', 'Harness is ready and the load test is rerunning against staging with the inventory index.')],
  // A result naming a new file: enters.
  [at(46), turnEnd('audit-1', 'The audit is written to `reports/logging_audit.md`; it lists every endpoint that logs a raw email address.')],
  // Runs under way that the report did not name: enters.
  [at(47), turnEnd('perf-2', 'Index build and the second load test are running on the staging server; results in about ten minutes.')],
  // A waiting status naming a path its report did not: enters.
  [at(48), turnEnd('perf-2', 'Waiting on the profile runs that write to `bench/out/orders_profile`.')],
  // A plain idle notice with words its report lacked: enters, switch on or off.
  [at(49), idleNotice('frontend-1', "The light test run is still going; I'll commit the screenshots and report when it completes.")],
  // News with an emoji: enters.
  [at(50), turnEnd('cache-2', 'Warmer is green on staging ✅ and the dashboard panel is live.')],
  [at(51), report('qa-1', 'Smoke suite on staging: 48 passed, 2 failed (both in the coupon flow). Logs are in `qa/smoke/2026-01-15.log`.')],
  // An echo with a blocker: enters.
  [at(52), echo('qa-1', 'frontend-1', 'Coupon failures', 'Told frontend-1 that the two coupon failures block the flag rollout.')],
  // A result with a new count and commit: enters.
  [at(53), turnEnd('api-1', 'Staging verification is done and reported (318 passed at 9c2e71b0).')],
  // A waiting status that holds a decision: enters.
  [at(54), turnEnd('cache-2', "Waiting on two things: the lead's decision on whether the warmer ships enabled, and qa-1's smoke run.")],
  // A sentence of its report, word for word, with no signal: dropped.
  [at(55), turnEnd('search-index', 'Search index rebuild is running on the staging server.')],
  // An echo past the window of its teammate's report (docs-1 reported 46 minutes before): enters.
  [at(56), echo('docs-1', 'frontend-1', 'Screenshots', 'Asked frontend-1 for cart page screenshots for the docs.')],
  // An echo with no signal after a report, with curly quotes and backticks: dropped.
  [at(57), echo('qa-1', 'frontend-1', 'Coupon logs', 'Sent frontend-1 the “coupon flow” logs from `qa/smoke/`.')],
]
