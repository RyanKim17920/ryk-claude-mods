import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { REF_FORMAT, claim, compact, formatTable, ledgerKey, parseBranchNames, parseLedger, parseRefs, prune, toExport, toRows, without, worktreeOf } from './ledger'
import type { Ledger, Owned } from './ledger'
import { parseBranchCreations } from './parse'
import type { Creation } from './parse'

const COMMAND = 'branch-owners'
const MAIN = 'main'
/** `$.store` has no compare-and-set: a claim another session's write overwrote is made again, this many times at most. */
const MAX_WRITE_TRIES = 3
const agents = atom({ plugin: 'branch-owners', key: 'agents' } as const, {})

type Candidate = { branch: string; dir?: string; worktreePath?: string; agentId?: string; fallback?: string }

/** Runs git and answers its trimmed stdout, or undefined when it failed. */
async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  const ran = await $.process.run(['git', ...args], { timeoutMs: 10_000 })

  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

/** `~` and `~/x` as the shell expands them; git and `$.fs` take paths literally. */
async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? path : `${home.replace(/\/+$/, '')}${path.slice(1)}`
}

/** The repository `dir` is in (its main working tree), else the session's. */
async function repoRoot($: EngineInterface, dir: string | undefined): Promise<string | undefined> {
  if (dir !== undefined) {
    const common = await git($, ['-C', await expandHome($, dir), 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (common?.endsWith('/.git')) return common.slice(0, -'/.git'.length)
  }

  return (await $.session.repo())?.root
}

async function headOf($: EngineInterface, root: string, branch: string): Promise<string | undefined> {
  return (await git($, ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) || undefined
}

async function readLedger($: EngineInterface, root: string): Promise<Ledger> {
  return parseLedger(await $.store.get(ledgerKey(root)))
}

// One writer at a time within this session: agents run in parallel.
let writing: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const ran = writing.then(work, work)
  writing = ran.catch(() => undefined)

  return ran
}

/**
 * Stores `owned` unless the branch is owned already, bounding the ledger as
 * it goes, then reads it back: another session may have written over it.
 */
async function store($: EngineInterface, root: string, owned: Owned, existing: ReadonlySet<string> | undefined): Promise<void> {
  await serialized(async () => {
    for (let tries = 0; tries < MAX_WRITE_TRIES; tries++) {
      const ledger = await readLedger($, root)
      if (Object.hasOwn(ledger, owned.branch)) return
      await $.store.set(ledgerKey(root), compact(claim(ledger, owned), existing))
      if (Object.hasOwn(await readLedger($, root), owned.branch)) return
    }
  })
}

/** Records each branch that now exists and has no owner yet. */
async function record($: EngineInterface, candidates: readonly Candidate[]): Promise<void> {
  const labels = await read($, agents)
  for (const { branch, dir, worktreePath, agentId, fallback } of candidates) {
    const root = await repoRoot($, dir)
    if (root === undefined) continue
    const createdSha = await headOf($, root, branch)
    if (createdSha === undefined) continue
    // A head no other branch holds is already work of this branch's own.
    const holders = await git($, ['-C', root, 'for-each-ref', '--contains', createdSha, '--format=%(refname:short)', 'refs/heads'])
    const wasFresh = holders === undefined || parseBranchNames(holders).some(name => name !== branch)
    // The command may name the worktree relative to a directory only the shell knew: git has it absolute.
    const listed = worktreePath === undefined ? undefined : await git($, ['-C', root, 'worktree', 'list', '--porcelain'])
    const worktree = worktreePath === undefined ? undefined : (worktreeOf(listed ?? '', branch) ?? (await expandHome($, worktreePath)))
    const label = agentId === undefined ? undefined : labels[agentId]
    const owner = agentId === undefined ? MAIN : (typeof label === 'string' ? label : (fallback || agentId))
    const names = await git($, ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    const existing = names === undefined ? undefined : new Set(parseBranchNames(names))
    await store($, root, {
      branch, owner, sessionId: await $.session.id(), createdAt: await $.clock.now(), createdSha, wasFresh,
      ...(agentId === undefined ? {} : { ownerAgentId: agentId }),
      ...(worktree === undefined ? {} : { worktreePath: worktree }),
    }, existing)
  }
}

/**
 * The creations whose branch did not exist before the command ran: one that
 * did (`git checkout -b x || git checkout x`) was not created by it. When
 * this cannot be told, every creation stands.
 */
async function notYetExisting($: EngineInterface, created: readonly Creation[]): Promise<Creation[]> {
  try {
    const fresh: Creation[] = []
    for (const one of created) {
      const root = await repoRoot($, one.dir)
      if (root === undefined || (await headOf($, root, one.branch)) === undefined) fresh.push(one)
    }

    return fresh
  } catch (error) {
    $.ui.log(`${COMMAND}: could not check which branches existed: ${String(error)}`, { to: 'debug' })

    return [...created]
  }
}

/** A failure of ours is logged and never reaches the tool's result. */
async function recordQuietly($: EngineInterface, candidates: readonly Candidate[]): Promise<void> {
  if (candidates.length === 0) return
  try {
    await record($, candidates)
  } catch (error) {
    $.ui.log(`${COMMAND}: not recorded: ${String(error)}`, { to: 'debug' })
  }
}

/** A base git would read as an option, or that is not one word, is refused. */
function isUsableBase(base: string): boolean {
  return base !== '' && !base.startsWith('-') && !/[\s\0]/.test(base)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branch-owners',
      description: 'List unmerged branches with the agent that created each',
      argumentHint: '[json]',
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const { agentId } = started.deny === undefined ? started : { agentId: undefined }
    const label = e.name || e.description || e.subagentType
    if (agentId !== undefined && label) {
      await update($, agents, labels => ({ ...labels, [agentId]: label })).catch(() => undefined)
    }

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const created = parseBranchCreations(e.command)
    const fresh = created.length === 0 ? [] : await notYetExisting($, created)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await recordQuietly($, fresh.map(one => ({ ...one, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const result: unknown = ran.deny === undefined && ran.isError !== true ? ran.result : undefined
    if (typeof result !== 'object' || result === null || !('status' in result) || result.status !== 'completed') return ran
    const { worktreeBranch, worktreePath, agentId } = result as { worktreeBranch?: unknown; worktreePath?: unknown; agentId?: unknown }
    if (typeof worktreeBranch === 'string' && worktreeBranch !== '') {
      await recordQuietly($, [{
        branch: worktreeBranch,
        ...(typeof agentId === 'string' ? { agentId } : {}),
        fallback: e.name || e.description,
        ...(typeof worktreePath === 'string' && worktreePath !== '' ? { dir: worktreePath, worktreePath } : {}),
      }])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'branch-owners' }, async ($, e) => {
    try {
      const root = (await $.session.repo())?.root
      if (root === undefined) return { text: `${COMMAND}: this session is not in a git repository.` }

      const configured = String(options.baseBranch ?? '').trim()
      if (configured !== '' && !isUsableBase(configured)) {
        return { text: `${COMMAND}: the baseBranch option "${configured}" is not a branch name; nothing was changed.` }
      }
      const detected = await git($, ['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
      const base = configured || (detected && isUsableBase(detected) ? detected : 'main')
      const refsOut = await git($, ['-C', root, 'for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads'])
      const unmergedOut = await git($, ['-C', root, 'branch', '--no-merged', base, '--format=%(refname:short)'])
      if (refsOut === undefined || unmergedOut === undefined) {
        return { text: `${COMMAND}: git could not list the branches unmerged into ${base}; nothing was changed.` }
      }
      const refs = parseRefs(refsOut)
      const unmerged = parseBranchNames(unmergedOut)

      const ledger = await serialized(async () => {
        const before = await readLedger($, root)
        const after = compact(prune(before, refs, unmerged), undefined)
        const dropped = Object.keys(before).filter(branch => !Object.hasOwn(after, branch))
        // Read again just before the write: a claim another session made meanwhile stands.
        if (dropped.length > 0) await $.store.set(ledgerKey(root), without(await readLedger($, root), dropped))

        return after
      })
      const rows = toRows(ledger, refs, unmerged)
      const now = await $.clock.now()
      const table = formatTable(rows, base, now)
      if (e.args.trim() !== 'json') return { text: table }

      const exportPath = String(options.exportPath ?? '').trim()
      if (exportPath === '') return { text: `${table}\n\nNo file written: set this plugin's exportPath option.` }
      const path = await expandHome($, exportPath)
      await $.fs.write(path, toExport(root, base, rows, now))

      return { text: `${table}\n\nWrote ${rows.length} rows to ${path}.` }
    } catch (error) {
      return { text: `${COMMAND}: failed: ${String(error)}` }
    }
  }).catch(() => ({ text: `${COMMAND}: failed; see the debug log.` }))
}
