export type DropClass =
  | 'waiting'
  | 'delivered'
  | 'repeat-notification'
  | 'repeat-failure'
  | 'repeat-prompt'
  | 'repeat-send'
  | 'repeat-peer'
  | 'idle-after-report'
  | 'idle-peer-echo'
  | 'idle-restatement'
  | 'idle-waiting'
  | 'idle-paraphrase'
  | 'idle-closing'

export type Drop = {
  /** When it was dropped, in `$.clock.now()` milliseconds. */
  at: number
  kind: DropClass
  /** The first 80 characters of what was dropped. */
  excerpt: string
}

export type Seen = {
  /** A fingerprint of the normalised text last let through under this key. */
  digest: string
  /** When that text was let through. */
  at: number
  /** A teammate's report itself, to tell an idle notice that adds nothing to it by. */
  text?: string
}

export type Ledger = {
  counts: Partial<Record<DropClass, number>>
  /** The last ten drops, oldest first. */
  drops: Drop[]
  /** What was let through lately, by task id, by origin and text, by sender, recipient and text, or by reporting teammate. */
  seen: Record<string, Seen>
  /** Completed notifications this session that matched the boilerplate wording (absent: none yet). */
  matches?: number
  /** Ones that nearly did: short, matching neither class, but holding two or more of the boilerplate's own marks. */
  nearMisses?: number
}

/** The counters kept across sessions in the plugin's store, under `totals`. */
export type Totals = {
  /** When counting began, in milliseconds. */
  since: number
  drops: Partial<Record<DropClass, number>>
  /** Folded "report was delivered" rows emptied or stubbed (each counted under `delivered` too). */
  folded: number
  matches: number
  nearMisses: number
  lastNearMiss?: { at: number; excerpt: string }
  /** When the wording-drift toast was last raised, in milliseconds; shown and compared as a local day. */
  lastDriftWarningAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'notice-dedupe': { ledger: Ledger }
  }
}
