import type { AgentInfo, On, SessionContextUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { SPAWN_RULE } from './logic'
import type { Engine } from 'claude-code/testing'

type World = {
  sizes: Record<string, number>
  toasts: string[]
  statuses: (string | undefined)[]
  isListBroken: boolean
  spawned: Record<string, unknown>[]
  /** The compaction window set for the session (`rawMaxTokens`), below main's 1M one; absent, none is set. */
  compactWindow?: number
}

// a1 and a2 run on a 1M window, a3 on a 200k one; the engine gives a4 none.
const LISTED = [
  { id: 'a1', description: 'Speed owner', type: 'general-purpose', status: 'running', name: 'speed', contextWindowSize: 1_000_000 },
  { id: 'a2', description: 'Grader fairness', type: 'general-purpose', status: 'running', contextWindowSize: 1_000_000 },
  { id: 'a3', description: 'Small', type: 'general-purpose', status: 'running', name: 'small', contextWindowSize: 200_000 },
  { id: 'a4', description: 'Unsized', type: 'general-purpose', status: 'running', name: 'unsized' },
] as const

// Stands for the engine beneath the plugin: the model's responses (their usage), the tools, the display.
function world(on: On): World {
  const w: World = { sizes: {}, toasts: [], statuses: [], isListBroken: false, spawned: [] }
  on('agent.spawn', ($, e) => {
    w.spawned.push({ ...e })

    return { model: 'test-small-model', agentId: 'a1' }
  })
  on('turn.step', async function* ($, e) {
    const size = w.sizes[e.agentId ?? 'main']

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage:
        size === undefined
          ? null
          : { model: e.model, input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: size - 3000, cache_creation_input_tokens: 2000 },
    }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && e.command === 'boom') {
      throw new Error('the tool broke')
    }

    return e.tool === 'Bash' && e.command === 'refused' ? { deny: 'not here' } : { result: 'done', text: 'done' }
  })
  on('session.usage', () => {
    const raw = w.compactWindow ?? 1_000_000
    const breakdown = { autoCompactThreshold: raw - 33_000, isAutoCompactEnabled: true, rawMaxTokens: raw }

    return { value: { startedAt: 0, context: { window: 1_000_000, breakdown } as SessionContextUsage, rateLimits: [] } }
  })
  on('agent.list', () => {
    if (w.isListBroken) {
      throw new Error('no list')
    }

    // The fixture holds only the fields the plugin reads.
    return { value: LISTED.map(agent => ({ ...agent })) as unknown as AgentInfo[] }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  // Main's handoff folder is resolved from these: /home/me/.claude/handoffs.
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  // Nothing here reaches the real disk.
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  return w
}

async function step($: Engine, w: World, agentId: string | undefined, size: number) {
  w.sizes[agentId ?? 'main'] = size
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 3, agentId })
  let piece = await stream.next()
  while (piece.done !== true) {
    piece = await stream.next()
  }

  return piece.value
}

// As the engine raises a tool call inside a loop: `agentId` names the loop, absent on main.
const read = ($: Engine, agentId: string | undefined, command = 'ls') => {
  const call = { tool: 'Bash' as const, command, tool_use_id: 'toolu_1', agentId }

  return $.tool.call(call)
}

const table = ($: Engine) =>
  $.command.run({
    command: 'agent-budget',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

test('the response passes through unchanged and the status names the largest subagent', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  const response = await step($, w, 'a1', 120_000)
  expect(response.answer).toBe('ok')
  expect(response.usage?.cache_read_input_tokens).toBe(117_000)
  await step($, w, 'a2', 90_000)
  expect(w.statuses.at(-1)).toBe('agents: 2 · max 120k (speed)')
  expect(w.toasts).toHaveLength(0)
})

test('crossing the warning toasts once and injects nothing', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 305_000)
  await step($, w, 'a1', 320_000)
  expect(w.toasts).toEqual(['speed: context 305k, past the 300k warning'])
  expect((await read($, 'a1')).context).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('agents: 1 · max 320k (speed) !')
})

