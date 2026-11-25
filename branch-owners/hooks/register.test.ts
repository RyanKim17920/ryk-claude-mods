import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MAX_ENTRIES, REF_FORMAT, ledgerKey } from './ledger'
import type { Ledger, Owned } from './ledger'
import { parseBranchCreations } from './parse'

const ROOT = '/repo'
const KEY = ledgerKey(ROOT)

/** Answers a git call: `live` holds the branches that exist now. */
type Git = (args: readonly string[], live: ReadonlySet<string>) => string | undefined

type Faults = { noRepo?: true; storeFails?: true; gitThrows?: true; registerFails?: true;afterSet?: (store: Record<string, unknown>) => void; beforeGet?: (store: Record<string, unknown>) => void }

/** The engine beneath the plugin: a repository whose git answers from `git`. */
function world(on: On, git: Git, entries: Record<string, unknown> = {}, faults: Faults = {}) {
  const store: Record<string, unknown> = { ...entries }
  const written: Record<string, string> = {}
  const commands: string[][] = []
  const registered: string[] = []
  /** The branches that exist: a Bash command that succeeds creates what it names. */
  const live = new Set<string>()

  mock.clock(on, { now: 1_000_000_000 })
  on('store.get', (_$, e) => {
    faults.beforeGet?.(store)

    return { value: store[e.key] }
  })
  on('store.set', (_$, e) => {
    if (faults.storeFails) throw new Error('store is full')
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    faults.afterSet?.(store)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.repo', () => ({
    value: faults.noRepo ? null : { root: ROOT, remote: null, internal: false, name: null },
  }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => {
    if (faults.registerFails) throw new Error('no commands here')
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('fs.write', (_$, e) => {
    written[e.path] = e.text

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (faults.gitThrows) throw new Error('git is not installed')
    commands.push([...e.argv])
    const stdout = e.argv[0] === 'git' ? git(e.argv.slice(1), live) : undefined

    return {
      value: {
        exitCode: stdout === undefined ? 1 : 0,
        stdout: stdout ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    if (e.command.includes('FAILS')) return { isError: true, result: 'exit 1', text: 'exit 1' }
    for (const { branch } of parseBranchCreations(e.command)) live.add(branch)

    return { result: { stdout: '', stderr: '', interrupted: false } as never, text: '' }
  })

  return { ledger: () => (store[KEY] ?? {}) as Ledger, store, written, commands, registered, live }
}

/** Every branch named is at `sha` once it exists; every other git call fails. */
const existing = (shas: Record<string, string>, worktrees?: string, holders = 'main'): Git => (args, live) => {
  if (args.includes('--contains')) return `${holders}\n${Object.keys(shas).join('\n')}`
  if (args.includes('for-each-ref')) return ['main', ...live].join('\n')
  const ref = args.at(-1) ?? ''
  const name = ref.replace('refs/heads/', '')
  if (args.includes('rev-parse') && args.includes('--verify')) return live.has(name) ? shas[name] : undefined
  if (args.includes('worktree')) return worktrees
  if (args.includes('--git-common-dir')) return args[1] === '/other' ? '/other/.git' : `${ROOT}/.git`

  return undefined
}

/**
 * A Bash call raised in a subagent's loop. The kit types `$.tool.call` as a
 * plugin's own call, which has no `agentId`; the event the engine raises does.
 */
const bashAs = ($: Engine, agentId: string, command: string) =>
  $.tool.call({ tool: 'Bash', command, agentId } as { tool: 'Bash'; command: string })

const SPAWN = {
  tool_use_id: 't1',
  prompt: 'p',
  description: 'check grader fairness',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: true,
  fork: false,
} as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

test('main creating a branch owns it', async ($, on) => {
  const w = world(on, existing({ 'feat/a': 'sha-a' }))

  await $.tool.call({ tool: 'Bash', command: 'git fetch && git checkout -b feat/a' })

  expect(w.ledger()).toEqual({
    'feat/a': { branch: 'feat/a', owner: 'main', sessionId: 'session-1', createdAt: 1_000_000_000, createdSha: 'sha-a', wasFresh: true },
  })
})

test('a subagent reads as its spawn name, and first writer wins', async ($, on) => {
  const w = world(on, existing({ 'feat/a': 'sha-a' }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))

  await $.agent.spawn({ ...SPAWN, name: 'grader-fairness' })
  await bashAs($, 'agent-1', 'git switch -c feat/a')
  await bashAs($, 'agent-2', 'git checkout -B feat/a')
  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(w.ledger()['feat/a']?.owner).toBe('grader-fairness')
  expect(w.ledger()['feat/a']?.ownerAgentId).toBe('agent-1')
})

test('an unnamed subagent reads as its description, an unseen one as its id', async ($, on) => {
  const w = world(on, existing({ a: '1', b: '2' }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))

  await $.agent.spawn(SPAWN)
  await bashAs($, 'agent-1', 'git branch a')
  await bashAs($, 'agent-9', 'git branch b')

  expect(w.ledger().a?.owner).toBe('check grader fairness')
  expect(w.ledger().b?.owner).toBe('agent-9')
})

test('a branch committed to in the command that created it is not recorded as fresh', async ($, on) => {
  const w = world(on, existing({ 'feat/a': 'sha-a' }, undefined, ''))

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a && git commit -m work' })

  expect(w.ledger()['feat/a']?.wasFresh).toBe(false)
})

test('a refused spawn records no name and is handed back as it was', async ($, on) => {
  world(on, existing({}))
  on('agent.spawn', () => ({ deny: 'no agents today' }))

  expect(await $.agent.spawn({ ...SPAWN, name: 'x' })).toEqual({ deny: 'no agents today' })
})

test('a failed command, a branch that does not exist, and a non-git command record nothing', async ($, on) => {
  const w = world(on, existing({ real: '1' }))

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b real && FAILS' })
  await $.tool.call({ tool: 'Bash', command: 'git checkout -b ghost || true' })
  await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(w.ledger()).toEqual({})
  // `real` and `ghost` are each looked up before their command; only `ghost`'s, which passed, after.
  expect(w.commands.filter(argv => argv.includes('--verify'))).toHaveLength(3)
})

test('git -C and a worktree are recorded under the repository they belong to', async ($, on) => {
  const w = world(on, existing({ 'feat/w': 'sha-w', 'feat/v': 'sha-v' }, 'worktree /other\nbranch refs/heads/main\n\nworktree /private/other/.trees/w\nbranch refs/heads/feat/w\n'))

  await bashAs($, 'a1', 'git -C /other worktree add -b feat/w .trees/w')
  await bashAs($, 'a1', 'git -C /other worktree add -b feat/v ../v')

  expect(w.store[ledgerKey('/other')]).toEqual({
    'feat/w': {
      branch: 'feat/w',
      owner: 'a1',
      ownerAgentId: 'a1',
      sessionId: 'session-1',
      createdAt: 1_000_000_000,
      createdSha: 'sha-w',
      wasFresh: true,
      worktreePath: '/private/other/.trees/w',
    },
    // git did not list this one: the path as the command spelled it stands.
    'feat/v': expect.objectContaining({ branch: 'feat/v', worktreePath: '/other/../v' }),
  })
  expect(w.ledger()).toEqual({})
})

test('an Agent result carrying a worktree branch records the agent as owner', async ($, on) => {
  const w = world(on, existing({ 'worktree-agent-7': 'sha-7' }))
  w.live.add('worktree-agent-7')
  on('tool.call', { tool: 'Agent' }, () => ({
    result: { status: 'completed', agentId: 'agent-7', worktreeBranch: 'worktree-agent-7', worktreePath: '/repo/.claude/worktrees/agent-7' } as never,
    text: 'done',
  }))

  await $.tool.call({ tool: 'Agent', description: 'speed owner', prompt: 'p' })

  expect(w.ledger()['worktree-agent-7']).toEqual({
    branch: 'worktree-agent-7',
    owner: 'speed owner',
    ownerAgentId: 'agent-7',
    sessionId: 'session-1',
    createdAt: 1_000_000_000,
    createdSha: 'sha-7',
    wasFresh: true,
    worktreePath: '/repo/.claude/worktrees/agent-7',
  })
})

test('an Agent result with no worktree, or launched in the background, records nothing', async ($, on) => {
  const w = world(on, existing({}))
  const results: unknown[] = [{ status: 'completed', agentId: 'a' }, { status: 'async_launched', agentId: 'b' }]
  on('tool.call', { tool: 'Agent' }, () => ({ result: results.shift() as never, text: '' }))

  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })

  expect(w.ledger()).toEqual({})
})

test('when git cannot run, the tool result is the engine\'s own and nothing is stored', async ($, on) => {
  const w = world(on, () => undefined, {}, { gitThrows: true })

  const ran = await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(ran.text).toBe('')
  expect(ran.isError).toBeUndefined()
  expect(w.ledger()).toEqual({})
})

test('when the store fails, the tool result is still the engine\'s own', async ($, on) => {
  world(on, existing({ 'feat/a': 'sha-a' }), {}, { storeFails: true })

  const ran = await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(ran.text).toBe('')
  expect(ran.deny).toBeUndefined()
})

const REFS = ['main\tmmmmmmmmmm\tmmmmmmm\t990000', 'feat/old\taaaaaaaaaa\taaaaaaa\t136000', 'feat/new\tbbbbbbbbbb\tbbbbbbb\t992800', 'feat/done\tdddddddddd\tddddddd\t100000'].join('\n')

/** A repository with three topic branches, `feat/done` merged into the base. */
const listing = (base: string, originHead?: string): Git => args => {
  if (args.includes('symbolic-ref')) return originHead
  if (args.includes('for-each-ref')) return args.includes(`--format=${REF_FORMAT}`) ? REFS : undefined
  if (args.includes('--no-merged')) return args.includes(base) ? 'feat/new\nfeat/old' : undefined

  return undefined
}

const LEDGER: Ledger = {
  'feat/old': { branch: 'feat/old', owner: 'hardening', ownerAgentId: 'a1', sessionId: 's0', createdAt: 5, createdSha: 'old0' },
  'feat/done': { branch: 'feat/done', owner: 'speed', ownerAgentId: 'a2', sessionId: 's0', createdAt: 5, createdSha: 'done0' },
  'feat/gone': { branch: 'feat/gone', owner: 'main', sessionId: 's0', createdAt: 5, createdSha: 'gone0' },
}

test('/branch-owners prints the unmerged branches and prunes merged and deleted ones', async ($, on) => {
  const w = world(on, listing('origin/main', 'origin/main'), { [KEY]: LEDGER })

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toBe(
    [
      '2 branches unmerged into origin/main, 1 with no known owner:',
      'branch    owner      age  head',
      'feat/old  hardening  10d  aaaaaaa',
      'feat/new  unknown    2h   bbbbbbb',
    ].join('\n'),
  )
  expect(Object.keys(w.ledger())).toEqual(['feat/old'])
  expect(w.written).toEqual({})
})

test('the base falls back to main without origin/HEAD, and the option overrides both', async ($, on) => {
  world(on, listing('main'))

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toContain('unmerged into main')
})

test('the baseBranch option names the base', { options: { baseBranch: 'release/v0.4' } }, async ($, on) => {
  world(on, listing('release/v0.4', 'origin/main'))

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toContain('unmerged into release/v0.4')
})

test('/branch-owners json writes the rows to exportPath', { options: { exportPath: '/tmp/owners.json' } }, async ($, on) => {
  const w = world(on, listing('main'), { [KEY]: LEDGER })

  const ran = await $.command.run({ command: 'branch-owners', args: 'json', ...RUN })
  const exported = JSON.parse(w.written['/tmp/owners.json'] ?? 'null')

  expect(ran.text).toContain('Wrote 2 rows to /tmp/owners.json.')
  expect(exported.base).toBe('main')
  expect(exported.branches.map((row: { branch: string; owner: string }) => [row.branch, row.owner])).toEqual([
    ['feat/old', 'hardening'],
    ['feat/new', 'unknown'],
  ])
})

test('/branch-owners json with no exportPath writes no file and says so', async ($, on) => {
  const w = world(on, listing('main'))

  const ran = await $.command.run({ command: 'branch-owners', args: 'json', ...RUN })

  expect(ran.text).toContain('No file written')
  expect(w.written).toEqual({})
})

test('when git fails, the command says so and the ledger is not pruned', async ($, on) => {
  const w = world(on, () => undefined, { [KEY]: LEDGER })

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toContain('git could not list the branches unmerged into main')
  expect(w.ledger()).toEqual(LEDGER)
})

test('outside a repository the command says so', async ($, on) => {
  world(on, () => undefined, {}, { noRepo: true })

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toContain('not in a git repository')
})

test('the command is registered when the session starts', async ($, on) => {
  const w = world(on, () => undefined)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(w.registered).toEqual(['branch-owners'])
})

const owned = (branch: string, over: Partial<Owned> = {}): Owned => ({
  branch, owner: 'someone', sessionId: 's0', createdAt: 5, createdSha: `${branch}-0`, ...over,
})

test('a branch that existed before the command is not claimed by it', async ($, on) => {
  const w = world(on, existing({ 'feat/a': 'sha-a', 'feat/b': 'sha-b' }))
  w.live.add('feat/a')

  await bashAs($, 'a1', 'git checkout -b feat/a || git checkout feat/a')
  await bashAs($, 'a1', 'git checkout -B feat/a origin/main && git switch -c feat/b')

  expect(Object.keys(w.ledger())).toEqual(['feat/b'])
})

test('a ~ in a cd or the exportPath is the home directory', { options: { exportPath: '~/owners.json' } }, async ($, on) => {
  const w = world(on, args => (args.includes('for-each-ref') || args.includes('--no-merged') ? '' : undefined))
  mock.env(on, { HOME: '/home/me/' })

  await $.tool.call({ tool: 'Bash', command: 'cd ~/repo && git checkout -b x' })
  const ran = await $.command.run({ command: 'branch-owners', args: 'json', ...RUN })

  expect(w.commands.some(argv => argv.join(' ') === 'git -C /home/me/repo rev-parse --path-format=absolute --git-common-dir')).toBe(true)
  expect(Object.keys(w.written)).toEqual(['/home/me/owners.json'])
  expect(ran.text).toContain('to /home/me/owners.json.')
})

test('an Agent result that is text, or carries fields of the wrong type, records nothing and is handed back', async ($, on) => {
  const w = world(on, existing({ x: '1' }))
  const results: unknown[] = ['plain text', { status: 'completed', worktreeBranch: 7 }, null]
  on('tool.call', { tool: 'Agent' }, () => ({ result: results.shift() as never, text: 'done' }))

  for (let i = 0; i < 3; i++) {
    expect((await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' })).text).toBe('done')
  }
  expect(w.ledger()).toEqual({})
})

test('malformed records in a stored ledger are dropped', async ($, on) => {
  const garbage = { a: 'x', b: { branch: 'other', owner: 'o' }, c: null, kept: owned('kept') }
  const w = world(on, existing({ 'feat/a': 'sha-a' }), { [KEY]: garbage })
  w.live.add('kept')

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(Object.keys(w.ledger()).sort()).toEqual(['feat/a', 'kept'])
})

for (const stored of [['feat/old'], 'nonsense', 42]) {
  test(`/branch-owners reads a ledger stored as ${JSON.stringify(stored)} as empty`, async ($, on) => {
    world(on, listing('main'), { [KEY]: stored })

    const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

    expect(ran.text).toContain('2 branches unmerged into main, 2 with no known owner')
  })
}

test('recording drops the branches that no longer exist', async ($, on) => {
  const w = world(on, existing({ 'feat/a': 'sha-a' }), { [KEY]: { gone: owned('gone'), still: owned('still') } })
  w.live.add('still')

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(Object.keys(w.ledger()).sort()).toEqual(['feat/a', 'still'])
})

test('the ledger is capped, the oldest claims dropped first', async ($, on) => {
  const full: Ledger = {}
  for (let i = 0; i < MAX_ENTRIES; i++) full[`b${i}`] = owned(`b${i}`, { createdAt: 10 + i })
  const w = world(on, existing({ 'feat/new': 'sha-n' }), { [KEY]: full })
  for (const branch of Object.keys(full)) w.live.add(branch)

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/new' })

  expect(Object.keys(w.ledger())).toHaveLength(MAX_ENTRIES)
  expect(w.ledger()['feat/new']?.owner).toBe('main')
  expect(w.ledger().b0).toBeUndefined()
  expect(w.ledger().b1).toBeDefined()
})

test('a claim another session wrote over is made again', async ($, on) => {
  let isRaced = false
  const w = world(on, existing({ 'feat/a': 'sha-a' }), {}, {
    afterSet: store => {
      if (isRaced) return
      isRaced = true
      // The other session read the ledger before this write and stores its own claim over it.
      store[KEY] = { theirs: owned('theirs') }
    },
  })
  w.live.add('theirs')

  await $.tool.call({ tool: 'Bash', command: 'git checkout -b feat/a' })

  expect(Object.keys(w.ledger()).sort()).toEqual(['feat/a', 'theirs'])
})

test('a prune keeps a claim another session made while it ran', async ($, on) => {
  let gets = 0
  const w = world(on, listing('main'), { [KEY]: LEDGER }, {
    beforeGet: store => {
      gets++
      if (gets === 2) store[KEY] = { ...(store[KEY] as Ledger), 'feat/new': owned('feat/new', { owner: 'peer' }) }
    },
  })

  await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(Object.keys(w.ledger()).sort()).toEqual(['feat/new', 'feat/old'])
})

test('a baseBranch git would read as an option is refused', { options: { baseBranch: '--output=/etc/x' } }, async ($, on) => {
  const w = world(on, listing('main'), { [KEY]: LEDGER })

  const ran = await $.command.run({ command: 'branch-owners', args: '', ...RUN })

  expect(ran.text).toContain('is not a branch name')
  expect(w.commands).toEqual([])
  expect(w.ledger()).toEqual(LEDGER)
})

test('a session still starts when the command cannot be registered', async ($, on) => {
  world(on, () => undefined, {}, { registerFails: true })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  expect(await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })).toEqual({ cwd: ROOT })
})
