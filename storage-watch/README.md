# storage-watch

Watches free disk space on the macOS data volume (`df -k /System/Volumes/Data`, falling back to `/`) on a timer. It shows it in the status line and alerts once as free space falls through each tier (20, 10, 5, 1 GB), naming the biggest space users. At or below `gateBelowGb` (5 GB by default), **only light commands and cleanup run**, so a session cannot keep filling the disk. The gate lifts by itself on the first check after free space is back above that tier. Nothing is ever deleted by the mod.

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install storage-watch@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install storage-watch --marketplace RyanKim17920/ryk-claude-mods
```

## Options (userConfig)

| Option | Default | What it does |
| --- | --- | --- |
| `tiersGb` | "20,10,5,1" | Alert tiers in GB; each alerts once as space falls through it |
| `intervalSeconds` | 300 | How often free space is read (minimum 5) |
| `cooldownMinutes` | 60 | A tier does not alert again within this time |
| `wakeMainOnAlert` | false | Send one short prompt to the main thread on alert |
| `showStatus` | true | Show the status-line figure |
| `showToasts` | true | Show a toast on alert and on each gate refusal |
| `systemNotifications` | true | Send a macOS notification on alert |
| `gateHeavyWork` | true | Refuse new work at or below `gateBelowGb` |
| `gateMode` | "allowlist" | `allowlist`: only light commands run while gated. `patterns`: the older gate, which refuses only commands matching its built-in heavy-work rules (Docker, builds, installs, downloads, train/eval scripts) |
| `gateBelowGb` | 5 | Gate tier in GB free (at or below) |
| `gateBlockPatterns` | "" | More regexes to refuse while gated, even light commands, separated by ` ;; ` |
| `gateAllowPatterns` | "" | Regexes that always run while gated, separated by ` ;; `. In allowlist mode, this adds commands to the light list |
| `gateLightSubcommands` | "" | Tool subcommands that count as light in allowlist mode, separated by ` ;; `, for example `mytool status ;; mytool list ;; mytool jobs show`. Each entry is a tool and one or two subcommand words; the tool's global flags before them are skipped and any arguments after are allowed. The tool's other subcommands stay refused |

The gate keeps working when all UI options are off.

## The gate

It is the same gate as mem-watch's (`hooks/gate.ts` is shared byte for byte). While gated, the `Agent` tool is refused, and a Bash command runs only if **every** part of it is light. A part is each command of a chain or pipe, each subshell, each `$(...)` (also inside `$(( ))` and `${...}`), each `bash -c`, `eval`, `trap` or `env -S` string, and each `find -exec` or `fd -x` command, with wrappers such as `sudo`, `env`, `time`, `timeout`, `nohup` and `xargs` stripped first. A light name reached by a path (`./bin/ls`), with `PATH`, a pager or an editor changed, or with an option that runs a program (`rg --pre`, `awk 'BEGIN{system(...)}'`, `git -c` with a key that can run a program) is refused, and so is `--help` after a script given to an interpreter. See [mem-watch's README](../mem-watch/README.md#the-gate) for the full rules.

**Cleanup stays allowed at low disk**, since it is how disk is freed: `rm`, `rmdir`, `docker system prune` and every other `docker ... prune`, `docker rm`/`rmi`, `git worktree remove`/`prune`, `git clean`, `brew cleanup`, `npm cache clean`, `pip cache purge`, `uv cache clean`, `conda clean`, `cargo clean`, `hf cache` and `make clean`. Reading and inspecting stay allowed too, including `du` and `df` to find what to delete, and so do small file chores (`mv`, `mkdir`, a single-file `cp`) and everyday git (`add`, `commit`, `push`, `pull`, `checkout`). Downloads (`curl -O`, `wget`, `git clone`, `docker pull`, `hf download`), installs, builds and any script are refused. So is a copy of a whole tree (`cp -r`, `cp -a`, `cp --recursive`, `cp --archive`, `ditto`) and a `curl` whose output is redirected to a file (`curl url > f`; `curl -o` and `wget` are refused by the shared gate already): the shared gate lets `cp` run, since it costs no memory, but storage-watch refuses tree copies in allowlist mode because they are what fills a nearly full disk. Its rule runs on every part the gate reads, so `bash -c 'cp -r a b'` and `find -exec cp -r` are refused too, and `gateAllowPatterns` does not lift it.

The gate runs no `df` per tool call. It reads the last reading the timer stored in the mod's shared store, stamped with the time it was taken. A missing reading, or one older than 3 intervals, fails open. Any error in the gate also lets the call through. Every session sharing the store is gated by the freshest reading. `-p` and SDK runs are gated too.

The model is told that the command was not run and why, with the figure and the gate tier, which part was refused, what still runs, the biggest space users when known, and that the pause lifts by itself.

`hooks/gate.ts` and `hooks/gate.test.ts` are kept byte-identical with mem-watch's copies, because a plugin cannot import a file outside its own folder. `scripts/check-twins.sh` at the repository root fails when they drift apart.

There is no concurrency cap here: that lives only in mem-watch, so the two mods never count the same spawn twice.

## The culprits

On an alert, and while gated, the mod measures the biggest space users and names the top 3 in the alert prompt and in every refusal. It reads `docker system df` (with what pruning would give back) and runs `du -sk` on well-known cache folders under your home folder: `~/Library/Caches`, `~/.cache`, `~/.npm`, `~/.cargo/registry`, Xcode's `DerivedData`, Docker Desktop's disk image, `~/.Trash`, `~/miniconda3/pkgs`, `~/.gradle/caches` and `~/go/pkg/mod`. Each command has a 15 s timeout, and one that runs over drops only its own figure. The result is shared by every session and measured again at most every 30 minutes. Nothing is deleted.

## Disable

`claude plugin disable storage-watch@ryk-claude-mods`. To keep the alerts but drop the gate, set `gateHeavyWork` to false.

## Test

```bash
cd ~/.claude/ryk-claude-mods
claude plugin test storage-watch
claude plugin validate storage-watch
scripts/check-twins.sh
```