test('past rotation the note rides the right agent\'s next tool result, once', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a2', 150_000)
  await step($, w, undefined, 150_000)
  await step($, w, 'a1', 412_000)
  expect(w.toasts.at(-1)).toBe('speed: context 412k, past 400k: told to hand off and stop')

  // Another agent's call and main's are left alone.
  expect((await read($, 'a2')).context).toBeUndefined()
  expect((await read($, undefined)).context).toBeUndefined()

  const noted = await read($, 'a1')
  expect(noted.result).toBe('done')
  expect(noted.context).toHaveLength(1)
  expect(noted.context?.[0]).toContain('about 412k tokens')
  expect(noted.context?.[0]).toContain('handoff brief')

  // Not on every call: the next ones are plain until 50k more.
  expect((await read($, 'a1')).context).toBeUndefined()
  await step($, w, 'a1', 440_000)
  expect((await read($, 'a1')).context).toBeUndefined()
  await step($, w, 'a1', 463_000)
  expect((await read($, 'a1')).context?.[0]).toContain('about 463k tokens')
  expect(w.statuses.at(-1)).toBe('agents: 2 · max 463k (speed) !! ROTATE')
})

test('a denied call keeps the note for the next result', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 420_000)
  const denied = await read($, 'a1', 'refused')
  expect(denied.context).toBeUndefined()
  expect((await read($, 'a1')).context).toHaveLength(1)
})

test('a compacted agent starts over', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 420_000)
  await step($, w, 'a1', 90_000)
  expect((await read($, 'a1')).context).toBeUndefined()
  await step($, w, 'a1', 301_000)
  expect(w.toasts.at(-1)).toBe('speed: context 301k, past the 300k warning')
})

test('main is toasted at the warning and at the threshold', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, undefined, 310_000)
  await step($, w, undefined, 430_000)
  expect(w.toasts).toEqual(['main: context 310k, past the 300k warning', 'main: context 430k, past 400k: writing its handoff, then compacting in place'])
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('includeMain off leaves main untracked', { options: { includeMain: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, undefined, 430_000)
  expect(w.toasts).toHaveLength(0)
  expect((await table($)).text).toContain('no agent has made a request yet')
})

test('thresholds come from the options', { options: { warnTokens: 1000, rotateTokens: 2000, repeatTokens: 500 } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 5_000)
  expect((await read($, 'a1')).context?.[0]).toContain('2k rotation threshold')
})

test('a loop the engine does not list is sized and never alerted', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'compact-fork-9', 450_000)
  expect(w.toasts).toHaveLength(0)
  expect((await read($, 'compact-fork-9')).context).toBeUndefined()
  expect(w.statuses.at(-1)).toBeUndefined()
  const text = (await table($)).text
  expect(text).toContain('450k  untracked')
})

test('/agent-budget prints the table and registers at session start', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await step($, w, 'a2', 90_000)
  await step($, w, 'a1', 412_000)
  const text = (await table($)).text ?? ''
  expect(text.split('\n')[2]).toContain('412k  ROTATE')
  expect(text).toContain('Grader fairness  [a2]')
})

test('fails open: a broken engine call never costs the response or the tool call', async ($, on) => {
  const w = world(on)
  w.isListBroken = true
  on('clock.now', () => ({ deny: 'no clock' }))
  const response = await step($, w, 'a1', 450_000)
  expect(response.answer).toBe('ok')
  expect((await read($, 'a1')).result).toBe('done')
  expect(w.toasts).toHaveLength(0)
})

test('fails open: a broken state read lets the tool call run', async ($, on) => {
  mock.clock(on)
  world(on)
  on('state.get', () => ({ deny: 'no state' }))
  expect((await read($, 'a1')).result).toBe('done')
})

const SPAWN = {
  tool_use_id: 'toolu_spawn',
  prompt: 'Read a.txt and report.',
  description: 'Reader',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test-model',
  background: true,
  fork: false,
  name: 'reader',
} as const

test('a spawned agent\'s prompt gains the standing rule once, and nothing else changes', async ($, on) => {
  const w = world(on)
  expect(await $.agent.spawn(SPAWN)).toEqual({ model: 'test-small-model', agentId: 'a1' })
  expect(w.spawned[0]).toEqual({ ...SPAWN, prompt: `${SPAWN.prompt}\n\n${SPAWN_RULE}` })

  // A prompt that already carries it (a respawn from a rewritten brief) is not given a second copy.
  await $.agent.spawn({ ...SPAWN, prompt: String(w.spawned[0]?.prompt) })
  expect(w.spawned[1]?.prompt).toBe(w.spawned[0]?.prompt)
})

