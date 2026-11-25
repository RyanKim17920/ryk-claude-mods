import type { EngineInterface, Register, SessionCompactInput, SessionCompacted } from 'claude-code'

import {
  BRIEF_HEADER, MAIN, MAX_LOOPS, MAX_SESSIONS, NEW_LOOP, LEGACY_STORE_KEY, SESSION_KEY_PREFIX, briefPath, briefsBeyond, capLoops,
  entryOf, findSummary, formatBrief, formatStatus, handoffNote, isBriefText, isLegacySpent, isSessionFolder, isStaleBrief, loopsOf, mainLimits,
  readLimits, readRetention, resolveBriefDir, safeSegment, sessionKey, sessionKeysToDrop, shrinkRatio, step, takeNote,
  toastText, withFocus,
} from './brief'
import type { Limits, Loops, Retention } from './brief'

type Config = {
  focus: string
  /** The `briefDir` option, resolved against the environment on first use and kept for the load. */
  dir: { option: unknown; resolved: Promise<string> | null }
  limits: Limits
  retention: Retention
  showsToasts: boolean
  /** Once per load of the module: a reload or a new session tidies again. */
  tidied: { store: boolean; disk: boolean }
}

// One writer at a time within this session: loops compact in parallel. Other
// sessions write keys of their own, so they never race this one's value.
let writing: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const ran = writing.then(work, work)
  writing = ran.catch(() => undefined)

  return ran
}

/**
 * This session's loops as the store holds them: they outlive a resume or a
 * restart. A session with no key of its own yet reads what 0.1.0 kept for it.
 */
async function loopsIn($: EngineInterface, sessionId: string): Promise<Loops> {
  const own = entryOf(await $.store.get(sessionKey(sessionId)))
  if (own !== undefined) return own.loops

  return loopsOf(await $.store.get(LEGACY_STORE_KEY), sessionId)
}

const readLoops = async ($: EngineInterface): Promise<Loops> => loopsIn($, await $.session.id())

/**
 * Removes stale and surplus sessions' keys and, once no session can still be
 * reading it, the 0.1.0 one-value layout. Best effort: a failure is logged.
 */
async function tidyStore($: EngineInterface, config: Config, sessionId: string, nowMs: number): Promise<void> {
  if (config.tidied.store) return
  config.tidied.store = true
  try {
    const keys = (await $.store.keys()).filter(key => key.startsWith(SESSION_KEY_PREFIX))
    const entries: (readonly [string, unknown])[] = []
    for (const key of keys) entries.push([key, await $.store.get(key)] as const)
    for (const key of sessionKeysToDrop(entries, nowMs, sessionKey(sessionId), MAX_SESSIONS)) await $.store.delete(key)
    const legacy = await $.store.get(LEGACY_STORE_KEY)
    if (legacy !== undefined && isLegacySpent(legacy, nowMs)) await $.store.delete(LEGACY_STORE_KEY)
  } catch (error) {
    $.ui.log(`focus-compact: store not tidied: ${String(error)}`, { to: 'debug' })
  }
}

/** Applies `change` to this session's loops and stores them; `change` answers undefined to write nothing. */
async function changeLoops<T>(
  $: EngineInterface,
  config: Config,
  change: (loops: Loops) => { loops: Loops; value: T; keepKey: string } | undefined,
): Promise<T | undefined> {
  return serialized(async () => {
    const sessionId = await $.session.id()
    const changed = change(await loopsIn($, sessionId))
    if (changed === undefined) return undefined
    const nowMs = await $.clock.now()
    const loops = capLoops(changed.loops, MAX_LOOPS, changed.keepKey)
    await $.store.set(sessionKey(sessionId), { updatedAt: nowMs, loops })
    await tidyStore($, config, sessionId, nowMs)

    return changed.value
  })
}

/** How many numbered briefs of one conversation are looked past before giving up. */
const MAX_BRIEFS = 500
/** Files one `rm` call is given at most. */
const RM_BATCH = 200
/** Session folders one age pass looks at, at most: the rest wait for the next load. */
const MAX_PRUNE_DIRS = 1000

/**
 * Writes the summary under `dir` and answers its path, or null when there is
 * no summary. A number already on disk is stepped past: a brief is never
 * overwritten, and with every number in reach taken none is written.
 */
