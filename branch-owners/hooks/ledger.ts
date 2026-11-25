// Pure ledger logic: who owns which branch, pruning, and the table. No `$` here.

export type Owned = {
  branch: string
  /** A role name (`main`, the agent's name or description), else its id. */
  owner: string
  ownerAgentId?: string
  sessionId: string
  /** Milliseconds since the epoch. */
  createdAt: number
  /** The branch's head when it was claimed. */
  createdSha: string
  /**
   * False when that head was already a commit of the branch's own (created
   * and committed in one command); absent in a record written before this
   * was kept, which reads as true.
   */
  wasFresh?: boolean
  worktreePath?: string
}

/** One repository's ledger, keyed by branch name. */
export type Ledger = Record<string, Owned>

/** One local branch as `git for-each-ref` lists it. */
export type Ref = {
  branch: string
  sha: string
  shortSha: string
  /** Seconds since the epoch of the head commit. */
  committedAt: number
}

export type Row = Ref & { owner: string; owned?: Owned }

export const REF_FORMAT =
  '%(refname:short)%09%(objectname)%09%(objectname:short)%09%(committerdate:unix)'

export const UNKNOWN_OWNER = 'unknown'

/** The store key of a repository's ledger. */
export function ledgerKey(root: string): string {
  return `repo:${root}`
}

/** The most records one repository's ledger keeps; the oldest claims go first. */
export const MAX_ENTRIES = 500

function isOwned(value: unknown, branch: string): value is Owned {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>

  return (
    v.branch === branch &&
    typeof v.owner === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.createdSha === 'string' &&
    typeof v.createdAt === 'number' &&
    Number.isFinite(v.createdAt) &&
    (v.wasFresh === undefined || typeof v.wasFresh === 'boolean') &&
    (v.ownerAgentId === undefined || typeof v.ownerAgentId === 'string') &&
    (v.worktreePath === undefined || typeof v.worktreePath === 'string')
  )
}

/** A ledger as the store held it, read defensively: a record of the wrong shape is dropped. */
export function parseLedger(stored: unknown): Ledger {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const ledger: Ledger = {}
  for (const [branch, value] of Object.entries(stored)) {
    if (isOwned(value, branch)) ledger[branch] = value
  }

  return ledger
}

/**
 * Keeps a ledger bounded between `/branch-owners` runs: drops the branches
 * that no longer exist (when `existing` is known), then the oldest claims past
 * `max`. Answers `ledger` itself when nothing was dropped.
 */
export function compact(ledger: Ledger, existing: ReadonlySet<string> | undefined, max: number = MAX_ENTRIES): Ledger {
  const live = Object.entries(ledger).filter(([branch]) => existing === undefined || existing.has(branch))
  const kept = live.length <= max ? live : [...live].sort(([, a], [, b]) => b.createdAt - a.createdAt).slice(0, Math.max(0, max))
  if (kept.length === Object.keys(ledger).length) return ledger

  return Object.fromEntries(kept)
}

/** `current` without the branches in `dropped`: a prune re-applied to a ledger another session may have added to since. */
export function without(current: Ledger, dropped: readonly string[]): Ledger {
  if (!dropped.some(branch => Object.hasOwn(current, branch))) return current
  const gone = new Set(dropped)

  return Object.fromEntries(Object.entries(current).filter(([branch]) => !gone.has(branch)))
}

/** First writer wins: a branch already owned keeps its owner. */
export function claim(ledger: Ledger, owned: Owned): Ledger {
  return Object.hasOwn(ledger, owned.branch) ? ledger : { ...ledger, [owned.branch]: owned }
}

export function parseRefs(stdout: string): Ref[] {
  const refs: Ref[] = []
  for (const line of stdout.split('\n')) {
    const [branch, sha, shortSha, committedAt] = line.split('\t')
    if (!branch || !sha || !shortSha) continue
    refs.push({ branch, sha, shortSha, committedAt: Number(committedAt) || 0 })
  }

  return refs
}

export function parseBranchNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** Where `branch` is checked out, absolute, from `git worktree list --porcelain`. */
export function worktreeOf(porcelain: string, branch: string): string | undefined {
  for (const entry of porcelain.split(/\n\s*\n/)) {
    const lines = entry.split('\n').map(line => line.trim())
    const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path
  }

  return undefined
}

/**
 * Drops the branches that are gone and the ones merged into the base. One
 * kept back: a branch claimed with no commit of its own and still at that
 * head has no work yet (git calls it merged), so its owner stands.
 */
export function prune(ledger: Ledger, refs: readonly Ref[], unmerged: readonly string[]): Ledger {
  const heads = new Map(refs.map(ref => [ref.branch, ref.sha]))
  const open = new Set(unmerged)
  const kept: Ledger = {}
  for (const [branch, owned] of Object.entries(ledger)) {
    const head = heads.get(branch)
    if (head === undefined) continue
    const isUntouched = owned.wasFresh !== false && head === owned.createdSha
    if (!open.has(branch) && !isUntouched) continue
    kept[branch] = owned
  }

  return kept
}

/** The unmerged branches, each with its owner, oldest head first. */
export function toRows(ledger: Ledger, refs: readonly Ref[], unmerged: readonly string[]): Row[] {
  const open = new Set(unmerged)

  return refs
    .filter(ref => open.has(ref.branch))
    .map(ref => {
      const owned = Object.hasOwn(ledger, ref.branch) ? ledger[ref.branch] : undefined

      return owned === undefined
        ? { ...ref, owner: UNKNOWN_OWNER }
        : { ...ref, owner: owned.owner, owned }
    })
    .sort((a, b) => a.committedAt - b.committedAt || a.branch.localeCompare(b.branch))
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`

  return `${Math.floor(seconds / 86400)}d`
}

export function formatTable(rows: readonly Row[], base: string, nowMs: number): string {
  if (rows.length === 0) return `No branches unmerged into ${base}.`

  const cells = [
    ['branch', 'owner', 'age', 'head'],
    ...rows.map(row => [
      row.branch,
      row.owner,
      row.committedAt > 0 ? formatAge(nowMs / 1000 - row.committedAt) : '?',
      row.shortSha,
    ]),
  ]
  const widths = [0, 1, 2, 3].map(column =>
    Math.max(...cells.map(line => (line[column] ?? '').length)),
  )
  const lines = cells.map(line =>
    line.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd(),
  )
  const unknown = rows.filter(row => row.owner === UNKNOWN_OWNER).length

  return [
    `${rows.length} branch${rows.length === 1 ? '' : 'es'} unmerged into ${base}, ${unknown} with no known owner:`,
    ...lines,
  ].join('\n')
}

export function toExport(root: string, base: string, rows: readonly Row[], nowMs: number): string {
  const branches = rows.map(row => ({
    branch: row.branch,
    owner: row.owner,
    ownerAgentId: row.owned?.ownerAgentId ?? null,
    sessionId: row.owned?.sessionId ?? null,
    createdAt: row.owned === undefined ? null : new Date(row.owned.createdAt).toISOString(),
    worktreePath: row.owned?.worktreePath ?? null,
    sha: row.sha,
    shortSha: row.shortSha,
    lastCommitAt: row.committedAt > 0 ? new Date(row.committedAt * 1000).toISOString() : null,
  }))

  return `${JSON.stringify({ repo: root, base, generatedAt: new Date(nowMs).toISOString(), branches }, null, 2)}\n`
}