test('a workflow\'s agent is spawned as given', async ($, on) => {
  const w = world(on)
  await $.agent.spawn({ ...SPAWN, workflow: { runId: 'wf_1', agentIndex: 1 } })
  expect(w.spawned[0]?.prompt).toBe(SPAWN.prompt)
})

test('addRuleToSpawns off leaves the prompt unchanged', { options: { addRuleToSpawns: false } }, async ($, on) => {
  const w = world(on)
  await $.agent.spawn(SPAWN)
  expect(w.spawned[0]).toEqual({ ...SPAWN })
})

test('fails open: an error in the spawn hook passes the spawn through as given', async ($, on) => {
  const w = world(on)
  // No prompt to append to: the hook throws, and its .catch hands the spawn on untouched.
  const broken = { ...SPAWN, prompt: undefined as unknown as string }
  expect(await $.agent.spawn(broken)).toEqual({ model: 'test-small-model', agentId: 'a1' })
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.prompt).toBeUndefined()
})

test('a subagent tool call that throws keeps the note for the next result', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 420_000)
  await read($, 'a1', 'boom').catch(() => undefined)
  expect((await read($, 'a1')).context?.[0]).toContain('about 420k tokens')
  expect((await read($, 'a1')).context).toBeUndefined()
})

test('showStatus off clears the status line and changes nothing else', { options: { showStatus: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 412_000)
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses.every(text => text === undefined)).toBe(true)
  expect(w.toasts).toEqual(['speed: context 412k, past 400k: told to hand off and stop'])
  expect((await read($, 'a1')).context).toHaveLength(1)
})

test('showToasts off silences the toasts; the status line and the note stay', { options: { showToasts: false } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 305_000)
  await step($, w, 'a1', 412_000)
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBe('agents: 1 · max 412k (speed) !! ROTATE')
  expect((await read($, 'a1')).context).toHaveLength(1)
})

test('a zero or negative threshold option falls back to its default', { options: { rotateTokens: 0, warnTokens: -1 } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 5_000)
  expect((await read($, 'a1')).context).toBeUndefined()
  expect(w.toasts).toEqual([])
  await step($, w, 'a1', 400_000)
  expect((await read($, 'a1')).context?.[0]).toContain('400k rotation threshold')
})

test('main and a subagent each get their own note, on their own tool results', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, undefined, 430_000)
  await step($, w, 'a1', 420_000)
  const sub = (await read($, 'a1')).context ?? []
  expect(sub).toHaveLength(1)
  expect(sub[0]).toContain('handoff brief')
  expect(sub[0]).not.toContain('compacted in place')
  const main = (await read($, undefined)).context ?? []
  expect(main).toHaveLength(1)
  expect(main[0]).toContain('compacted in place')
})

test('a subagent on a 200k window is told to hand off before its auto-compaction', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a3', 119_000)
  expect((await read($, 'a3')).context).toBeUndefined()
  await step($, w, 'a3', 121_000)
  expect((await read($, 'a3')).context?.[0]).toContain('past the 120k rotation threshold')
  expect(w.toasts.at(-1)).toBe('small: context 121k, past 120k: told to hand off and stop')
  expect(w.statuses.at(-1)).toBe('agents: 1 · max 121k (small) !! ROTATE')
})

test('a subagent whose window the engine does not give is capped as the fallback window', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a4', 121_000)
  expect((await read($, 'a4')).context?.[0]).toContain('past the 120k rotation threshold')
})

test('a compaction window set for the session lowers a subagent\'s cap', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.compactWindow = 300_000
  await step($, w, 'a1', 179_000)
  expect((await read($, 'a1')).context).toBeUndefined()
  await step($, w, 'a1', 181_000)
  expect((await read($, 'a1')).context?.[0]).toContain('past the 180k rotation threshold')
})

test('a set threshold past a subagent\'s cap is capped', { options: { rotateTokens: 900_000 } }, async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 'a1', 640_000)
  expect((await read($, 'a1')).context?.[0]).toContain('past the 600k rotation threshold')
})
