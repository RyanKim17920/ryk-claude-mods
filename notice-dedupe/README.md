# notice-dedupe

When Claude Code runs subagents or a team, the main thread gets woken by notices that say nothing new: "your report was delivered", "still waiting", the same message twice, a teammate going idle right after it already reported. Each one costs a turn and some context. This mod drops those notices before they reach the main thread, and never drops one that carries news.

## What it drops

- **"Report was delivered"** task notifications, whose result only says the report already arrived as a message.
- **"Has not reported yet"**: the first per task passes; later ones inside the window drop.
- **Repeats** inside the window: the same notification for the same task, the same scheduled or plugin prompt, an agent `SendMessage` identical to the last one that agent delivered to the same recipient (refused), the same `<cross-session-message>` from the same sender, and the same failed or killed notification for the same task.
- **Teammate idle notices that add nothing** after that teammate's report, such as "I'm done, nothing further to add." With `aggressiveIdle` on, also idle notices that restate the report, only say they are waiting, echo a message to another teammate or reword the report.

The exact rules are under [Details](#details).

## What it never drops

Anything a person typed, pasted or sent through a plugin as the user. The first failure of a task. Stopped or stalled notices. A real report, even one quoting the boilerplate. Messages shorter than `sendMinChars`. Any error inside the mod lets the item through unchanged.

## Details

### "Report was delivered" rows

Folded into a turn, the row cannot be refused, so it is emptied (`foldMode`). Delivered mid-turn, it is left out of the request.

### Teammate idle notices

A report is a `<teammate-message>`, or a named teammate's (or subagent's) `SendMessage` to main as an `<agent-message>`, whether it arrives as a turn of its own or into a running one. Inside the window after it, every idle notice holding a closing phrase ("I'm done", "nothing further to add", "I'm stopping here") drops if it adds nothing, and so does the first plain "available" idle notice that adds nothing (only the first: an empty one says nothing, not that nothing changed).

Curly quotes become straight ones, a non-breaking space a space, and backticks and `*`/`_` emphasis markers are taken out of both the notice and the report (so `` `logs/x` `` matches `logs/x`). A notice adds nothing only when what is left is written in ASCII letters, digits, whitespace and ordinary punctuation (`.,;:!?'"()-/_`) and, once its delivery phrases ("I've sent that line to main", "the team lead has received it") and closing phrases are taken out and the `.,;:!` and whitespace at either end trimmed (a `?` stays), what is left is empty or exactly one whole sentence of the report, ignoring case and whitespace, with its words in the same order. Anything else enters: another word, another order, part of a sentence or two of them, a question the report did not ask, another script, an emoji, strikethrough (`~~`), a lone `*`.

After a report that left something open ("still running", "not merged", a blocker), closing phrases are not taken out, so no note saying it is finished drops. Deliveries are read in the harness's frame, as they arrive.

`aggressiveIdle` adds, as often as they come, idle notices that restate the report or only say they are waiting, echoes of messages to other teammates and rewordings of the report, and reads bundles of several notices.

### Refused sends

A refused send is not an error to stop on. The sender reads: "identical to your last message to "main" (2m ago), which it already has. Nothing is wrong. Keep working on your task. When something changes, send the new information; don't reword the same status." Only the sender's last delivered message counts, whoever it went to: a send is refused only when that message went to the same `to` with the same text. So a status that changes and then changes back is sent again, and so is a repeat after any message in between, to a broadcast (`*`) or another name for the same recipient included.

A send never waits on another. While an earlier send from the same agent is still being delivered, the next one is never refused, since the earlier one may land after it: at worst a repeat gets through. A send still in delivery after 30 seconds stops counting, and refusal for that agent resumes once one of its sends has been saved again. Nothing is written until a send is delivered, so a crash or reload never leaves a claim that refuses a retry. If a delivered send cannot be written, or sends land in a different order than they were made, that agent's sends are not refused until one is written again.

### What counts as a repeat

Repeats are compared after masking only tokens that are pure noise: a timestamp that opens a line or sits in a named time field (`timestamp:`, `created_at:`), UUIDs, prefixed ids (`toolu_…`, `agentId:`/`task-id` fields), counters in named fields (`duration_ms:`, `total_tokens:`, `tokens=`, `<usage>` blocks), and a session's own folder in a scratchpad, tool-results or tmp path (the file under it is kept). Everything in prose is kept as written: full commit shas, durations and latencies, dates, file names, counts and scores. So a changed fact always passes.

## Options (`/plugin` config menu, or `pluginConfigs["notice-dedupe"].options` in settings)

| Option | Default | Effect |
| --- | --- | --- |
| `dropWaiting` | true | Drop repeated "has not reported yet" notices |
| `dropDelivered` | true | Drop "report was delivered" notices |
| `foldMode` | `empty` | Folded delivered rows: `empty` (stored as "(no content)") or `stub` (one line) |
| `dropRepeats` | true | Drop repeated notifications and scheduled/plugin prompts |
| `dropRepeatFailures` | true | Drop an exact repeat of a failed/killed notice for the same task |
| `dropPeerRepeats` | true | Drop a repeated cross-session message from the same sender |
| `dropIdleAfterReport` | true | Drop a teammate's idle notices that add nothing after its report |
| `aggressiveIdle` | false | Also drop restating, waiting, echoing or rewording idle notices, and read bundles |
| `refuseRepeatSends` | true | Refuse a repeated agent message (delivered sends are remembered either way, so turning it back on never judges against a stale one) |
| `sendMinChars` | 80 | Shorter messages are never treated as repeats |
| `windowMinutes` | 30 | Repeat window, 1 to 1440 |
| `showStatus` | true | "dedupe: N dropped" in the status line |
| `showToasts` | false | A toast for each drop (noisy) |
| `driftAlerts` | true | The daily wording-drift toast |

A malformed value falls back to its default.

## Counters and `/notice-dedupe`

`/notice-dedupe` shows this session's drops by reason and the last ten. It also shows the counters kept across sessions in the plugin's store (`~/.claude/plugins/store/notice-dedupe_*.json`): drops per reason, folded rows, boilerplate matches and near-misses.

A **near-miss** is a short completed result that matches neither boilerplate exactly but carries at least two of their own marks ("This agent ..." as its opening, `SubagentHandback`, "report was delivered/sent/handed", "not reported yet", "as a message from", "not repeated here", "waiting on its own"). An ordinary hand-back that mentions a message it sent is not one. If a session sees three or more near-misses and no match, the harness has probably reworded its notices. A toast then says so, at most once a (local) day, and the filter needs updating. `/notice-dedupe` shows the last near-miss. Every date it prints is a local calendar day.

## Disable

Turn off single behaviours with the options above. To turn off the whole mod, disable it in `/plugin`.

## Test

From the repository root:

```
claude plugin test notice-dedupe
claude plugin validate notice-dedupe
```
