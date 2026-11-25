# branch-owners

Records which agent created each git branch and worktree, and lists the
branches not yet merged with the agent that owns each (`/branch-owners`).

A branch is recorded when a Bash command creates it (`git checkout -b|-B|--orphan`,
`git switch -c|-C|--orphan`, `git branch <name>`, `git worktree add [-b|-B]`)
or when an Agent call returns a worktree branch. The owner is `main` for
the main conversation, else the subagent's name, description or id. The
first owner recorded stands. Nothing is recorded when:
- the command failed or was denied
- the branch already existed before the command ran
- the name is one the shell would expand (`$X`, a glob)
- the text was inside quotes, a `#` comment or a here-document

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install branch-owners@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install branch-owners --marketplace RyanKim17920/ryk-claude-mods
```

## Command

- `/branch-owners` prints the unmerged branches: name, owner, age of the
  head commit and short sha. Branches with no record show `unknown`.
- `/branch-owners json` also writes the table as JSON to `exportPath`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `""` | Branch that "unmerged" is measured against. Empty uses `origin/HEAD`, then `main`. A value starting with `-` or containing a space is refused. |
| `exportPath` | `""` | File that `/branch-owners json` writes. Empty writes nothing. A leading `~/` is your home directory, and a relative path is under the session's directory. |

The mod shows nothing in the status line, toasts or system notifications,
so it has no visibility options. Its output is the command's own text.

## Files

- Reads: git, through `git -C <repo> ...` (rev-parse, for-each-ref, branch, worktree list, symbolic-ref).
- Writes: the plugin's own store (`$.store`, a JSON file in the Claude Code
  config directory) under one key per repository, `repo:<root>`. The store is shared by every session.
- Keeps, per session: agent id to label (`$.state`, gone when the session ends).
- Writes `exportPath`, only on `/branch-owners json`.

## Ledger bounds

Each repository's ledger stays bounded. Every new claim drops records for
branches that no longer exist and keeps at most 500 records, newest first.
`/branch-owners` also drops branches merged into the base. Writes from one
session go one at a time. The store has no compare-and-set across sessions,
so after each claim the ledger is read back and the claim is written again
if another session's write replaced it. A prune reads the ledger again just
before writing, so it only removes the branches it pruned.

## Disable

`claude plugin disable branch-owners@ryk-claude-mods`

## Test

```
cd ~/.claude/ryk-claude-mods
claude plugin test branch-owners
claude plugin validate branch-owners
```
