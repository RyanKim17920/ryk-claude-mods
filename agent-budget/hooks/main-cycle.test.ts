import type { On, PromptSubmitInput, SessionCompactInput, SessionCompactResult, SessionContextUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { COMPACT_DELAY_MS, HANDOFF_MARKER, MARKER } from './logic'

const MESSAGES = [{ role: 'user' as const, text: 'SUMMARY', toolUses: [] }]
/** Claude's config folder in these tests; the default handoff folder is `handoffs` in it. */
const CONFIG_DIR = '/Users/me/.claude-custom'
const PATH = `${CONFIG_DIR}/handoffs/session-1/main.md`

type World = {
  clock: MockClock
  toasts: string[]
  compactions: SessionCompactInput[]
  prompts: PromptSubmitInput[]
  /** Path to modification time. */
  files: Record<string, number>
  /** Path to text, for a file a test gives content; any other file reads as empty. */
  texts: Record<string, string>
  /** What the next compaction answers; a string throws it. */
  answer: () => SessionCompactResult | string
  size: number
  /** Folder path to the names it lists, each a folder. */
  folders: Record<string, string[]>
  /** Every host command the plugin ran. */
  runs: string[][]
  /** True while the resume prompt fails to send. */
  isSubmitBroken: boolean
  /** True while listing a folder fails. */
  isListBroken: boolean
  /** Main's window as `$.session.usage` reports it; null makes the call fail. */
  context: SessionContextUsage | null
  /** How many calls asked for the breakdown. */
  breakdowns: number
}

/** The window as the engine reports it: the model's limit, and where auto-compaction runs. */
const windowOf = (window: number, autoCompactThreshold: number): SessionContextUsage =>
  ({ window, breakdown: { autoCompactThreshold, isAutoCompactEnabled: true, rawMaxTokens: window } }) as SessionContextUsage

// The engine beneath the plugin, for main: its responses' size, the disk, compaction, prompts and turn ends.
function world(on: On): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
    toasts: [],
    compactions: [],
    prompts: [],
    files: {},
    texts: {},
    answer: () => ({ messages: MESSAGES, tokensBefore: 430_000, tokensAfter: 40_000 }),
    size: 0,
    folders: {},
    runs: [],
    isSubmitBroken: false,
    isListBroken: false,
    // A 1M window, as the tests before window sizes were known assumed: no default is capped.
    context: windowOf(1_000_000, 967_000),
    breakdowns: 0,
  }
  on('session.usage', ($, e) => {
    if (w.context === null) {
      throw new Error('no usage')
    }
    if (e.breakdown !== undefined) {
      w.breakdowns++
    }
    const { breakdown, ...plain } = w.context

    return { value: { startedAt: 0, context: e.breakdown === undefined ? plain : { ...plain, breakdown }, rateLimits: [] } }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: w.size - 1000, cache_creation_input_tokens: 0 },
    }
  })
  on('tool.call', ($, e) =>
    e.tool === 'Bash' && e.command === 'refused' ? { deny: 'not here' } : { result: 'done', text: 'done' },
  )
  on('session.id', () => ({ value: 'session-1' }))
  // A custom Claude config folder, so the default handoff folder is CONFIG_DIR/handoffs.
  on('env.get', ($, e) => ({ value: ({ CLAUDE_CONFIG_DIR: CONFIG_DIR, HOME: '/Users/me' } as Record<string, string | undefined>)[e.name] }))
  on('fs.stat', ($, e) => {
    const mtimeMs = w.files[e.path]
    if (mtimeMs === undefined) {
      throw new Error('ENOENT')
    }

    return { value: { kind: 'file', size: 10, mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (w.files[e.path] === undefined) {
      throw new Error('ENOENT')
    }
    const text = w.texts[e.path] ?? ''
    const from = e.offset ?? 0

    return { value: text.slice(from, e.length === undefined ? undefined : from + e.length) }
  })
  on('session.compact', ($, e) => {
    w.compactions.push(e)
    const answer = w.answer()
    if (typeof answer === 'string') {
      throw new Error(answer)
    }

    return answer
  })
  on('prompt.submit', ($, e) => {
    if (w.isSubmitBroken) {
      throw new Error('cannot send')
    }
    w.prompts.push(e)

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // The disk is the maps above: nothing here reaches the real one.
  on('fs.list', ($, e) => {
    if (w.isListBroken) {
      throw new Error('EACCES')
    }

    return {
    value: (w.folders[e.path ?? ''] ?? []).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return w
}

async function step($: Engine, w: World, size: number) {
  w.size = size
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 3 })
  let piece = await stream.next()
  while (piece.done !== true) {
    piece = await stream.next()
  }
}

const toolContext = async ($: Engine, command = 'ls') => (await $.tool.call({ tool: 'Bash', command })).context

const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** Main's turn ends, and the time the plugin waits before compacting passes. */
async function endTurn($: Engine, w: World, reason: 'answer' | 'aborted' = 'answer') {
  await $.turn.complete({ answer: 'Handoff written.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })
  await w.clock.advance(COMPACT_DELAY_MS)
}

/** The model writes its handoff file now. */
const writeHandoff = (w: World) => {
  w.files[PATH] = w.clock.now()
}

test('past the threshold main writes its handoff, is compacted in place once, and is told to read it first', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)

  const context = await toolContext($)
  expect(context).toHaveLength(1)
  const note = context?.[0] ?? ''
  expect(note.startsWith(MARKER)).toBe(true)
  expect(note).toContain('about 430k tokens, past the 400k handoff threshold')
  expect(note).toContain(`write your handoff to ${PATH}, replacing what is there`)
  expect(note).toContain('open branches and running agents')
  expect(note).toContain('end your turn with one line')
  expect(note).toContain('compacted in place')
  expect(note).toContain('Do not start a new session or ask anyone to hand off')
  expect(note).not.toMatch(/rotat|spawn|replacement|lead/i)
  // Given once.
  expect(await toolContext($)).toBeUndefined()
  expect(w.compactions).toHaveLength(0)

  writeHandoff(w)
  await endTurn($, w)

  expect(w.compactions).toHaveLength(1)
  expect(w.compactions[0]?.instructions).toContain(`Start the summary with this line, verbatim: "Read ${PATH} first`)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.text).toBe(
    `${MARKER} Your context was just compacted. Read ${PATH} first: it is your handoff from before the compaction. Then continue the work it lists; if it says you were waiting on the user, say so in one line and stop.`,
  )

  // The resumed turn ends: nothing more is compacted, and the note is not given again.
  await step($, w, 45_000)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
  expect(await toolContext($)).toBeUndefined()
})

test('the cycle repeats as often as main fills up, over the one handoff file, and never asks for a new session', async ($, on) => {
  const w = world(on)
  for (let cycle = 1; cycle <= 6; cycle++) {
    await step($, w, 150_000)
    await step($, w, 405_000)
    const note = (await toolContext($))?.[0] ?? ''
    expect(note).toContain(PATH)
    writeHandoff(w)
    await endTurn($, w)
    expect(w.compactions).toHaveLength(cycle)
    expect(w.prompts.at(-1)?.text).toContain(`Read ${PATH} first`)
  }
  expect(w.prompts).toHaveLength(6)
  expect(w.toasts.filter(toast => toast.includes('compacting in place'))).toHaveLength(6)
})

test('a compaction that shrinks less than half still re-arms the next cycle', async ($, on) => {
  const w = world(on)
  await step($, w, 410_000)
  await toolContext($)
  await endTurn($, w)
  await step($, w, 260_000)
  await step($, w, 401_000)
  expect((await toolContext($))?.[0]).toContain('about 401k tokens')
})

test('with no handoff written the compaction still runs once, and main is told so', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  await toolContext($)
  await endTurn($, w)

  expect(w.compactions).toHaveLength(1)
  expect(w.compactions[0]?.instructions).toBeUndefined()
  expect(w.prompts[0]?.text).toBe(`${MARKER} Your context was just compacted and no handoff file was written to ${PATH}. Continue from the summary.`)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
})

test('a handoff left by an earlier cycle is pointed at as possibly out of date', async ($, on) => {
  const w = world(on)
  writeHandoff(w)
  await w.clock.advance(60_000)
  await step($, w, 430_000)
  await toolContext($)
  await endTurn($, w)

  expect(w.compactions[0]?.instructions).toContain('at an earlier compaction; it may be out of date')
  expect(w.prompts[0]?.text).toContain('may be out of date')
})

test('nothing compacts before the note was given, or when the turn was interrupted', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(0)

  await toolContext($)
  await endTurn($, w, 'aborted')
  expect(w.compactions).toHaveLength(0)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
})

test('a turn that runs no tool reads the note with its prompt, never with a slash command', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  await submit($, '/agent-budget')
  await submit($, 'carry on')

  expect(w.prompts[0]?.context).toBeUndefined()
  expect(w.prompts[1]?.text).toBe('carry on')
  expect(w.prompts[1]?.context?.[0]).toContain(`write your handoff to ${PATH}`)
  expect(await toolContext($)).toBeUndefined()
})

