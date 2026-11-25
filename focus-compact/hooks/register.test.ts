import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptSubmitInput, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import { LEGACY_STORE_KEY, NEW_LOOP, SESSION_KEY_PREFIX, STALE_MS } from './brief'
import type { Sessions } from './brief'

const NOW = 1_700_000_000_000
/** Claude's config folder in these tests; the default brief folder is `compact-briefs` in it. */
const CONFIG_DIR = '/Users/me/.claude-custom'
const DIR = `${CONFIG_DIR}/compact-briefs`
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const message = (role: SessionMessage['role'], text: string, handle?: string): SessionMessage =>
  handle === undefined ? { role, text, toolUses: [] } : { role, text, toolUses: [], handle }

const TRANSCRIPT = [message('user', 'build the DAG', 'h1'), message('assistant', 'working', 'h2'), message('user', 'and then?', 'h3')]
const COMPACTED = [message('user', 'SUMMARY: building the DAG; next the grader.'), message('user', 'and then?', 'h3')]

type Faults = { writeFails?: true; idFails?: true; listFails?: true; beforeSet?: () => void }

/** The engine beneath the plugin: compaction answers `answer`, the disk is a map. */
function world(
  on: On,
  answer: () => SessionCompactResult,
  faults: Faults = {},
  onDisk: readonly string[] = [],
  stored: Record<string, unknown> = {},
) {
  const seen: SessionCompactInput[] = []
  const files: Record<string, string> = Object.fromEntries(onDisk.map(path => [path, 'older']))
  /** A file's modification time, where a test sets one; else now. */
  const mtimes: Record<string, number> = {}
  /** Every host command the plugin ran. */
  const runs: string[][] = []
  const toasts: string[] = []

  const prompts: PromptSubmitInput[] = []
  const store: Record<string, unknown> = { ...stored }

  const clock = mock.clock(on, { now: NOW })
  on('session.compact', (_$, e) => {
    seen.push(e)

    return answer()
  })
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    faults.beforeSet?.()
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', (_$, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('session.id', () => {
    if (faults.idFails) throw new Error('no session id')

    return { value: 'session-1' }
  })
  // A custom Claude config folder, so the default brief folder is CONFIG_DIR/compact-briefs.
  on('env.get', ($, e) => ({ value: ({ CLAUDE_CONFIG_DIR: CONFIG_DIR, HOME: '/Users/me' } as Record<string, string | undefined>)[e.name] }))
  on('fs.exists', (_$, e) => ({ value: Object.hasOwn(files, e.path) }))
  on('fs.write', (_$, e) => {
    if (faults.writeFails) throw new Error('disk is full')
    files[e.path] = e.text

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  // The disk is the map above: a folder lists what lies directly under it. Nothing reaches the real one.
  on('fs.list', (_$, e) => {
    if (faults.listFails) throw new Error('EACCES')
    const prefix = `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files).filter(path => path.startsWith(prefix))) {
      const rest = path.slice(prefix.length)
      const cut = rest.indexOf('/')
      names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }

    return {
      value: [...names].map(([name, kind]) => ({
        name, kind, size: 1, mtimeMs: kind === 'file' ? (mtimes[`${prefix}${name}`] ?? NOW) : 0, isLink: false,
      })),
    }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    const from = e.offset ?? 0

    return { value: text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === '/bin/rm') for (const path of e.argv.slice(3)) delete files[path]

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('tool.call', () => ({ result: 'ran', text: 'ran' }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e)

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })

  /** Every session the store holds under a key of its own, by session id. */
  const sessions = () =>
    Object.fromEntries(
      Object.entries(store)
        .filter(([key]) => key.startsWith(SESSION_KEY_PREFIX))
        .map(([key, value]) => [key.slice(SESSION_KEY_PREFIX.length), value]),
    ) as Sessions

  return { seen, files, mtimes, runs, store, toasts, prompts, clock, sessions }
}

const shrunk = (tokensBefore?: number, tokensAfter?: number) => (): SessionCompactResult => ({
  messages: COMPACTED,
  ...(tokensBefore === undefined ? {} : { tokensBefore }),
  ...(tokensAfter === undefined ? {} : { tokensAfter }),
})

/**
 * The context a tool result carries back in a loop. The kit types `$.tool.call`
 * as a plugin's own call, which has no `agentId`; the event the engine raises does.
 */
const toolContext = async ($: Engine, agentId?: string) =>
  (await $.tool.call({ tool: 'Read', file_path: '/x', ...(agentId === undefined ? {} : { agentId }) } as { tool: 'Read'; file_path: string })).context

const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const compact = ($: Engine, over: Partial<SessionCompactInput> = {}) =>
  $.session.compact({ trigger: 'auto', messages: TRANSCRIPT, ...over })

test('an auto compaction with no instructions gets the standing focus', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))

  await compact($)

  expect(w.seen[0]?.instructions?.startsWith('Focus the summary on: (1) what we are building and why;')).toBe(true)
  expect(w.seen[0]?.instructions).toContain('(5) traps and dead ends already ruled out.')
  expect(w.seen[0]?.trigger).toBe('auto')
  expect(w.seen[0]?.messages).toEqual(TRANSCRIPT)
})

test('a manual compaction keeps the user text verbatim after the focus', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))

  await compact($, { trigger: 'manual', instructions: 'keep the seed210 freeze rules' })
  const sent = w.seen[0]?.instructions ?? ''

  expect(sent.startsWith('Focus the summary on:')).toBe(true)
  expect(sent.endsWith('keep the seed210 freeze rules')).toBe(true)
})

test('the focus option replaces the default', { options: { focus: 'ONLY THE PLAN' } }, async ($, on) => {
  const w = world(on, shrunk())

  await compact($)

  expect(w.seen[0]?.instructions).toBe('ONLY THE PLAN')
})

test('a precompute gets the focus but writes and counts nothing', async ($, on) => {
  const w = world(on, shrunk(100_000, 90_000))

  const done = await compact($, { trigger: 'precompute' })
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.seen[0]?.instructions).toContain('Focus the summary on:')
  expect(done.messages).toEqual(COMPACTED)
  expect(w.files).toEqual({})
  expect(w.toasts).toEqual([])
  expect(await toolContext($)).toBeUndefined()
  expect(status.text).toBe('no compaction yet this session.')
})

test('a skipped compaction writes and counts nothing and is handed back', async ($, on) => {
  const w = world(on, () => ({ skip: 'a PreCompact hook blocked it' }))

  const done = await compact($, { trigger: 'manual' })
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(done).toEqual({ skip: 'a PreCompact hook blocked it' })
  expect(w.files).toEqual({})
  expect(status.text).toBe('no compaction yet this session.')
})

test('a compaction leaves a brief with a header and the summary, and its result is unchanged', async ($, on) => {
  const w = world(on, shrunk(200_000, 50_000))

  const done = await compact($)
  const path = `${DIR}/session-1/main-1.md`

  expect(done).toEqual({ messages: COMPACTED, tokensBefore: 200_000, tokensAfter: 50_000 })
  expect(Object.keys(w.files)).toEqual([path])
  expect(w.files[path]).toBe(
    [
      '# Compaction brief: main, compaction 1',
      '',
      '- time: 2023-11-14T22:13:20.000Z',
      '- session: session-1',
      '- conversation: main',
      '- trigger: auto',
      '- tokens: 200000 -> 50000 (25% kept)',
      '- compaction number: 1',
      '',
      '---',
      '',
      'SUMMARY: building the DAG; next the grader.',
      '',
    ].join('\n'),
  )
})

test('briefs are numbered per conversation and never overwrite one on disk', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), {}, [`${DIR}/session-1/main-1.md`, `${DIR}/session-1/main-2.md`])

  await compact($)
  await compact($)

  expect(w.files[`${DIR}/session-1/main-1.md`]).toBe('older')
  expect(w.files[`${DIR}/session-1/main-2.md`]).toBe('older')
  expect(w.files[`${DIR}/session-1/main-3.md`]).toContain('compaction number: 1')
  expect(w.files[`${DIR}/session-1/main-4.md`]).toContain('compaction number: 2')
})

test('the briefDir option moves the briefs', { options: { briefDir: '/data/briefs/' } }, async ($, on) => {
  const w = world(on, shrunk())

  await compact($)

  expect(Object.keys(w.files)).toEqual(['/data/briefs/session-1/main-1.md'])
  expect(w.files['/data/briefs/session-1/main-1.md']).toContain('- tokens: not recorded')
})

test('a compaction that kept every message writes no brief but is counted', async ($, on) => {
  const w = world(on, () => ({ messages: TRANSCRIPT.slice(1), tokensBefore: 10, tokensAfter: 5 }))

  await compact($)
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.files).toEqual({})
  expect(status.text).toBe('main: 1 compaction, last 50% kept, brief none')
})

test('the third compaction asks a subagent for a handoff, once, on its next tool result', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))
  const sub = { agentId: 'agent-1' }

  await compact($, sub)
  await compact($, sub)
  expect(w.toasts).toEqual([])
  expect(await toolContext($, 'agent-1')).toBeUndefined()

  await compact($, sub)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('compacted 3 times')
  // Another loop's tool result does not take its note.
  expect(await toolContext($, 'agent-9')).toBeUndefined()
  expect(await toolContext($)).toBeUndefined()
  const context = await toolContext($, 'agent-1')
  expect(context).toHaveLength(1)
  expect(context?.[0]).toContain(`${DIR}/session-1/agent-1-3.md`)
  expect(context?.[0]).toContain('at most 60 lines')
  expect(await toolContext($, 'agent-1')).toBeUndefined()

  // The fourth shrinks properly: it re-arms and says nothing; the fifth asks again.
  await compact($, sub)
  expect(w.toasts).toHaveLength(1)
  expect(await toolContext($, 'agent-1')).toBeUndefined()
  await compact($, sub)
  expect(w.toasts).toHaveLength(2)
  expect(await toolContext($, 'agent-1')).toHaveLength(1)
})

test('main compacts as often as it needs and is never asked for a handoff', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))

  for (let n = 0; n < 6; n++) await compact($)
  await submit($, 'carry on')
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.toasts).toEqual([])
  expect(await toolContext($)).toBeUndefined()
  expect(w.prompts[0]?.context).toBeUndefined()
  expect(status.text).toBe(`main: 6 compactions, last 20% kept, brief ${DIR}/session-1/main-6.md`)
})

test('a poor shrink of main toasts once and gives main no note', async ($, on) => {
  const w = world(on, shrunk(100_000, 70_000))

  await compact($)
  await compact($)
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('kept 70% of the tokens')
  expect(w.toasts[0]).toContain('main keeps compacting in place')
  expect(w.toasts[0]).not.toContain('/handoff')
  expect(await toolContext($)).toBeUndefined()
  await submit($, 'carry on')
  expect(w.prompts[0]?.context).toBeUndefined()
  expect(status.text).toBe(`main: 2 compactions, last 70% kept, poor shrink, brief ${DIR}/session-1/main-2.md`)
})

test('the limits are options', { options: { handoffAfter: 1, minShrinkRatio: 0.9 } }, async ($, on) => {
  const w = world(on, shrunk(100_000, 80_000))

  await compact($, { agentId: 'agent-1' })

  expect(w.toasts[0]).toContain('compacted 1 time (limit 1)')
})

test('absent token counts never ask on ratio', { options: { handoffAfter: 10 } }, async ($, on) => {
  const w = world(on, shrunk())

  await compact($)
  await compact($)
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.toasts).toEqual([])
  expect(await toolContext($)).toBeUndefined()
  expect(status.text).toBe(`main: 2 compactions, last not recorded, brief ${DIR}/session-1/main-2.md`)
})

test('when the brief cannot be written the compaction stands and is still counted', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), { writeFails: true })

  const done = await compact($)
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(done).toEqual({ messages: COMPACTED, tokensBefore: 100_000, tokensAfter: 20_000 })
  expect(w.files).toEqual({})
  expect(status.text).toBe('main: 1 compaction, last 20% kept, brief none')
})

test('when the session cannot be read the compaction and later tool results stand, and nothing is stored', async ($, on) => {
  const w = world(on, shrunk(100_000, 95_000), { idFails: true })

  const done = await compact($)
  const ran = await $.tool.call({ tool: 'Read', file_path: '/x' })

  expect(done).toEqual({ messages: COMPACTED, tokensBefore: 100_000, tokensAfter: 95_000 })
  expect(ran.text).toBe('ran')
  expect(ran.context).toBeUndefined()
  expect(w.files).toEqual({})
  expect(w.sessions()).toEqual({})
})

test('a small conversation with a bad ratio does not ask, but is counted', async ($, on) => {
  const w = world(on, shrunk(3_487, 4_108))

  await compact($, { trigger: 'manual' })
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.toasts).toEqual([])
  expect(await toolContext($)).toBeUndefined()
  expect(status.text).toBe(`main: 1 compaction, last 118% kept, brief ${DIR}/session-1/main-1.md`)
})

test('the smallest judged conversation is an option', { options: { minTokensForRatio: 1_000 } }, async ($, on) => {
  const w = world(on, shrunk(3_487, 4_108))

  await compact($)

  expect(w.toasts[0]).toContain('kept 118% of the tokens')
})

const RESUMED: Sessions = {
  'session-1': {
    updatedAt: NOW - 60_000,
    loops: {
      main: { count: 2, lastRatio: 0.2, lastBrief: `${DIR}/session-1/main-2.md`, hasEscalated: false, pendingNote: null },
    },
  },
  'session-0': { updatedAt: NOW - 60_000, loops: { main: { ...NEW_LOOP, count: 9 } } },
}

test('after a restart the count continues from the store', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), {}, [], { [LEGACY_STORE_KEY]: RESUMED })

  const before = await $.command.run({ command: 'focus-compact', args: '', ...RUN })
  await compact($)

  expect(before.text).toBe(`main: 2 compactions, last 20% kept, brief ${DIR}/session-1/main-2.md`)
  expect(w.toasts).toEqual([])
  expect(w.files[`${DIR}/session-1/main-3.md`]).toContain('compaction number: 3')
  expect(w.sessions()['session-1']?.loops.main?.count).toBe(3)
  expect(w.sessions()['session-1']?.updatedAt).toBe(NOW)
  // Another session's count is neither read nor touched, and the old layout stays while a session in it is fresh.
  expect(w.store[LEGACY_STORE_KEY]).toEqual(RESUMED)
  expect(w.sessions()['session-0']).toBeUndefined()
})

test('a subagent note still waiting at a restart is given on its next tool result, once', async ($, on) => {
  const waiting: Sessions = {
    'session-1': { updatedAt: NOW - 60_000, loops: { 'agent-1': { ...NEW_LOOP, count: 3, hasEscalated: true, pendingNote: 'NOTE FROM BEFORE' } } },
  }
  const w = world(on, shrunk(), {}, [], { [LEGACY_STORE_KEY]: waiting })

  expect(await toolContext($)).toBeUndefined()
  expect(await toolContext($, 'agent-1')).toEqual(['NOTE FROM BEFORE'])
  expect(await toolContext($, 'agent-1')).toBeUndefined()
  expect(w.sessions()['session-1']?.loops['agent-1']?.pendingNote).toBe(null)
  expect(w.sessions()['session-1']?.loops['agent-1']?.count).toBe(3)
})

test('a main note stored before this version is never given', async ($, on) => {
  const waiting: Sessions = {
    'session-1': { updatedAt: NOW - 60_000, loops: { main: { ...NEW_LOOP, count: 3, hasEscalated: true, pendingNote: 'NOTE FROM BEFORE' } } },
  }
  const w = world(on, shrunk(), {}, [], { [LEGACY_STORE_KEY]: waiting })

  expect(await toolContext($)).toBeUndefined()
  await submit($, 'carry on')
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('a write drops sessions not updated in 14 days', async ($, on) => {
  const old: Sessions = {
    stale: { updatedAt: NOW - STALE_MS - 1, loops: { main: { ...NEW_LOOP, count: 1 } } },
    recent: { updatedAt: NOW - STALE_MS + 1_000, loops: { main: { ...NEW_LOOP, count: 1 } } },
  }
  const w = world(on, shrunk(100_000, 20_000), {}, [], {
    [`${SESSION_KEY_PREFIX}stale`]: old.stale,
    [`${SESSION_KEY_PREFIX}recent`]: old.recent,
    [`${SESSION_KEY_PREFIX}garbage`]: 'not a session',
    unrelated: 1,
  })

  await compact($)

  expect(Object.keys(w.sessions()).sort()).toEqual(['recent', 'session-1'])
  expect(w.store.unrelated).toBe(1)
})

test('reading alone writes nothing to the store', async ($, on) => {
  const w = world(on, shrunk(), {}, [], { [LEGACY_STORE_KEY]: RESUMED })

  await toolContext($)
  await submit($, 'hello')
  await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(w.store).toEqual({ [LEGACY_STORE_KEY]: RESUMED })
})

test('a subagent is counted apart from main and is the one asked', async ($, on) => {
  const w = world(on, shrunk(100_000, 70_000))

  await compact($, { agentId: 'agent-1' })
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })

  expect(Object.keys(w.files)).toEqual([`${DIR}/session-1/agent-1-1.md`])
  expect(status.text).toBe(`agent-1: 1 compaction, last 70% kept, handoff asked, brief ${DIR}/session-1/agent-1-1.md`)
  expect(w.toasts[0]).toContain('subagent agent-1 was told to hand off')
  expect(await toolContext($)).toBeUndefined()
  await submit($, 'a prompt of main does not take a subagent note')
  expect(w.prompts[0]?.context).toBeUndefined()
  expect((await toolContext($, 'agent-1'))?.[0]).toContain('at most 60 lines')
  expect(await toolContext($, 'agent-1')).toBeUndefined()
})

test('the command is registered when the session starts', async ($, on) => {
  world(on, shrunk())
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['focus-compact'])
})

const DAY = 24 * 60 * 60 * 1000

test('a conversation keeps its newest briefs only', { options: { keepBriefs: 2 } }, async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), {}, [`${DIR}/session-1/agent-1-1.md`, `${DIR}/session-1/notes.md`])

  for (let n = 0; n < 4; n++) await compact($)

  expect(Object.keys(w.files).sort()).toEqual([
    `${DIR}/session-1/agent-1-1.md`,
    `${DIR}/session-1/main-3.md`,
    `${DIR}/session-1/main-4.md`,
    `${DIR}/session-1/notes.md`,
  ])
  // The status still names the last brief, which is kept.
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })
  expect(status.text).toContain(`brief ${DIR}/session-1/main-4.md`)
})

test('keepBriefs 0 keeps every brief', { options: { keepBriefs: 0 } }, async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))
  for (let n = 0; n < 35; n++) await compact($)
  expect(Object.keys(w.files)).toHaveLength(35)
})

test('the default keeps 30 briefs per conversation', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000))
  for (let n = 0; n < 31; n++) await compact($)
  expect(Object.keys(w.files)).toHaveLength(30)
  expect(w.files[`${DIR}/session-1/main-1.md`]).toBeUndefined()
})

/** What a brief this mod wrote starts with, as `formatBrief` writes it. */
const BRIEF = '# Compaction brief: main, compaction 1\n\n- time: 2023-11-14T22:13:20.000Z\n'
const OLD_SESSION = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405162'
const MIXED_SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** Gives each path the content of a real brief. */
const asBriefs = (files: Record<string, string>, paths: readonly string[]) => {
  for (const path of paths) files[path] = BRIEF
}

test('other sessions\' briefs older than 30 days are removed once per load, then their emptied folders', async ($, on) => {
  const old = `${DIR}/${OLD_SESSION}`
  const mixed = `${DIR}/${MIXED_SESSION}`
  const w = world(on, shrunk(100_000, 20_000), {}, [
    `${old}/main-1.md`, `${old}/agent-2-1.md`, `${mixed}/main-1.md`, `${mixed}/main-2.md`, `${mixed}/kept-by-hand.txt`,
  ])
  asBriefs(w.files, [`${old}/main-1.md`, `${old}/agent-2-1.md`, `${mixed}/main-1.md`, `${mixed}/main-2.md`])
  w.mtimes[`${old}/main-1.md`] = NOW - 31 * DAY
  w.mtimes[`${old}/agent-2-1.md`] = NOW - 30 * DAY - 1
  w.mtimes[`${mixed}/main-1.md`] = NOW - 40 * DAY
  w.mtimes[`${mixed}/main-2.md`] = NOW - 30 * DAY
  w.mtimes[`${mixed}/kept-by-hand.txt`] = NOW - 400 * DAY

  await compact($)
  await compact($)

  expect(Object.keys(w.files).sort()).toEqual([
    `${mixed}/kept-by-hand.txt`, `${mixed}/main-2.md`, `${DIR}/session-1/main-1.md`, `${DIR}/session-1/main-2.md`,
  ].sort())
  expect(w.runs.filter(argv => argv[0] === '/bin/rmdir')).toEqual([['/bin/rmdir', old]])
})

test('briefMaxAgeDays 0 removes nothing for age', { options: { briefMaxAgeDays: 0 } }, async ($, on) => {
  const path = `${DIR}/${OLD_SESSION}/main-1.md`
  const w = world(on, shrunk(100_000, 20_000), {}, [path])
  asBriefs(w.files, [path])
  w.mtimes[path] = NOW - 400 * DAY
  await compact($)
  expect(w.files[path]).toBe(BRIEF)
})

test('age pruning never descends into a folder not named like a session id', async ($, on) => {
  const notes = `${DIR}/book`
  const w = world(on, shrunk(100_000, 20_000), {}, [`${notes}/chapter-3.md`, `${notes}/main-1.md`])
  asBriefs(w.files, [`${notes}/main-1.md`])
  w.mtimes[`${notes}/chapter-3.md`] = NOW - 400 * DAY
  w.mtimes[`${notes}/main-1.md`] = NOW - 400 * DAY
  await compact($)
  expect(w.files[`${notes}/chapter-3.md`]).toBe('older')
  expect(w.files[`${notes}/main-1.md`]).toBe(BRIEF)
  expect(w.runs.filter(argv => argv[0] === '/bin/rm' || argv[0] === '/bin/rmdir')).toEqual([])
})

test('an old file named like a brief but not starting with the brief header is left, and so is its folder', async ($, on) => {
  const folder = `${DIR}/${OLD_SESSION}`
  const w = world(on, shrunk(100_000, 20_000), {}, [`${folder}/chapter-3.md`, `${folder}/main-1.md`])
  asBriefs(w.files, [`${folder}/main-1.md`])
  w.files[`${folder}/chapter-3.md`] = '# Chapter 3\n\nIt was a dark and stormy night.\n'
  w.mtimes[`${folder}/chapter-3.md`] = NOW - 400 * DAY
  w.mtimes[`${folder}/main-1.md`] = NOW - 400 * DAY
  await compact($)
  expect(w.files[`${folder}/chapter-3.md`]).toContain('stormy night')
  expect(w.files[`${folder}/main-1.md`]).toBeUndefined()
  expect(w.runs.filter(argv => argv[0] === '/bin/rmdir')).toEqual([])
})

test('a briefDir pointed at a folder of other files removes none of them', { options: { briefDir: '/Users/someone/Documents' } }, async ($, on) => {
  const docs = '/Users/someone/Documents'
  const kept = [`${docs}/novel/chapter-3.md`, `${docs}/${OLD_SESSION}/draft-2.md`]
  const w = world(on, shrunk(100_000, 20_000), {}, kept)
  for (const path of kept) w.mtimes[path] = NOW - 400 * DAY
  await compact($)
  for (const path of kept) expect(w.files[path]).toBe('older')
  expect(w.files[`${docs}/session-1/main-1.md`]).toContain('# Compaction brief: main')
})

test('a surplus brief of the conversation is removed only when it starts with the brief header', { options: { keepBriefs: 1 } }, async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), {}, [`${DIR}/session-1/main-1.md`])
  // main-1.md is a file someone else left: the compactions write main-2 and main-3.
  await compact($)
  await compact($)
  expect(w.files[`${DIR}/session-1/main-1.md`]).toBe('older')
  expect(w.files[`${DIR}/session-1/main-2.md`]).toBeUndefined()
  expect(w.files[`${DIR}/session-1/main-3.md`]).toContain('# Compaction brief: main')
})

test('a brief folder that cannot be listed costs the compaction nothing', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), { listFails: true })
  const done = await compact($)
  const status = await $.command.run({ command: 'focus-compact', args: '', ...RUN })
  expect(done.messages).toEqual(COMPACTED)
  expect(status.text).toBe(`main: 1 compaction, last 20% kept, brief ${DIR}/session-1/main-1.md`)
  expect(w.runs).toEqual([])
})

test('showToasts off silences the toast; the subagent is still asked', { options: { showToasts: false } }, async ($, on) => {
  const w = world(on, shrunk(100_000, 70_000))
  await compact($, { agentId: 'agent-1' })
  expect(w.toasts).toEqual([])
  expect((await toolContext($, 'agent-1'))?.[0]).toContain('at most 60 lines')
})

test('a garbage value under the session\'s key reads as no compaction yet, and is replaced by the next', async ($, on) => {
  const w = world(on, shrunk(100_000, 20_000), {}, [], { [`${SESSION_KEY_PREFIX}session-1`]: { updatedAt: 'x', loops: 7 } })
  const before = await $.command.run({ command: 'focus-compact', args: '', ...RUN })
  await compact($)
  expect(before.text).toBe('no compaction yet this session.')
  expect(w.sessions()['session-1']?.loops.main?.count).toBe(1)
})

test('the 0.1.0 layout is removed once every session in it is stale, and kept while one is fresh', async ($, on) => {
  const spent: Sessions = { gone: { updatedAt: NOW - STALE_MS - 1, loops: {} } }
  const w = world(on, shrunk(100_000, 20_000), {}, [], { [LEGACY_STORE_KEY]: spent })
  await compact($)
  expect(w.store[LEGACY_STORE_KEY]).toBeUndefined()
})

test('a write by another session meanwhile is never undone', async ($, on) => {
  const theirs = { updatedAt: NOW, loops: { main: { ...NEW_LOOP, count: 7 } } }
  const box: { store?: Record<string, unknown> } = {}
  // Another session records its compaction after this one read the store and before it writes.
  const w = world(on, shrunk(100_000, 20_000), {
    beforeSet: () => {
      if (box.store !== undefined) box.store[`${SESSION_KEY_PREFIX}session-2`] = theirs
    },
  })
  box.store = w.store
  await compact($)
  expect(w.sessions()['session-2']).toEqual(theirs)
  expect(w.sessions()['session-1']?.loops.main?.count).toBe(1)
})
