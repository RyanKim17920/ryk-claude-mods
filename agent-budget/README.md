# agent-budget

Tracks each agent's context size, from the token usage of its latest model request, and warns as it grows.

- **Warning** (300k by default): one toast per agent.
- **Threshold** (400k by default), repeated every further 50k until a compaction resets the count:
  - a **subagent** is told, on its next tool result, to finish its step, write its handoff brief (at most 60 lines, with its unmerged branches) and stop;
  - **main** is told to write its handoff to `<handoffDir>/<sessionId>/main.md`. When its turn ends it is **compacted in place**; it is never moved to a new session. After any compaction of main, the summary and main's next turn point it at that file.
- **Window cap:** each agent's warning and threshold are capped at 60% and 75% of the point where the engine would auto-compact it (below).
- A spawned agent's prompt gets one standing sentence telling it to follow an `[agent-budget]` note.
- `/agent-budget` lists every tracked agent by size. The status line names the largest live subagent.

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install agent-budget@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install agent-budget --marketplace RyanKim17920/ryk-claude-mods
```

## Context windows

The handoff has to come before the engine's own auto-compaction, or main compacts with no handoff written. On a 200k window that point is about 167k, so a flat 400k would never be reached. Each agent is therefore held to the lower of the set value and a share of its own auto-compact point:

- warning: `min(warnTokens, 60% of the point)`
- handoff: `min(rotateTokens, 75% of the point)`

The 25% left is room for main to finish its step and write the handoff before the engine would compact.

| Window | Auto-compact point | Warning | Handoff |
| --- | --- | --- | --- |
| 200k | about 167k | 100k | 125k |
| 1M | about 967k | 300k (set value) | 400k (set value) |
| unknown | taken as a 200k window: 160k | 96k | 120k |

Where the point comes from:

- **Main:** `$.session.usage({ breakdown: 'summary' })` gives the engine's own `autoCompactThreshold`, which already reflects `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and the percent override. It is read once per window size (a model switch reads it again); the free `$.session.usage()` call each step notices the switch. With auto-compaction off, the point is the window itself, so main still hands off before it runs out.
- **A subagent:** the engine reports only its model's window (`contextWindowSize` from `$.agent.list()`), not its threshold. The point is estimated as 80% of that window, which is at or below where the engine compacts a 200k window and well below on a 1M one, so the estimate errs early, never late. A compaction window set for the session lowers it, as it lowers a subagent's.
- **Unknown window** (the engine call fails, or gives none): the mod takes a 200k window. On a larger window that hands off early (120k), which costs a compaction; assuming a large window would let a small one compact without a handoff, which costs the handoff. Early is the cheaper mistake.

A set `warnTokens` or `rotateTokens` is honoured up to that cap, never past it, so no setting can push the handoff past auto-compaction. `/agent-budget` shows each agent's own handoff point.

## Options

Set these in `/plugin` (config) or under `pluginConfigs` in settings. A bad value (not a number, 0 or negative where a positive number is needed) falls back to the default.

| Option | Default | What it does |
| --- | --- | --- |
| `warnTokens` | `300000` | Toast once when an agent first reaches this size. Capped at 60% of the agent's auto-compact point. |
| `rotateTokens` | `400000` | Past this size, main hands off and is compacted in place, and a subagent hands off and stops. Capped at 75% of the agent's auto-compact point. |
| `repeatTokens` | `50000` | Repeat the handoff note every this much further growth. |
| `includeMain` | `true` | Track main too. Off, main is never noted or compacted by this mod. |
| `handoffDir` | empty | Absolute folder (or one under `~/`) for main's handoff. Empty means `handoffs` in Claude's config folder: `$CLAUDE_CONFIG_DIR/handoffs` when that variable is set, else `~/.claude/handoffs`. A relative path or one with `..` falls back to that default. |
| `handoffMaxAgeDays` | `30` | Remove other sessions' `main.md` handoffs older than this. `0` keeps every file. |
| `addRuleToSpawns` | `true` | Append the standing rule to every spawned agent's prompt (never to a workflow's agent). |
| `showStatus` | `true` | Show the status-line entry. Display only. |
| `showToasts` | `true` | Show toasts. Display only: tracking and notes run the same. |

## Files it writes

- **On disk:** nothing written by the mod itself. Main writes `<handoffDir>/<sessionId>/main.md` when told to (one file per session, overwritten each cycle), its first line the marker `<!-- agent-budget handoff -->`.
- **Pruning:** once per load, after a compaction of main, the mod removes other sessions' `main.md` older than `handoffMaxAgeDays`, using `/bin/rm`. It only looks in folders named like a session id (a uuid), and only removes a `main.md` whose first line is `<!-- agent-budget handoff -->`, which main is told to write. In the default folder a handoff written before that marker existed is removed too; in a `handoffDir` you set, an unmarked file is never removed. It then runs `rmdir` on those folders, which leaves any folder that still holds something else (a backup you made, for example). The current session's file is never removed.
- **Session state** (`$.state`, gone when the session ends): one track per agent (with its auto-compact point; a track from an older version has none and is capped as an unknown window), capped at the 200 most recent (main is always kept), plus main's handoff cycle. A value an older version left that does not parse is ignored.

## Disable

```sh
claude plugin disable agent-budget@ryk-claude-mods
```

To keep the mod but leave main alone, set `includeMain` to `false`.

## Test

```sh
# from your clone of this repository
claude plugin test agent-budget
claude plugin validate agent-budget
```

The tests stand in for the engine (model usage, tools, compaction, the disk) and touch no real file.