test('a denied tool call does not take the note', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  expect(await toolContext($, 'refused')).toBeUndefined()
  expect(await toolContext($)).toHaveLength(1)
})

test('a compaction that does not stand is tried at the next turn ends, then given up without a loop', async ($, on) => {
  const w = world(on)
  w.answer = () => ({ skip: 'a PreCompact hook blocked it' })
  await step($, w, 430_000)
  await toolContext($)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)

  w.answer = () => 'a turn is running'
  await endTurn($, w)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(3)
  expect(w.toasts.at(-1)).toContain('main could not be compacted')

  await endTurn($, w)
  expect(w.compactions).toHaveLength(3)
  expect(w.prompts).toHaveLength(0)

  // 50k more growth asks again, and that cycle compacts.
  w.answer = () => ({ messages: MESSAGES, tokensBefore: 480_000, tokensAfter: 40_000 })
  await step($, w, 480_000)
  expect((await toolContext($))?.[0]).toContain('about 480k tokens')
  await endTurn($, w)
  expect(w.compactions).toHaveLength(4)
  expect(w.prompts).toHaveLength(1)
})

test('an automatic compaction while the handoff is asked for ends the cycle: no second compaction', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  await toolContext($)
  writeHandoff(w)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions[0]?.instructions).toContain(`Read ${PATH} first`)

  // The note rides the next tool result, once; the turn end compacts nothing more.
  expect((await toolContext($))?.[0]).toContain(`Read ${PATH} first`)
  expect(await toolContext($)).toBeUndefined()
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
  expect(w.prompts).toHaveLength(0)
})

