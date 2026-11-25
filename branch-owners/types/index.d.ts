/** Agent id to the role name its spawn gave it (name, else description). */
export type AgentLabels = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'branch-owners': { agents: AgentLabels }
  }
}
