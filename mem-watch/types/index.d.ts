/** The alert episode every session of this plugin shares, kept in `$.store` under `alert`. */
export type AlertState = {
  /** False from an alert until both figures have recovered. */
  isArmed: boolean
  /** When the last alert fired, in `$.clock.now()` milliseconds. */
  lastAlertAt: number | null
  /** The id of the session that took that alert: the one that wakes its model. */
  claimedBy: string | null
}

declare module 'claude-code' {
  interface PluginState {
    /** The `lastAlertAt` this session has already shown its toast for; null before the first. */
    'mem-watch': {
      toastedFor: number | null
      /** The background Bash jobs this session started that are still counted against `maxBackgroundJobs`, by task id. */
      jobs: Record<string, { id: string; at: number; command: string }>
    }
  }
}