test('a compaction below the threshold with no handoff is left alone, and the user\'s instructions are kept first', async ($, on) => {
  const w = world(on)
  await step($, w, 120_000)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'keep the plan' })
  expect(w.compactions[0]?.instructions).toBe('keep the plan')
  expect(await toolContext($)).toBeUndefined()

  writeHandoff(w)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'keep the plan' })
  expect(w.compactions[1]?.instructions?.startsWith('keep the plan\n\nThe agent wrote its handoff')).toBe(true)
})

test('a subagent\'s compaction and a precompute are left as they are', async ($, on) => {
  const w = world(on)
  writeHandoff(w)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'a1' })
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  expect(w.compactions.map(e => e.instructions)).toEqual([undefined, undefined])
  expect(await toolContext($)).toBeUndefined()
})

test('the handoffDir option moves the file', { options: { handoffDir: '/data/handoffs/' } }, async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  expect((await toolContext($))?.[0]).toContain('write your handoff to /data/handoffs/session-1/main.md')
})

test('includeMain off leaves main\'s turns and compactions alone', { options: { includeMain: false } }, async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  writeHandoff(w)
  expect(await toolContext($)).toBeUndefined()
  await endTurn($, w)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.compactions).toHaveLength(1)
  expect(w.compactions[0]?.instructions).toBeUndefined()
})

const DAY = 24 * 60 * 60_000
const HANDOFFS = `${CONFIG_DIR}/handoffs`
// Other sessions' folders, named as the engine names sessions.
const OLD_1 = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405161'
const OLD_2 = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405162'
const RECENT = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405163'
const NO_FILE = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405164'
const UNMARKED = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f40516a'
const OTHER = '0f3c2a1e-7b6d-4c5e-9a8b-1d2e3f405169'