async function writeBrief(
  $: EngineInterface,
  dir: string,
  e: SessionCompactInput,
  done: SessionCompacted,
  count: number,
): Promise<string | null> {
  const summary = findSummary(e.messages, done.messages)
  if (summary === undefined) return null

  const loopKey = e.agentId ?? MAIN
  const sessionId = await $.session.id()
  let n = count
  while (n < count + MAX_BRIEFS && (await $.fs.exists(briefPath(dir, sessionId, loopKey, n)))) n++
  if (n >= count + MAX_BRIEFS) throw new Error(`${MAX_BRIEFS} brief numbers from ${count} are taken`)
  const path = briefPath(dir, sessionId, loopKey, n)
  const { tokensBefore, tokensAfter } = done
  const ratio = shrinkRatio(tokensBefore, tokensAfter)
  const nowMs = await $.clock.now()
  await $.fs.write(
    path,
    formatBrief({ loopKey, sessionId, trigger: e.trigger, count, nowMs, tokensBefore, tokensAfter, ratio, summary }),
  )

  return path
}

/** True when the file at `path` starts with the brief header; a file that cannot be read is not a brief. */
async function isBriefFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    const head = await $.fs.read(path, { offset: 0, length: BRIEF_HEADER.length })

    return typeof head === 'string' && isBriefText(head)
  } catch {
    return false
  }
}

/** Of `paths`, those whose content shows this mod wrote them: a file merely named like a brief stays. */
async function briefsOnly($: EngineInterface, paths: readonly string[]): Promise<string[]> {
  const kept: string[] = []
  for (const path of paths) if (await isBriefFile($, path)) kept.push(path)

  return kept
}

/** Removes files by absolute path, a batch per `rm`. */
async function removeFiles($: EngineInterface, paths: readonly string[]): Promise<void> {
  for (let at = 0; at < paths.length; at += RM_BATCH) {
    await $.process.run(['/bin/rm', '-f', '--', ...paths.slice(at, at + RM_BATCH)], { timeoutMs: 10_000 })
  }
}

/** The folder briefs go under, from the option, `CLAUDE_CONFIG_DIR` and `HOME`; read once per load. */
function briefDirOf($: EngineInterface, config: Config): Promise<string> {
  config.dir.resolved ??= (async () => {
    const [configDir, home] = await Promise.all([$.env.get('CLAUDE_CONFIG_DIR'), $.env.get('HOME')])

    return resolveBriefDir(config.dir.option, { configDir, home })
  })()

  return config.dir.resolved
}

/** Keeps the newest `keepBriefs` briefs of the conversation just compacted. */
async function pruneLoopBriefs($: EngineInterface, config: Config, sessionId: string, loopKey: string): Promise<void> {
  if (config.retention.keepBriefs === 0) return
  const folder = `${await briefDirOf($, config)}/${safeSegment(sessionId)}`
  const files = (await $.fs.list(folder)).filter(entry => entry.kind === 'file' && !entry.isLink).map(entry => entry.name)
  const surplus = briefsBeyond(files, loopKey, config.retention.keepBriefs)
  await removeFiles($, await briefsOnly($, surplus.map(name => `${folder}/${name}`)))
}

/**
 * Once per load: removes other sessions' briefs older than `briefMaxAgeDays`,
 * then each folder that held nothing else. Only folders named like a session id
 * are looked in, and only files named as this mod names its briefs whose content
 * starts with its brief header are removed: a `briefDir` pointed at a folder of
 * other files leaves them alone.
 */
async function pruneOldBriefs($: EngineInterface, config: Config, sessionId: string, nowMs: number): Promise<void> {
  if (config.tidied.disk || config.retention.briefMaxAgeDays === 0) return
  config.tidied.disk = true
  const own = safeSegment(sessionId)
  const dir = await briefDirOf($, config)
  const folders = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'dir' && !entry.isLink && entry.name !== own && isSessionFolder(entry.name))
    .slice(0, MAX_PRUNE_DIRS)
  const stale: string[] = []
  const emptied: string[] = []
  for (const folder of folders) {
    const path = `${dir}/${folder.name}`
    const entries = await $.fs.list(path).catch(() => [])
    const named = entries.filter(entry => isStaleBrief(entry, nowMs, config.retention.briefMaxAgeDays))
    const old = await briefsOnly($, named.map(entry => `${path}/${entry.name}`))
    stale.push(...old)
    if (old.length > 0 && old.length === entries.length) emptied.push(path)
  }
  await removeFiles($, stale)
  // rmdir leaves a folder that still holds anything; that is fine.
  if (emptied.length > 0) await $.process.run(['/bin/rmdir', ...emptied], { timeoutMs: 10_000 })
}

