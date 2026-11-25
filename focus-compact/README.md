# focus-compact

Gives every compaction (automatic, manual and precomputed) a standing focus, keeps each summary as a brief on disk, and notices when compaction stops paying.

- **Focus:** the `focus` text goes first in every compaction's instructions. Text typed after `/compact` goes after it and takes precedence.
- **Briefs:** each compaction that stands writes its summary to `<briefDir>/<sessionId>/<main-or-agentId>-<n>.md`. An existing file is never overwritten.
- **Escalation:** a **subagent** is asked, on its next tool result, to write its handoff brief and stop. This happens at its `handoffAfter`-th compaction, or when a compaction of at least `minTokensForRatio` tokens keeps more than `minShrinkRatio` of them. **Main** is never asked: it compacts in place as often as it needs, and a poor shrink only toasts.
- `/focus-compact` shows each conversation's count, last shrink and last brief.

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install focus-compact@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install focus-compact --marketplace RyanKim17920/ryk-claude-mods
```

## Options

A bad value (not a number, or out of range) falls back to the default.

| Option | Default | What it does |
| --- | --- | --- |
| `focus` | the five-point focus in `plugin.json` | Put first in every compaction's instructions. Empty sends none. |
| `briefDir` | empty | Absolute folder (or one under `~/`) for the briefs. Empty means `compact-briefs` in Claude's config folder: `$CLAUDE_CONFIG_DIR/compact-briefs` when that variable is set, else `~/.claude/compact-briefs`. A relative path or one with `..` falls back to that default. |
| `handoffAfter` | `3` | A subagent's compaction count at which it is asked to hand off (at least 1). |
| `minShrinkRatio` | `0.6` | A compaction keeping more than this share (over 0, up to 1) is poor. |
| `minTokensForRatio` | `50000` | Only conversations at least this large are judged on their ratio. |
| `keepBriefs` | `30` | Newest briefs kept per conversation. `0` keeps all. |
| `briefMaxAgeDays` | `30` | Remove other sessions' briefs older than this. `0` keeps all. |
| `showToasts` | `true` | Show toasts. Display only: counting, briefs and notes run the same. |

## Files it writes

- **Briefs:** `<briefDir>/<sessionId>/<conversation>-<n>.md`.
- **Pruning:** after each brief, the mod removes that conversation's briefs past the newest `keepBriefs`. Once per load it also removes other sessions' briefs older than `briefMaxAgeDays`, and runs `rmdir` on each folder it emptied. It only looks in folders named like a session id (a uuid), and only removes files named `<conversation>-<n>.md` whose content starts with the brief header `# Compaction brief: ` (with `/bin/rm`), never any other file. So a `briefDir` pointed at a folder of other notes leaves them alone.
- **Store** (`$.store`, a JSON file under the Claude config folder's `plugins/store/`): one key per session, `session:<id>`, so concurrent sessions never overwrite each other. Sessions not written for 14 days are dropped, the store keeps at most 50 sessions, and each session keeps at most 200 conversations. The 0.1.0 key `sessions` is still read for a session that has no key of its own yet. It is removed once every session in it is stale.

## Disable

```sh
claude plugin disable focus-compact@ryk-claude-mods
```

## Test

```sh
# from your clone of this repository
claude plugin test focus-compact
claude plugin validate focus-compact
```

The tests stand in for the engine (compaction, store, disk) and touch no real file.