test('a resume prompt that fails to send after the compaction stood never compacts main a second time', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  await toolContext($)
  writeHandoff(w)
  w.isSubmitBroken = true
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)

  w.isSubmitBroken = false
  await endTurn($, w)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
  expect(w.toasts.filter(toast => toast.includes('could not be compacted'))).toHaveLength(0)
})

test('a second turn end while this load\'s compaction waits to run claims nothing more', async ($, on) => {
  // (A cycle left at compacting by an earlier load, whose timer died in a hot reload, is
  // reclaimed by the next turn end; the kit cannot unload a module, so this pins the guard.)
  const w = world(on)
  await step($, w, 430_000)
  await toolContext($)
  const end = () => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await end()
  await end()
  await w.clock.advance(COMPACT_DELAY_MS)
  expect(w.compactions).toHaveLength(1)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
})

test('after a compaction, other sessions\' handoffs older than 30 days are removed, once, and nothing else', async ($, on) => {
  const w = world(on)
  const now = w.clock.now()
  w.folders[HANDOFFS] = [OLD_1, OLD_2, RECENT, 'session-1', NO_FILE]
  w.files[`${HANDOFFS}/${OLD_1}/main.md`] = now - 31 * DAY
  w.files[`${HANDOFFS}/${OLD_2}/main.md`] = now - 30 * DAY - 1
  w.files[`${HANDOFFS}/${RECENT}/main.md`] = now - 30 * DAY
  // This session's own handoff is never touched, however old.
  w.files[`${HANDOFFS}/session-1/main.md`] = now - 90 * DAY

  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs).toEqual([
    ['/bin/rm', '-f', '--', `${HANDOFFS}/${OLD_1}/main.md`, `${HANDOFFS}/${OLD_2}/main.md`],
    ['/bin/rmdir', `${HANDOFFS}/${OLD_1}`, `${HANDOFFS}/${OLD_2}`],
  ])

  // Once per load: a second compaction looks no further.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs).toHaveLength(2)
})

test('handoffMaxAgeDays 0 keeps every handoff', { options: { handoffMaxAgeDays: 0 } }, async ($, on) => {
  const w = world(on)
  w.folders[HANDOFFS] = [OLD_1]
  w.files[`${HANDOFFS}/${OLD_1}/main.md`] = w.clock.now() - 400 * DAY
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs).toEqual([])
})

test('a garbage handoffMaxAgeDays falls back to 30 days', { options: { handoffMaxAgeDays: -3 } }, async ($, on) => {
  const w = world(on)
  w.folders[HANDOFFS] = [OLD_1, RECENT]
  w.files[`${HANDOFFS}/${OLD_1}/main.md`] = w.clock.now() - 31 * DAY
  w.files[`${HANDOFFS}/${RECENT}/main.md`] = w.clock.now() - 29 * DAY
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs[0]).toEqual(['/bin/rm', '-f', '--', `${HANDOFFS}/${OLD_1}/main.md`])
})

test('a handoff folder that cannot be listed costs the compaction nothing', async ($, on) => {
  const w = world(on)
  w.isListBroken = true
  const done = await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(done.skip).toBeUndefined()
  expect(w.compactions).toHaveLength(1)
  expect(w.runs).toEqual([])
})

test('showToasts off silences the toasts and nothing else', { options: { showToasts: false } }, async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  expect((await toolContext($))?.[0]).toContain('about 430k tokens')
  writeHandoff(w)
  await endTurn($, w)
  expect(w.compactions).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

const DOCS = '/Users/someone/Documents'

test('pruning never looks in a folder not named like a session id', async ($, on) => {
  const w = world(on)
  w.folders[HANDOFFS] = ['notes', 'old-session']
  w.files[`${HANDOFFS}/notes/main.md`] = w.clock.now() - 400 * DAY
  w.files[`${HANDOFFS}/old-session/main.md`] = w.clock.now() - 400 * DAY
  w.texts[`${HANDOFFS}/old-session/main.md`] = `${HANDOFF_MARKER}\n# Handoff`
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs).toEqual([])
})

