# goal-refresh

Keeps a session's standing goal in the model's attention during long sessions (loops, monitoring, many subagent notifications), and lets the goal be changed by talking it over with Claude.

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install goal-refresh@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install goal-refresh --marketplace RyanKim17920/ryk-claude-mods
```

## How it relates to native `/goal`

Checked against Claude Code 2.1.330 (its binary, a real transcript and code.claude.com/docs/en/goal):

- `/goal <condition>` is a session-scoped prompt Stop hook. A separate evaluator checks the condition each time the model tries to end a turn; the condition lives in memory and in `goal_status` rows of the transcript, so a resume restores it.
- The model sees the condition when it is set, when a stop attempt is blocked ("Stop hook feedback: [condition]: reason") and in idle check-ins while background work runs. It is not re-sent every turn or after compaction.
- Hooks get no goal field or event. The `GetGoal`/`SetGoal` tools exist but only behind the model-proposed-goals flag, which is off by default.

So this mod:

- **Reads** the native condition from the transcript (the engine's own resume rule: last `goal_status` row, met or failed means none). It also notices `/goal …` as you type it, and `SetGoal`. The reminder includes the native condition.
- **Never writes** the native goal. That goal is a completion condition that blocks stopping until it is met; a standing goal such as "keep the VM full" would never let the session stop. Setting it from a mod would also start a model turn.
- Keeps its own **standing goal and sub-goals** per session in `$.store`.

## The reminder

A short note ("Standing goal: …; Current sub-goals: …; Last updated 2h ago (reason). Active /goal stop condition: …") is attached as hidden context to something already happening. That can be a prompt being submitted (typed, a task notification or a loop tick) or a main-thread tool result in a long turn. The mod never submits a prompt, so an idle session stays idle. The reminder is due:

- after `everyTurns` main-thread turns since the last one;
- at the first chance after a compaction (`afterCompact`) and after a start, resume or hot reload;
- once `minIntervalMinutes` have passed, with at least one turn in between.

It is never given twice with nothing in between. Subagents never get it and their turns don't count. A session with no goal and no native `/goal` pays nothing: there is no reminder or status, and the transcript is read once at start. Once a native `/goal` has been seen, a main-thread turn re-reads the transcript at most every `nativeReadMinutes` (10); a compaction, a resume, `/goal`, `SetGoal`, `/goal-refresh show` and each reminder read it at once.

## Commands

```
/goal-refresh set <goal>          set this session's standing goal
/goal-refresh subgoals <a | b>    replace the sub-goals (empty clears them)
/goal-refresh show                goal, native /goal, last reminder
/goal-refresh history             last 20 changes, newest first
/goal-refresh clear               clear goal and sub-goals
```

## Updating the goal by discussion

The mod registers a deferred model tool, `goal_update({ goal?, subgoals?, clear?, reason })` (`mcp__<plugin>__goal_update`: `mcp__goal-refresh__goal_update` as shipped; a renamed copy gets its own name, which the mod takes from the registration). Its description tells the model to call it only after you have explicitly agreed in conversation, and never on its own initiative. So you say "let's make the goal X, with sub-goals A and B", Claude proposes it, you say yes, and Claude calls the tool. Each update shows a toast with the old and new goal and is logged to `/goal-refresh history`. Main thread only. Goal ≤1000 chars, ≤10 sub-goals of ≤300 chars, history capped at 20; the store keeps the 200 most recent sessions.

## Options (userConfig)

| Option | Default | What it does |
| --- | --- | --- |
| `everyTurns` | 10 | Refresh after this many main-thread turns (0 = off) |
| `afterCompact` | true | Refresh after a compaction |
| `minIntervalMinutes` | 20 | Refresh after this many minutes (0 = off) |
| `mirrorNativeGoal` | true | Read and include the native `/goal` condition |
| `nativeReadMinutes` | 10 | Least minutes between transcript re-reads on main-thread turns (0 = every turn) |
| `showStatus` | true | Status line shows the truncated goal |
| `showToasts` | true | Toast on each `goal_update` |
| `systemNotifications` | false | Also send a macOS notification on each `goal_update` |

Every hook fails open. An error passes the event through unchanged.

## Disable

`claude plugin disable goal-refresh@ryk-claude-mods`, or `/goal-refresh clear` to stop it in one session.