/** Both brief rules, best effort: a failure is logged and the compaction stands. */
async function pruneBriefs($: EngineInterface, config: Config, loopKey: string): Promise<void> {
  try {
    const sessionId = await $.session.id()
    await pruneLoopBriefs($, config, sessionId, loopKey)
    await pruneOldBriefs($, config, sessionId, await $.clock.now())
  } catch (error) {
    $.ui.log(`focus-compact: briefs not pruned: ${String(error)}`, { to: 'debug' })
  }
}

/** Counts the compaction, keeps its brief, and asks a subagent for a handoff when it is time; main is never asked. */
async function record($: EngineInterface, config: Config, e: SessionCompactInput, done: SessionCompacted): Promise<void> {
  const { limits } = config
  const loopKey = e.agentId ?? MAIN
  const isMain = e.agentId === undefined
  const before = (await readLoops($))[loopKey] ?? NEW_LOOP
  let brief: string | null = null
  try {
    brief = await writeBrief($, await briefDirOf($, config), e, done, before.count + 1)
  } catch (error) {
    $.ui.log(`focus-compact: brief not written: ${String(error)}`, { to: 'debug' })
  }
  if (brief !== null) await pruneBriefs($, config, loopKey)
  const ratio = shrinkRatio(done.tokensBefore, done.tokensAfter)
  const stepped = await changeLoops($, config, all => {
    const { loop, escalation } = step(all[loopKey] ?? NEW_LOOP, ratio, brief, isMain ? mainLimits(limits) : limits, done.tokensBefore)
    // A row appended now would be compacted away with the transcript it joins
    // (the engine installs the compaction after this hook returns), so the note
    // waits for the subagent's next tool result. Main gets none: it compacts in place.
    const pendingNote = escalation === undefined || isMain ? loop.pendingNote : handoffNote(escalation, loop, limits)

    return { loops: { ...all, [loopKey]: { ...loop, pendingNote } }, value: { loop, escalation }, keepKey: loopKey }
  })
  if (stepped?.escalation === undefined || !config.showsToasts) return

  $.ui.toast(toastText(stepped.escalation, loopKey, stepped.loop, limits), { timeoutMs: 15_000 })
}

/** The loop's waiting handoff note, taken so that it is given once; undefined when none waits. */
async function takePendingNote($: EngineInterface, config: Config, loopKey: string): Promise<string | undefined> {
  if (takeNote(await readLoops($), loopKey) === undefined) return undefined

  return changeLoops($, config, all => {
    const taken = takeNote(all, loopKey)

    return taken === undefined ? undefined : { loops: taken.loops, value: taken.note, keepKey: loopKey }
  })
}

export const register: Register = (on, options) => {
  const config: Config = {
    focus: typeof options.focus === 'string' ? options.focus : '',
    dir: { option: options.briefDir, resolved: null },
    limits: readLimits(options.handoffAfter, options.minShrinkRatio, options.minTokensForRatio),
    retention: readRetention(options.keepBriefs, options.briefMaxAgeDays),
    showsToasts: options.showToasts !== false,
    tidied: { store: false, disk: false },
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'focus-compact',
      description: 'Show compaction count, last shrink and last brief for main and each subagent',
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const instructions = withFocus(config.focus, e.instructions)
    const done = await next(instructions === undefined ? e : { ...e, instructions })
    // A precompute installs nothing and a skip compacted nothing: neither is a compaction that stood.
    if (e.trigger === 'precompute' || done.skip !== undefined) return done
    try {
      await record($, config, e, done)
    } catch (error) {
      $.ui.log(`focus-compact: not recorded: ${String(error)}`, { to: 'debug' })
    }

    return done
  }).catch(($, e, next) => next(e))

  // Main is never handed a note, a stale one from before included: it compacts in place.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.agentId === undefined) return ran
    const note = await takePendingNote($, config, e.agentId)

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'focus-compact' }, async $ => {
    try {
      return { text: formatStatus(await readLoops($)) }
    } catch (error) {
      return { text: `could not read its store: ${String(error)}` }
    }
  }).catch(() => ({ text: 'could not read its store.' }))
}
