export type Track = {
  /** The agent's name, else its task description; `main` for the main thread. */
  label: string
  /**
   * False for a loop `$.agent.list()` does not name (an engine fork, a
   * workflow's agent): its size is kept, and it is never warned or told to rotate.
   */
  isListed: boolean
  /** Context size of the agent's latest model request, in tokens. */
  tokens: number
  /** When that request was made, in `$.clock.now()` milliseconds. */
  at: number
  hasWarned: boolean
  /** The context size the last rotation note was raised at; null before the first. */
  notedAt: number | null
  /** A rotation note waits for the agent's next tool result. */
  isNotePending: boolean
  /**
   * Where the engine auto-compacts this agent, in tokens: main's as the engine reports it,
   * a subagent's estimated from its window; null when unknown (the fallback window's is used).
   */
  compactAt: number | null
}

/** Main's handoff-then-compact cycle. */
export type MainCycle = {
  /**
   * `idle`: nothing asked. `asked`: the handoff note was given; main's next
   * answered turn end compacts. `compacting`: that compaction is under way.
   */
  phase: 'idle' | 'asked' | 'compacting'
  /** When the note was given, in `$.clock.now()` milliseconds; a handoff file at least this new is this cycle's. */
  askedAt: number | null
  /** Compactions this cycle asked for that did not stand. */
  attempts: number
  /** What main reads first after a compaction, waiting for its next tool result or prompt; null when none waits. */
  resumeNote: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-budget': { agents: Record<string, Track>; main: MainCycle }
  }
}
