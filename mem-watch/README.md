# mem-watch

Watches macOS free memory (`memory_pressure`) and swap (`sysctl vm.swapusage`) on a timer. It shows them in the status line and alerts once when either crosses its limit, naming the processes and Docker containers using the most memory. It does two things to keep a session from running the Mac out of memory:

- **The gate.** While a limit is crossed, only light commands run: reading, inspecting, small file chores, everyday git, stopping and cleanup. Everything else is refused, and so are new subagents. The gate lifts by itself on the first check after memory recovers.
- **The cap.** Whatever memory says, this session may run at most 4 top-level agents (subagents, and teammates while they work a task) and 3 background jobs at once. This stops a fast fan-out before the next reading would catch it. Subagents that a subagent starts are not capped, and an idle teammate holds no slot.

Nothing is ever stopped or killed by the mod.

## Install

After adding the marketplace (see [Install](../README.md#install) in the main README):

```sh
claude plugin install mem-watch@ryk-claude-mods
```

Or add the marketplace and install in one step:

```sh
claude plugin install mem-watch --marketplace RyanKim17920/ryk-claude-mods
```

## Options (userConfig)

The memory limits (`maxSwapGb` 28, `minFreePercent` 28) were tuned on a 24 GB Mac. Adjust them for your machine: see **Why 28%** below.

| Option | Default | What it does |
| --- | --- | --- |
| `minFreePercent` | 28 | Over the limit when free memory is below this % |
| `maxSwapGb` | 28 | Over the limit when swap in use is above this many GB |
| `intervalSeconds` | 60 | How often memory is read (minimum 5) |
| `cooldownMinutes` | 30 | At most one alert per this many minutes |
| `wakeMainOnAlert` | true | Send one prompt to the main thread on alert (interactive sessions only) |
| `showStatus` | true | Show the status-line figure |
| `showToasts` | true | Show a toast on alert and on each gate refusal |
| `systemNotifications` | true | Send a macOS notification on alert |
| `gateHeavyWork` | true | Refuse new work while over a limit |
| `gateMode` | "allowlist" | `allowlist`: only light commands run while gated. `patterns`: the older gate, which refuses only commands matching its built-in heavy-work rules (Docker, builds, installs, downloads, train/eval scripts) |
| `gateBlockPatterns` | "" | More regexes to refuse while gated, even light commands, separated by ` ;; ` |
| `gateAllowPatterns` | "" | Regexes that always run while gated, separated by ` ;; `. In allowlist mode, this adds commands to the light list |
| `gateLightSubcommands` | "" | Tool subcommands that count as light in allowlist mode, separated by ` ;; `, for example `mytool status ;; mytool list ;; mytool jobs show`. Each entry is a tool and one or two subcommand words; the tool's global flags before them are skipped and any arguments after are allowed. The tool's other subcommands stay refused |
| `maxConcurrentAgents` | 4 | Most top-level agents (subagents and working teammates started by the main thread) this session runs at once; a subagent's or teammate's own children are never capped. 0 turns the cap off |
| `capTeammates` | true | Count teammates against `maxConcurrentAgents` while they work a task, and cap new teammate spawns. False exempts teammates entirely, as the cap used to |
| `maxBackgroundJobs` | 3 | Most `run_in_background` Bash jobs this session runs at once; 0 turns the cap off |
| `backgroundJobExpiryMinutes` | 30 | A background job whose finish is never seen stops counting after this long |

The gate and the cap keep working when all UI options are off.

**Why 28%.** `minFreePercent` reads `memory_pressure`'s "System-wide memory free percentage", the same figure as `sysctl kern.memorystatus_level`: memory that is free or can be reclaimed at once, not the tiny `Pages free` count in `vm_stat`. On the 24 GB Mac this was built on, normal work reads 34-60% (mostly 40-45%), so 28% sits below every normal reading and is crossed only when something large is running. The allowlist gate is stricter than the patterns gate, but since routine work (git, file chores, `gh`, short `python -c`) stays light, the default was kept.

## The gate

While over a limit, the `Agent` tool is refused, and a Bash command runs only if **every** part of it is light. A part is each command of a chain (`&&`, `||`, `;`, `|`, `&`, newlines), each subshell or `{ ...; }` group, each command substitution (`$(...)`, backticks, `<(...)`, including those inside `$(( ))`, `(( ))` and `${...}`), the string of a `bash -c`, `eval`, `trap` or `env -S`, the value of an `alias`, and the command of a `find -exec` or `fd -x`. Prefixes that only wrap a command are stripped first: assignments (`FOO=1`), redirections, `sudo`, `env`, `time`, `timeout`, `nice`, `nohup`, `setsid`, `caffeinate`, `xargs` and `command`. Quoted text, heredoc bodies and the pattern words of a `case` branch are data, never commands. A `$(...)` ends where bash ends it: a `)` in quotes, in a comment or in a heredoc body does not close it, so the usual `git commit -m "$(cat <<'EOF' ... EOF )"` reads the same whatever the message holds (`1)`, `:)`, `(y`, quotes, backticks). A `bash <<EOF` or `python - <<EOF` script is refused, since it runs code the gate cannot read.

**Light** means:

- **Reading and inspecting:** `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `fd`, `wc`, `sort`, `jq`, `awk`, `sed`, `diff`, `ps`, `top`, `vm_stat`, `memory_pressure`, `df`, `du`, `free`, `lsof`, `which`, `echo`, `pwd`, `sleep`, `wait` and the like, and shell builtins that run nothing (`cd`, `export`, `read`, `break`, `continue`, `let`, `getopts`). Also `git status`/`log`/`diff`/`show`/`branch` and other read-only git, `docker ps`/`stats`/`images`/`logs`/`inspect`/`system df`, `docker compose ps`/`logs`, `gh pr view`/`list`/`checks`, `gh run view`/`watch`, `gh api`, `pip list`, `tar t` (listing), a short `python3 -c` program (300 characters at most, importing only safe standard modules such as `json`, `sys`, `os`, `re`, `pathlib`, `collections`, `datetime` and `csv`, and calling no `exec(`, `eval(`, `compile(`, `__import__(`, `subprocess` or `os.system`/`popen`/`exec*`/`spawn*`), and `curl` when it saves no file.
- **Small file chores and everyday git:** `cp`, `mv`, `mkdir`, `touch`, `ln`, `chmod`, `open`; `git add`/`commit`/`stash`/`checkout`/`switch`/`restore`/`fetch`/`pull`/`push`/`merge`/`rebase`/`reset`/`tag`/`worktree add`; `gh pr create`/`comment`/`merge`, `gh issue create`/`comment`. A commit, checkout or merge can run the repository's own git hooks, and a pre-commit hook may run tests. That is allowed on purpose: refusing every commit while memory is tight costs more than the occasional hook.
- **Stopping and cleanup:** `kill`, `pkill`, `killall`, `rm`, `rmdir`, `docker stop`/`kill`/`rm`/`rmi` and every `prune`, `docker compose down`/`stop`, `git worktree remove`/`prune`, `git clean`, `tmux kill-session`, `screen -X quit`, `gh run cancel`, `brew cleanup`, `npm cache clean`, `pip cache purge`, `uv cache clean`, `conda clean`, `cargo clean`, `make clean` and `make -n`.
- **Help:** `--help` or `--version` as the last word after plain subcommand words (`docker compose up --help`), or `-h` as the only argument (`make -h`). The command must be a bare name. A shell, interpreter or runner counts only when asked for nothing else: `python3 --version`, `node -v`, `bash --help` and `python3 -m pip --version` run, but `./train.sh --help`, `sh train --version`, `node train --help` and `npx pkg --help` run the script, so they are refused. A short flag counts only where it means help or version (`python3 -V`, `node -v`, `perl -v`): a shell's `-h` or `-v` and python's `-v` set a mode and then run the script on stdin, so `bash -v <<EOF` is refused. `docker run img --help` and `docker run img -h` hand the flag to the image, so they are refused too.

Everything else is refused. That includes any script (`./run.sh`, `python train.py`, `python -m train`), builds, installs, downloads, `docker run`/`exec`/`build`/`pull`, `git clone`, and test runs.

A light name is not light when it is made to run something else:

- **By path:** a light name counts only as a bare name or from `/bin`, `/usr/bin`, `/sbin`, `/usr/sbin` or `/opt/homebrew/bin`. `./bin/ls` or a `/tmp/cat` symlinked to `make` is refused.
- **By assignment:** setting `PATH`, `GIT_*`, `LESSOPEN`, `LESS`, any `*PAGER`, `EDITOR`, `VISUAL`, `BASH_ENV`, `ENV`, `DYLD_*` or `LD_*` refuses the segment (as a prefix, through `env`, `export` or a bare assignment), unless the value is inert: empty, a number, `cat`, `less`, `more`, `true`, `false` or flags only (`LESS='-R -F'`). A `PATH` is inert too when every `:` part starts with `/`, `~`, `$HOME` or `${HOME}`, or is `$PATH` itself; a relative or empty part (the working folder) is not. So `GIT_PAGER=cat git log`, `GIT_TERMINAL_PROMPT=0 git fetch` and `export PATH="$HOME/.local/bin:$PATH"` run, and `GIT_EXTERNAL_DIFF=./x git diff` and `PATH=bin:$PATH ls` do not.
- **By an option that runs a program:** `awk` with `system(`, a `|` pipe (a `|` inside a string or regular expression is text) or a program file; `rg --pre`; `sort --compress-program`; `sed` with an `e` command or `s///e`, or a script file; `git -c` with any key but `user.*`, `color.*`, `advice.*`, `log.*`, `format.*`, `core.quotepath`, `safe.directory`, `init.defaultBranch`, `commit.gpgsign` and `core.pager=cat|less` (and never a `*.cmd` or `*.command` key), `--config-env`, `--exec-path=` and `git grep -O`; `hash -p`; `less +!cmd`; `tar` with `--to-command` or `-I`.

These rules close the bypasses a model could hit by accident or by rewording a refused command. The gate is a guard rail against an over-eager model, not a security boundary against someone trying to beat it. No list of heavy names can be slipped past by renaming a script or wrapping Docker in a shell script. The tables are `LIGHT` and `LIGHT_SUBCOMMANDS` in `hooks/gate.ts`. Add your own light commands with `gateAllowPatterns`, or light subcommands of your own tools with `gateLightSubcommands`.

Running in the background (`cmd &`, `run_in_background`) is never a reason to refuse on its own. The cap handles that.

The gate runs no command per tool call. It reads the last reading the timer stored in the mod's shared store, stamped with the time it was taken. A missing reading, or one older than 3 intervals, fails open. That covers machines other than macOS, which give no reading. Any error in the gate also lets the call through. Every session sharing the store is gated by the freshest reading. `-p` and SDK runs are gated too.

The model is told that the command was not run and why, with the figure and the limit, which part was refused, and what still runs. When known, it also gets the largest memory users, and is told the pause lifts by itself and not to reword the command to get past it.

`hooks/gate.ts` and `hooks/gate.test.ts` are kept byte-identical with storage-watch's copies, because a plugin cannot import a file outside its own folder. `scripts/check-twins.sh` at the repository root fails when they drift apart.

## The culprits

While over a limit, each check also records the 3 largest processes by resident memory (`ps`), and the 3 largest running containers (`docker stats --no-stream`, 5 s timeout; skipped when Docker is not running). Each session reuses another session's record taken in the same interval. The alert prompt, its toast and every refusal name them, for example `python3 (pid 4242) 9.0 GB; container web 1.5GiB`. Nothing is stopped.

## The cap

The cap holds whatever the reading says. It is separate from the gate and lives only in mem-watch, so the two mods never count the same spawn twice.

- **Subagents** are counted when each one is about to start (`agent.spawn`), from the engine's own list of this session's agents (`$.agent.list()`): the top-level ones (no `parentId`, so the main thread started them) that are `running` or `pending`, plus spawns this mod let through that are still starting. Spawns made together therefore count each other. A finished agent leaves the list, so a finish is never missed. A subagent's own children never count and are never refused by the cap (the spawn carries a `parentAgentId`): refusing one would stall its parent, and the parent already holds the slot. The memory gate still refuses them while memory is low. A workflow script's agents are not capped, and a running workflow agent holds no slot: the engine lists it like the main thread's own, so its id is recorded when it starts and left out of the count. If the list cannot be read, the cap is skipped. The list and the job record are this session's own, so every session has its own quota.
- **Teammates** (with `teammateMode` on, every named Agent spawn is one) are capped like subagents: a new teammate from the main thread is refused past the cap, and a teammate holds a slot while it works. Teammates are long-lived and wait idle between tasks, so an idle one holds no slot; otherwise a team would fill the cap for good. The engine's `taskStatus` cannot tell them apart (a teammate's task stays `running` between turns), so the cap reads the loop's `status`: `idle` while it waits for a message, and `running`, `pending` or `waiting` (held on its own background work or a plan's approval) while it has a task in hand. A teammate the list gives no known status for holds no slot. Its own children are never capped, and a teammate brought back from disk on a resume is not refused. A teammate in a terminal pane of its own reports its status through the team roster, and a pane that dies mid-turn leaves `running` standing; if that ever holds a slot for good, stop the teammate or set `capTeammates` to false.
- **Why 4.** The complaint the cap answers is runaway fan-out from the main thread. Four top-level agents allows a normal parallel split of a task (and each agent may delegate further) while stopping a burst of a dozen; the memory gate is the backstop for what those agents run.
- **Background jobs** are Bash calls with `run_in_background`. A job is recorded when its call returns a background task id. Commands moved to the background by Ctrl+B or a timeout are recorded too. A job stops counting when any of these happens:
  - its task notification arrives, in any loop's conversation;
  - it is stopped with `TaskStop`;
  - the end-of-turn `Stop` hook's list of background work in flight no longer has it (a job recorded in the 10 s before the hook is kept, since the list may have been taken before it started);
  - failing all of those, after `backgroundJobExpiryMinutes`.

  A lost finish therefore holds a slot for at most that long. Foreground commands are never capped, and neither is a `cmd &` inside a foreground command.

A refusal names what is running and says to wait, stop one with `TaskStop`, or (for a job) run it in the foreground.

## Disable

`claude plugin disable mem-watch@ryk-claude-mods`. To keep the alerts but drop the gate, set `gateHeavyWork` to false. To drop the cap, set `maxConcurrentAgents` and `maxBackgroundJobs` to 0.

## Test

```bash
cd ~/.claude/ryk-claude-mods
claude plugin test mem-watch
claude plugin validate mem-watch
scripts/check-twins.sh
```