test('outside the default folder only a main.md starting with the marker is removed', { options: { handoffDir: DOCS } }, async ($, on) => {
  const w = world(on)
  const marked = `${DOCS}/${OTHER}/main.md`
  const unmarked = `${DOCS}/${UNMARKED}/main.md`
  w.folders[DOCS] = [OTHER, UNMARKED, 'novel']
  w.files[marked] = w.clock.now() - 400 * DAY
  w.texts[marked] = `\uFEFF\n${HANDOFF_MARKER}\n# Goal\n`
  w.files[unmarked] = w.clock.now() - 400 * DAY
  w.texts[unmarked] = '# Main character notes\n'
  w.files[`${DOCS}/novel/main.md`] = w.clock.now() - 400 * DAY
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs).toEqual([
    ['/bin/rm', '-f', '--', marked],
    ['/bin/rmdir', `${DOCS}/${OTHER}`],
  ])
})

test('in the default folder a marked handoff and one written before the marker are both removed', async ($, on) => {
  const w = world(on)
  const marked = `${HANDOFFS}/${OTHER}/main.md`
  const legacy = `${HANDOFFS}/${UNMARKED}/main.md`
  w.folders[HANDOFFS] = [OTHER, UNMARKED]
  w.files[marked] = w.clock.now() - 31 * DAY
  w.texts[marked] = `${HANDOFF_MARKER}\n# Goal\n`
  w.files[legacy] = w.clock.now() - 31 * DAY
  w.texts[legacy] = '# Goal\nkeep the VM full\n'
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(w.runs[0]).toEqual(['/bin/rm', '-f', '--', marked, legacy])
})

test('the handoff note asks main to start the file with the marker', async ($, on) => {
  const w = world(on)
  await step($, w, 430_000)
  expect((await toolContext($))?.[0]).toContain(`its first line exactly ${HANDOFF_MARKER}`)
})

test('on a 200k window main hands off and is compacted before auto-compaction would run', async ($, on) => {
  const w = world(on)
  w.context = windowOf(200_000, 167_000)
  await step($, w, 100_000)
  expect(w.toasts).toEqual([])
  await step($, w, 110_000)
  expect(w.toasts).toEqual(['main: context 110k, past the 100k warning'])
  await step($, w, 126_000)
  const note = (await toolContext($))?.[0] ?? ''
  expect(note).toContain('about 126k tokens, past the 125k handoff threshold')
  writeHandoff(w)
  await endTurn($, w)
  // The mod's own compaction, with the handoff, well under the 167k point.
  expect(w.compactions).toHaveLength(1)
  expect(w.compactions[0]?.instructions).toContain(`Read ${PATH} first`)
})

test('on a 1M window main hands off at the set 400k, not at a share of the window', async ($, on) => {
  const w = world(on)
  await step($, w, 399_000)
  expect(await toolContext($)).toBeUndefined()
  await step($, w, 400_000)
  expect((await toolContext($))?.[0]).toContain('past the 400k handoff threshold')
})

test('a set threshold past the auto-compact point is capped below it', { options: { warnTokens: 450_000, rotateTokens: 500_000 } }, async ($, on) => {
  const w = world(on)
  w.context = windowOf(200_000, 167_000)
  await step($, w, 130_000)
  expect((await toolContext($))?.[0]).toContain('past the 125k handoff threshold')
  expect(w.toasts).toEqual(['main: context 130k, past 125k: writing its handoff, then compacting in place'])
})

test('a window that cannot be read is taken as the fallback 200k one', async ($, on) => {
  const w = world(on)
  w.context = null
  await step($, w, 119_000)
  expect(await toolContext($)).toBeUndefined()
  await step($, w, 121_000)
  expect((await toolContext($))?.[0]).toContain('past the 120k handoff threshold')
})

test('a model switch to a smaller window is seen on the next step; the breakdown is asked once per window', async ($, on) => {
  const w = world(on)
  await step($, w, 130_000)
  await step($, w, 131_000)
  expect(await toolContext($)).toBeUndefined()
  expect(w.breakdowns).toBe(1)
  w.context = windowOf(200_000, 167_000)
  await step($, w, 132_000)
  expect((await toolContext($))?.[0]).toContain('past the 125k handoff threshold')
  await step($, w, 133_000)
  expect(w.breakdowns).toBe(2)
})
