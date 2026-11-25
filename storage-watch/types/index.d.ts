/** The alert episode every session of this plugin shares, kept in `$.store` under `alert`. */
export type AlertState = {
  /** The deepest tier (GB) alerted in this episode; null once free space has recovered above the top tier. */
  alertedTier: number | null
  /** When each tier (keyed by its GB as a string) last alerted, in `$.clock.now()` milliseconds: its cooldown. */
  tierAlertedAt: Record<string, number>
  /** The tier of the most recent alert, so every session's toast can name it. */
  lastTier: number | null
  /** When the most recent alert fired, in `$.clock.now()` milliseconds. */
  lastAlertAt: number | null
  /** The id of the session that took that alert: the one that notifies (and, if enabled, wakes its model). */
  claimedBy: string | null
}

declare module 'claude-code' {
  interface PluginState {
    /** The `lastAlertAt` this session has already shown its toast for; null before the first. */
    'storage-watch': { toastedFor: number | null }
  }
}
