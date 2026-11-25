/**
 * The work gate, shared by two standalone mods that cannot import from each other (a plugin may not
 * import a file outside its own folder). This file is kept byte-identical in BOTH of:
 *   mem-watch/hooks/gate.ts
 *   storage-watch/hooks/gate.ts
 * and so is its test, `gate.test.ts`. Change one, copy it over the other, and run
 * `scripts/check-twins.sh` (it `cmp`s every pair).
 *
 * Pure logic only: which Bash commands may run while a limit is crossed, how fresh a stored reading
 * must be, and the refusal the model reads.
 *
 * Two modes:
 * - `allowlist` (the default): while gated, a Bash command runs only if EVERY simple command in it
 *   (each part of a chain, pipe, subshell, `$(...)`, `bash -c` string) is light: reading and
 *   inspecting, stopping and cleaning up, or `--help`/`--version`. Everything else is refused, so a
 *   renamed script, a `run.sh` that wraps Docker or a rewritten command cannot slip past a list.
 * - `patterns` (the old gate): only commands that match a heavy-work rule are refused.
 */

export type GateMode = 'allowlist' | 'patterns'

/** The `gateMode` option: `patterns`, else `allowlist`. */
export function parseMode(value: unknown): GateMode {
  return value === 'patterns' ? 'patterns' : 'allowlist'
}

/**
 * `docker compose` (or `docker-compose`, podman's) and its global flags, up to the subcommand:
 * `docker compose -f ci.yml up` reads `up` as the subcommand, `cat docker-compose.yml` never starts one.
 */
const COMPOSE = String.raw`^(?:docker|podman)[\s-]compose(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+`

/** One heavy-work rule, matched against a normalized command segment (wrappers stripped, words joined by one space). */
export type HeavyRule = { readonly name: string; readonly pattern: RegExp }

/** Training and evaluation words a script or module name may start with, and words that say it only reports or tidies. */
const TRAIN_WORD = String.raw`(?:run[-_])?(?:train|eval|finetune|fine[-_]tune|benchmark|sweep)(?![^\s/.]*(?:report|summar|print|plot|stat|clean|util|help|list|show|view|inspect|check|config))`

/**
 * Bash commands that start heavy work, for `patterns` mode. Every pattern is anchored at the start of
 * a segment, so `cat docker-compose.yml`, `grep make` and `echo "docker run"` never match.
 */
export const HEAVY_RULES: readonly HeavyRule[] = [
  { name: 'docker run', pattern: /^(?:docker|podman)\s+(?:container\s+)?(?:run|create)\b/ },
  { name: 'docker compose up', pattern: new RegExp(`${COMPOSE}(?:up|run|build|create|start|restart|pull)\\b`) },
  { name: 'docker build', pattern: /^(?:docker|podman)\s+(?:(?:image|buildx)\s+)?build\b/ },
  { name: 'docker pull', pattern: /^(?:docker|podman)\s+(?:image\s+)?pull\b/ },
  // A script named for training or evaluation: `train_model.py`, `scripts/run_eval.py`. The word must
  // START the file's basename (after an optional `run_`), so `print_eval_summary.py` runs. A name that
  // also says it only reports or tidies (`eval_report.py`, `sweep_cleanup.py`) runs too.
  {
    name: 'train/eval script',
    pattern: new RegExp(String.raw`^(?=\S*[./])(?:\S*[/.])?${TRAIN_WORD}[^\s/.]*(?:\.(?:py|sh|bash|zsh|js|mjs|ts))?(?=\s|$)`, 'i'),
  },
  { name: 'pytest -n (xdist)', pattern: /^py\.?test\b.*\s(?:-n\s*\S+|--numprocesses\b|-p\s+xdist\b|--dist\b)/ },
  { name: 'make', pattern: /^g?make\b(?!.*\s(?:clean|help|-n|--dry-run)\b)/ },
  { name: 'npm/pnpm build', pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/ },
  { name: 'cargo build', pattern: /^cargo\s+(?:build|install)\b/ },
  { name: 'pip/uv install', pattern: /^(?:pip3?|uv\s+pip|uv\s+tool|uv|poetry|conda|mamba)\s+(?:install|sync|add)\b/ },
  { name: 'curl download', pattern: /^curl\b.*\s(?:-[A-Za-z]*O|--remote-name|-[A-Za-z]*o\s+(?!\/dev\/null\b)|--output\s+(?!\/dev\/null\b))/ },
  { name: 'wget', pattern: /^wget\b/ },
  { name: 'huggingface download', pattern: /^(?:huggingface-cli|hf)\s+download\b/ },
  { name: 'git clone', pattern: /^git\s+(?:-\S+\s+)*clone\b/ },
]

/** `python -m pkg.train`: the module's last part starts with a training or evaluation word. */
const TRAIN_MODULE = new RegExp(String.raw`^(?:\S*\.)?${TRAIN_WORD}[^\s.]*$`, 'i')

/**
 * A detached `screen` or `tmux` session. In `patterns` mode it is refused only when the command it
 * launches is heavy by the rules above.
 */
const DETACHED_SESSION = /^screen\b.*\s-d\s*-?m|^tmux\s+new(?:-session)?\b.*\s-d\b/

/** Subcommands after which the next word is what runs (`docker run IMG`, `uv run SCRIPT`, `python -m MOD`). */
const LAUNCHERS = new Set(['run', 'exec', 'x', 'dlx', 'create', 'start', '-m', '-c'])

/**
 * Heads that run the script or package they are handed, so `sh train --help` or `npx pkg --help` runs
 * code: never help, whatever follows.
 */
const RUNS_SCRIPT = /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|node|nodejs|python[\d.]*|pypy[\d.]*|ruby|perl|php|lua|Rscript|osascript|java|tsx|ts-node|npx|pnpx|uvx|bunx|pipx|deno|bun|source|\.)$/

/**
 * The short flags that print an interpreter's help or version and exit, by interpreter. A shell's `-h`
 * and `-v` and python's `-v` are modes, after which it runs the script on its stdin, so they are not here.
 */
const INTERPRETER_SHORT_HELP: readonly (readonly [RegExp, ReadonlySet<string>])[] = [
  [/^(?:python|pypy)[\d.]*$/, new Set(['-V', '-h'])],
  [/^(?:node|nodejs|bun|ruby|php)$/, new Set(['-v', '-h'])],
  [/^perl$/, new Set(['-v', '-V', '-h'])],
  [/^deno$/, new Set(['-V', '-h'])],
]

/**
 * Whether an interpreter, shell or runner is only asked for its own help or version: `python3 --version`,
 * `node -v`, `bash --help`, `python3 -m pip --version`. Never with a script or module it would run.
 */
function isInterpreterHelp(words: readonly string[]): boolean {
  const [head = '', flag = ''] = words
  // `source` and `.` read a file, the flag included, and print no help of their own.
  if (head === 'source' || head === '.') {
    return false
  }
  if (words.length === 4 && /^(?:python|pypy)[\d.]*$/.test(head) && flag === '-m' && words[2] === 'pip') {
    return isInterpreterHelp([head, words[3] ?? ''])
  }
  const short = INTERPRETER_SHORT_HELP.find(([heads]) => heads.test(head))?.[1]

  return words.length === 2 && (flag === '--help' || flag === '--version' || (short?.has(flag) ?? false))
}

/**
 * Whether a segment only prints help or a version. The head must be a bare name (not `./train.sh`,
 * not `/tmp/cat`). One that runs a script it is handed (`sh`, `node`, `npx`) counts only when asked for
 * nothing else (`isInterpreterHelp`). For any other, `--help` or
 * `--version` must be the LAST word and follow only plain subcommand words (`docker compose up --help`),
 * none of them what a launcher runs: `docker run img --help` passes `--help` to the image, so it is not
 * help. `-h` counts only as the one argument (`make -h`): `docker run -h host img` names a host and
 * `docker run img -h` runs the image.
 */
export function isHelp(words: readonly string[]): boolean {
  const head = words[0] ?? ''
  if (head.includes('/')) {
    return false
  }
  if (RUNS_SCRIPT.test(head)) {
    return isInterpreterHelp(words)
  }
  if (words.length === 2 && words[1] === '-h') {
    return true
  }
  const last = words.at(-1) ?? ''
  if (words.length < 2 || (last !== '--help' && last !== '--version')) {
    return false
  }
  const between = words.slice(1, -1)

  return between.length <= 3 && between.every((word, i) => /^[a-z][a-z0-9-]*$/.test(word) && !(i > 0 && LAUNCHERS.has(between[i - 1] ?? '')))
}

/** A reading older than this many check intervals is stale, and a stale reading gates nothing. */
export const STALE_INTERVALS = 3

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const NONE: ReadonlySet<string> = new Set()
/** Words that only wrap the command after them, each with the flags of its own that take a value. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D'])],
  ['env', new Set(['-u', '-C', '-S', '-P'])],
  ['nice', new Set(['-n'])],
  ['timeout', new Set(['-s', '-k'])],
  ['gtimeout', new Set(['-s', '-k'])],
  ['caffeinate', new Set(['-t', '-w'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['xargs', new Set(['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-J', '-R', '-S'])],
  ...['time', 'exec', 'builtin', 'noglob', 'nohup', 'setsid'].map(word => [word, NONE] as const),
  // Shell keywords that lead a command: `do make` in a loop runs `make`.
  ...['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!'].map(word => [word, NONE] as const),
])
/** Flags of a runner (`uv run`) or interpreter that take the next word as their value. */
const RUNNER_VALUED = new Set(['--with', '--project', '--directory', '--python', '-p', '--package', '--env-file', '--extra', '--group', '--index', '--from'])
const PYTHON_VALUED = new Set(['-X', '-W'])
const SHELL_VALUED = new Set(['-o', '-O'])
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
/** A word that is only a redirection: `2>&1`, `>out`, `<in`, `&>log`, or a bare `>`. */
const REDIRECTION = /^(?:\d*|&)(?:>>?|<|>&|<&|>\|)/
const PYTHON = /^(?:\S*\/)?python(?:\d+(?:\.\d+)?)?$/

/** A word of a command line, with the command substitutions (`$(...)`, backticks, `<(...)`) it holds, unquoted or in double quotes. */
type Token = { word: string; subs: string[] } | { op: string }

/** A heredoc start, `<<EOF`, `<<-EOF`, `<< 'EOF'` or `<<"EOF"`, but not a `<<<` here-string. */
const HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z0-9_.-]+)\2/y

/** The heredoc that starts at `i` (not inside a `<<<`), or null. Matched in place, so a long line is never copied. */
function heredocAt(command: string, i: number): RegExpExecArray | null {
  if (command[i - 1] === '<') {
    return null
  }
  HEREDOC.lastIndex = i

  return HEREDOC.exec(command)
}

type Heredoc = { delimiter: string; stripTabs: boolean }

/** From the newline at `at`, skips each pending heredoc body through its terminator line; returns where it ended. */
function skipHeredocBodies(command: string, at: number, heredocs: Heredoc[]): number {
  let end = at
  for (const { delimiter, stripTabs } of heredocs) {
    while (end < command.length) {
      const next = command.indexOf('\n', end + 1)
      const lineEnd = next === -1 ? command.length : next
      const line = command.slice(end + 1, lineEnd)
      end = lineEnd
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        break
      }
    }
  }
  heredocs.length = 0

  return end
}

/** From a backtick at `open`, the index of the backtick that closes it (or the end); `\`` does not. */
function backtickEnd(command: string, open: number): number {
  for (let j = open + 1; j < command.length; j++) {
    if (command[j] === '\\') {
      j++
    } else if (command[j] === '`') {
      return j
    }
  }

  return command.length
}

/** What a substitution's reader is inside: the substitution itself (with its open parentheses), a double-quoted string or backticks. */
type Frame = { kind: 'sub'; depth: number } | { kind: 'quote' } | { kind: 'backtick' }

/**
 * From the `(` of a `$(`, `<(` or `>(` at `open`, the index of the `)` that closes it (or the end), found
 * the way bash finds it: a `)` in quotes, after a backslash, in a comment or in a heredoc body does not
 * close it, and a nested substitution closes its own first. So a commit message in
 * `"$(cat <<'EOF' ... 1) it's (y ... EOF\n)"` ends at the last `)`. One pass with a stack of what it is
 * inside, so a deep nesting costs no recursion.
 */
function substitutionEnd(command: string, open: number): number {
  const stack: Frame[] = [{ kind: 'sub', depth: 0 }]
  const heredocs: Heredoc[] = []
  for (let j = open + 1; j < command.length; j++) {
    const c = command[j]
    const frame = stack[stack.length - 1] ?? { kind: 'sub', depth: 0 }
    if (c === '\\') {
      j++
    } else if (frame.kind === 'backtick') {
      stack.length -= c === '`' ? 1 : 0
    } else if (c === '`') {
      stack.push({ kind: 'backtick' })
    } else if (c === '$' && command[j + 1] === '(') {
      stack.push({ kind: 'sub', depth: 0 })
      j++
    } else if (frame.kind === 'quote') {
      stack.length -= c === '"' ? 1 : 0
    } else if (c === '"') {
      stack.push({ kind: 'quote' })
    } else if (c === "'") {
      const end = command.indexOf("'", j + 1)
      j = end === -1 ? command.length : end
    } else if (c === '(') {
      frame.depth++
    } else if (c === ')' && frame.depth > 0) {
      frame.depth--
    } else if (c === ')') {
      stack.pop()
      if (stack.length === 0) {
        return j
      }
    } else if (c === '#' && (j === open + 1 || /[\s;&|()]/.test(command[j - 1] ?? ''))) {
      // A comment runs to the end of its line; the newline is read next.
      const next = command.indexOf('\n', j)
      j = (next === -1 ? command.length : next) - 1
    } else if (c === '\n' && heredocs.length > 0) {
      j = skipHeredocBodies(command, j, heredocs)
    } else if (c === '<') {
      const heredoc = heredocAt(command, j)
      if (heredoc !== null) {
        heredocs.push({ delimiter: heredoc[3] ?? '', stripTabs: heredoc[1] === '-' })
        j += heredoc[0].length - 1
      }
    }
  }

  return command.length
}

/**
 * For each `(` in a command, the index of the `)` that matches it by plain counting (quotes are not
 * read), or -1. Built once per line so every `((` is judged in constant time.
 */
function parenMatches(command: string): Int32Array {
  const matches = new Int32Array(command.length).fill(-1)
  const open: number[] = []
  for (let j = 0; j < command.length; j++) {
    if (command[j] === '(') {
      open.push(j)
    } else if (command[j] === ')' && open.length > 0) {
      matches[open.pop() ?? 0] = j
    }
  }

  return matches
}

/**
 * Where an arithmetic command `(( ... ))` that opens at `i` ends (the index of its last `)`), or -1
 * when the `((` opens two subshells instead (`((cd a) && b)`), as bash itself decides: the inner `(`
 * must close right before the outer one does.
 */
function arithmeticEnd(command: string, i: number, matches: Int32Array): number {
  const inner = matches[i + 1] ?? -1

  return inner !== -1 && command[inner + 1] === ')' ? inner + 1 : -1
}

/**
 * The command substitutions (`$(...)`, backticks) in text the shell expands but does not run as a
 * command: an arithmetic body (`$(( $(a) + 1 ))`, `(( n = $(a) ))`) or a `${...}` (`${x:-$(a)}`).
 */
function innerSubstitutions(text: string): string[] {
  const found: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
    } else if (text[i] === '`') {
      const end = backtickEnd(text, i)
      found.push(text.slice(i + 1, end))
      i = end
    } else if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] === '(') {
      // `$((...))` nested inside: its body is more arithmetic, read on in this same pass.
      i += 2
    } else if (text[i] === '$' && text[i + 1] === '(') {
      const end = substitutionEnd(text, i + 1)
      found.push(text.slice(i + 2, end))
      i = end
    }
  }

  return found
}

/** From the `$` of a `${` at `i`, the index of the `}` that closes it (or the end), counting nested braces. */
function braceEnd(command: string, i: number): number {
  let depth = 0
  for (let j = i + 1; j < command.length; j++) {
    if (command[j] === '\\') {
      j++
    } else if (command[j] === '{') {
      depth++
    } else if (command[j] === '}' && --depth === 0) {
      return j
    }
  }

  return command.length
}

/**
 * Splits a shell command into words and control operators, honouring quotes and escapes, so the
 * contents of a quoted string are never read as a command. A command substitution (`$(...)`,
 * backticks, `<(...)`, `>(...)`) stays inside its word and is also recorded on it, so its command
 * is judged too; one inside single quotes is text and is not. A heredoc body is data, so it is skipped:
 * in `cat > x.sh <<'EOF'` only `cat` is read. An arithmetic command `(( x = 1 << 2 ))` and a `${...}`
 * are each read as a whole, so a `<<` inside one never opens a heredoc that would hide the lines after
 * it; the substitutions inside them are recorded all the same. `;;` (and `;&`, `;;&`) ending a `case`
 * branch is one operator.
 */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let subs: string[] = []
  let hasWord = false
  /** Heredocs opened on the current line, whose bodies start after its newline. */
  const heredocs: Heredoc[] = []
  const flush = (): void => {
    if (hasWord) {
      tokens.push({ word, subs })
    }
    word = ''
    subs = []
    hasWord = false
  }
  const skipHeredocs = (at: number): number => skipHeredocBodies(command, at, heredocs)
  /** The `)` matching each `(`, built the first time a `((` is met. */
  let matches: Int32Array | null = null
  const arithmetic = (i: number): number => {
    matches ??= parenMatches(command)

    return arithmeticEnd(command, i, matches)
  }
  /** A substitution opening at `i` (`$(`, a backtick, `<(` or `>(`): records its command, returns where it closes. */
  const substitution = (i: number): number => {
    const isBacktick = command[i] === '`'
    const end = isBacktick ? backtickEnd(command, i) : substitutionEnd(command, i + 1)
    const inner = command.slice(isBacktick ? i + 1 : i + 2, end)
    // `$((...))` is arithmetic, not a command, but a substitution inside it runs.
    subs.push(...(command[i] === '$' && command[i + 2] === '(' ? innerSubstitutions(inner) : [inner]))
    word += command.slice(i, end + 1)
    hasWord = true

    return end
  }
  /** A `${...}` opening at `i`: kept whole in its word, its substitutions recorded; returns where it closes. */
  const parameter = (i: number): number => {
    const end = braceEnd(command, i)
    subs.push(...innerSubstitutions(command.slice(i + 2, end)))
    word += command.slice(i, end + 1)
    hasWord = true

    return end
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    const ahead = command[i + 1] ?? ''
    const heredoc = c === '<' ? heredocAt(command, i) : null
    if (heredoc !== null) {
      flush()
      heredocs.push({ delimiter: heredoc[3] ?? '', stripTabs: heredoc[1] === '-' })
      i += heredoc[0].length - 1
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end === -1 ? command.length : end)
      hasWord = true
      i = end === -1 ? command.length : end
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if ((command[i] === '$' && command[i + 1] === '(') || command[i] === '`') {
          i = substitution(i) + 1
          continue
        }
        if (command[i] === '$' && command[i + 1] === '{') {
          i = parameter(i) + 1
          continue
        }
        word += command[i] === '\\' && i + 1 < command.length ? command[++i] : command[i]
        i++
      }
      hasWord = true
    } else if (c === '\\') {
      word += ahead
      hasWord = true
      i++
    } else if ((c === '$' && ahead === '(') || c === '`' || ((c === '<' || c === '>') && ahead === '(')) {
      i = substitution(i)
    } else if (c === '$' && ahead === '{') {
      i = parameter(i)
    } else if (c === '(' && ahead === '(' && !hasWord && arithmetic(i) !== -1) {
      flush()
      const end = arithmetic(i)
      const inner = command.slice(i, end + 1)
      tokens.push({ word: inner, subs: innerSubstitutions(inner.slice(2, -2)) })
      i = end
    } else if (c === ';' && (ahead === ';' || ahead === '&')) {
      // `;;`, `;&` or `;;&`: the end of a `case` branch.
      flush()
      const length = ahead === ';' && command[i + 2] === '&' ? 3 : 2
      tokens.push({ op: command.slice(i, i + length) })
      i += length - 1
    } else if (c === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') {
        i++
      }
      flush()
      tokens.push({ op: '\n' })
      i = skipHeredocs(i)
    } else if (/\s/.test(c) && c !== '\n') {
      flush()
    } else if (c === '&' && (/[<>]$/.test(word) || ahead === '>')) {
      // A redirection (`2>&1`, `&>file`), not a background or `&&`.
      word += c
      hasWord = true
    } else if (c === '\n' || c === ';' || c === '(' || c === ')' || (c === '{' && !hasWord && /\s/.test(ahead)) || (c === '}' && !hasWord)) {
      flush()
      tokens.push({ op: c })
      i = c === '\n' ? skipHeredocs(i) : i
    } else if (c === '&' || c === '|') {
      flush()
      const isDouble = ahead === c || (c === '|' && ahead === '&')
      tokens.push({ op: isDouble ? c + ahead : c })
      i += isDouble ? 1 : 0
    } else {
      word += c
      hasWord = true
    }
  }
  flush()

  return tokens
}

/** A command line read whole: its simple commands, each as its words, and the commands its substitutions run. */
export type Parsed = { segments: string[][]; substitutions: string[] }

/** The operators that end a `case` branch, after which the next branch's patterns come. */
const CASE_BRANCH_END = new Set([';;', ';&', ';;&'])

/**
 * Splits a command line into its simple commands. In a `case`, the pattern words of each branch (from
 * `in` or a branch's `;;` through its `)`) are matched, not run, so they are left out: in
 * `case $x in a) ls;; b) pwd;; esac` only `ls` and `pwd` run. A substitution in a pattern still runs.
 */
export function parse(command: string): Parsed {
  const segments: string[][] = []
  const substitutions: string[] = []
  let words: string[] = []
  /** How many `case`s are open, and whether a branch's patterns are being read. */
  let cases = 0
  let isPattern = false
  const end = (): void => {
    if (words.length > 0) {
      segments.push(words)
    }
    words = []
  }
  for (const token of tokenize(command)) {
    if (isPattern) {
      if ('word' in token && token.word === 'esac') {
        cases--
        isPattern = false
      } else {
        substitutions.push(...('word' in token ? token.subs : []))
        isPattern = !('op' in token && token.op === ')')
        continue
      }
    }
    if ('word' in token) {
      words.push(token.word)
      substitutions.push(...token.subs)
      if (token.word === 'in' && words.length === 3 && words[0] === 'case') {
        end()
        cases++
        isPattern = true
      }
      continue
    }
    end()
    isPattern = cases > 0 && CASE_BRANCH_END.has(token.op)
  }
  if (words.length > 0) {
    segments.push(words)
  }

  return { segments, substitutions }
}

/** The simple commands of a command line, each as its words. */
export function segments(command: string): string[][] {
  return parse(command).segments
}

/** Drops a leading word's own flags (and the value of a flag that takes one). */
function dropFlags(words: readonly string[], from: number, valued: ReadonlySet<string>): string[] {
  let i = from
  while (i < words.length && /^-/.test(words[i] ?? '')) {
    i += valued.has(words[i] ?? '') ? 2 : 1
  }
  // `timeout 30 cmd`, `nice -n 5 cmd` without a dash: a bare duration or number.
  if (/^\d+(?:\.\d+)?[smhd]?$/.test(words[i] ?? '')) {
    i++
  }

  return words.slice(i)
}

/**
 * `env`'s words after its own flags. `-S`/`--split-string` hands it a whole command line as one
 * value, which is split into the words it runs: `env -S 'make -j8'` runs `make -j8`.
 */
function envCommand(words: readonly string[]): string[] {
  const split = (line: string): string[] => tokenize(line).flatMap(token => ('word' in token ? [token.word] : []))
  let i = 1
  while (i < words.length && /^-/.test(words[i] ?? '')) {
    const word = words[i] ?? ''
    if (word === '--') {
      return words.slice(i + 1)
    }
    if (word === '-S' || word === '--split-string') {
      return [...split(words[i + 1] ?? ''), ...words.slice(i + 2)]
    }
    const joined = /^(?:-S|--split-string=)(.+)$/s.exec(word)
    if (joined !== null) {
      return [...split(joined[1] ?? ''), ...words.slice(i + 1)]
    }
    i += WRAPPERS.get('env')?.has(word) === true ? 2 : 1
  }

  return words.slice(i)
}

/** A segment unwrapped, with every `NAME=value` it set on the way (`FOO=1 make`, `env PATH=x ls`). */
function unwrapAll(words: readonly string[]): { command: string[]; assigned: string[] } {
  let rest = [...words]
  const assigned: string[] = []
  for (let guard = 0; guard < 12 && rest.length > 0; guard++) {
    // `/usr/bin/env` and `/usr/bin/time` wrap like `env` and `time`.
    const head = TRUSTED_PATH.test(rest[0] ?? '') ? basename(rest[0] ?? '') : rest[0] ?? ''
    if (ASSIGNMENT.test(head) || REDIRECTION.test(head)) {
      assigned.push(...(ASSIGNMENT.test(head) ? [head] : []))
      // A bare `>` or `<` takes the next word as its file.
      rest = rest.slice(/^(?:\d*|&)[<>]+[&|]?$/.test(head) ? 2 : 1)
    } else if (head === 'env') {
      rest = envCommand(rest)
    } else if (WRAPPERS.has(head)) {
      rest = dropFlags(rest, 1, WRAPPERS.get(head) ?? NONE)
    } else if (head === 'command' && !/^-[vV]$/.test(rest[1] ?? '')) {
      rest = dropFlags(rest, 1, NONE)
    } else {
      break
    }
  }

  return { command: rest, assigned }
}

/**
 * The command a segment runs with what only wraps it stripped: env assignments, leading redirections
 * and wrappers (`sudo`, `env`, `env -S '...'`, `time`, `timeout 60`, `nohup`, `xargs -n1`).
 * `command -v x` only looks a name up, so it is kept as is.
 */
export function unwrap(words: readonly string[]): string[] {
  return unwrapAll(words).command
}

/**
 * The command a segment really runs, for `patterns` mode: `unwrap`, then runners (`uv run`,
 * `poetry run`) and the interpreter (`python -u`) stripped; `python -m pkg` becomes `pkg`.
 */
export function normalize(words: readonly string[]): string[] {
  let rest = unwrap(words)
  for (let guard = 0; guard < 8 && rest.length > 0; guard++) {
    const head = rest[0] ?? ''
    if (RUNNERS.has(head) && rest[1] === 'run') {
      rest = unwrap(dropFlags(rest, 2, RUNNER_VALUED))
    } else if (PYTHON.test(head)) {
      const moduleAt = rest.indexOf('-m')
      const isModule = moduleAt > 0 && rest.slice(1, moduleAt).every(word => word.startsWith('-'))
      if (isModule) {
        return rest.slice(moduleAt + 1)
      }
      if (rest.slice(1).some(word => word === '-c')) {
        return rest
      }
      const script = dropFlags(rest, 1, PYTHON_VALUED)

      return script.length > 0 ? script : rest
    } else if (SHELLS.has(head) && shellString(rest) === null) {
      // `bash scripts/train.sh`: the script is the command.
      const script = dropFlags(rest, 1, SHELL_VALUED)

      return script.length > 0 ? script : rest
    } else {
      break
    }
  }

  return rest
}

/** The module a segment runs with `python -m` (through any wrapper or runner), or null. */
function pythonModule(words: readonly string[]): string | null {
  let rest = unwrap(words)
  if (RUNNERS.has(rest[0] ?? '') && rest[1] === 'run') {
    rest = unwrap(dropFlags(rest, 2, RUNNER_VALUED))
  }
  if (!PYTHON.test(rest[0] ?? '')) {
    return null
  }
  const moduleAt = rest.indexOf('-m')
  const isModule = moduleAt > 0 && rest.slice(1, moduleAt).every(word => word.startsWith('-'))

  return isModule ? rest[moduleAt + 1] ?? null : null
}

/** The command string a `sh -c` style segment hands its shell, or null. */
function shellString(words: readonly string[]): string | null {
  if (!SHELLS.has(basename(words[0] ?? ''))) {
    return null
  }
  const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word))

  return flag === -1 ? null : words[flag + 1] ?? null
}

const basename = (word: string): string => word.slice(word.lastIndexOf('/') + 1)

/** User overrides: regular expressions, one per line or separated by ` ;; `. A pattern that does not compile is skipped. */
export function parsePatterns(value: unknown): RegExp[] {
  if (typeof value !== 'string') {
    return []
  }
  const patterns: RegExp[] = []
  for (const source of value.split(/\n|\s;;\s/).map(part => part.trim())) {
    try {
      if (source !== '') {
        patterns.push(new RegExp(source))
      }
    } catch {
      // A broken user pattern blocks nothing and allows nothing.
    }
  }

  return patterns
}

/**
 * A mod's own refusal for one simple command, given its raw words (wrappers and redirections still on):
 * a reason, or null to leave it to the gate. Allowlist mode applies it to every part the gate reads,
 * nested ones too (`bash -c`, `$(...)`, `eval`, `find -exec`), before the user's allow patterns.
 */
export type SegmentRule = (words: readonly string[]) => string | null

/** Light subcommands keyed by tool, as in the built-in table: `mytool` -> {`status`, `jobs list`}. */
export type LightTable = ReadonlyMap<string, ReadonlySet<string>>

/**
 * The `gateLightSubcommands` option: entries of a tool and its subcommand (one or two words), one per
 * line or separated by ` ;; ` (`mytool status ;; mytool jobs list`). In allowlist mode each is light,
 * like `git status`, whatever arguments follow it. An entry without a subcommand, or whose tool is a
 * path or not a plain name, is skipped.
 */
export function parseLightSubcommands(value: unknown): LightTable {
  const table = new Map<string, Set<string>>()
  if (typeof value !== 'string') {
    return table
  }
  for (const entry of value.split(/\n|\s;;\s/)) {
    const [tool = '', ...subcommand] = entry.trim().split(/\s+/)
    if (/^[A-Za-z0-9][\w.+-]*$/.test(tool) && subcommand.length >= 1 && subcommand.length <= 2) {
      table.set(tool, (table.get(tool) ?? new Set()).add(subcommand.join(' ')))
    }
  }

  return table
}

/** The user's block and allow patterns and light subcommands, and a mod's own `extraSegment` rule. */
export type Overrides = { extraBlock: readonly RegExp[]; extraAllow: readonly RegExp[]; lightSubcommands?: LightTable; extraSegment?: SegmentRule }
export const NO_OVERRIDES: Overrides = { extraBlock: [], extraAllow: [] }

/** How the gate reads Bash while a limit is crossed: its mode and the user's patterns. */
export type GateRules = { mode: GateMode; overrides: Overrides }
export const DEFAULT_RULES: GateRules = { mode: 'allowlist', overrides: NO_OVERRIDES }

// ---- allowlist mode ----

/**
 * Commands that only read, inspect, wait, stop or clean up, whatever their arguments. A shell's own
 * builtins and keywords that run nothing on their own are here too (`cd`, `export`, `for`, `done`).
 */
const LIGHT: ReadonlySet<string> = new Set([
  // reading files and text
  'ls', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd',
  'mdfind', 'locate', 'wc', 'sort', 'uniq', 'cut', 'tr', 'paste', 'join', 'column', 'nl', 'rev', 'fold', 'fmt', 'expand',
  'diff', 'cmp', 'comm', 'colordiff', 'jq', 'yq', 'awk', 'gawk', 'sed', 'file', 'stat', 'readlink', 'realpath',
  'basename', 'dirname', 'tree', 'exa', 'eza', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'base64', 'od',
  'hexdump', 'xxd', 'strings', 'tee', 'pbcopy', 'pbpaste',
  // inspecting the machine
  'ps', 'pgrep', 'top', 'uptime', 'w', 'who', 'whoami', 'id', 'groups', 'hostname', 'uname', 'sw_vers', 'printenv', 'locale',
  'df', 'du', 'free', 'vm_stat', 'memory_pressure', 'sysctl', 'iostat', 'nproc', 'getconf', 'lsof', 'netstat', 'ifconfig',
  'ping', 'dig', 'host', 'nslookup', 'pmset', 'ioreg', 'system_profiler', 'date', 'cal', 'which', 'whereis', 'type', 'hash',
  // small file chores
  'touch', 'mkdir', 'mktemp', 'chmod', 'ln', 'cp', 'mv', 'open',
  // shell builtins and keywords that run nothing themselves
  'echo', 'printf', 'pwd', 'cd', 'pushd', 'popd', 'dirs', 'export', 'unset', 'set', 'shopt', 'alias', 'unalias', 'read',
  'exit', 'return', 'shift', 'local', 'declare', 'typeset', 'readonly', 'trap', 'umask', 'ulimit', 'true', 'false', ':',
  'test', '[', '[[', ']]', 'sleep', 'wait', 'jobs', 'disown', 'seq', 'expr', 'bc', 'for', 'case', 'select', 'done', 'fi',
  'esac', 'in', 'command', 'break', 'continue', 'let', 'getopts',
  // stopping and cleanup
  'kill', 'pkill', 'killall', 'rm', 'rmdir', 'unlink', 'trash',
])

/** Light subcommands of a tool that also starts heavy work, keyed by the tool; `*` allows the tool's every use. */
const LIGHT_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    git: [
      'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'tag', 'ls-files', 'ls-tree', 'blame',
      'reflog', 'shortlog', 'grep', 'cat-file', 'merge-base', 'name-rev', 'check-ignore', 'for-each-ref', 'symbolic-ref',
      'rev-list', 'cherry', 'whatchanged', 'count-objects', 'var', 'version', 'help', 'stash',
      'worktree list', 'worktree remove', 'worktree prune', 'worktree add', 'clean', 'prune', 'notes list', 'notes show',
      // Everyday version control. A commit, checkout or merge can run the repository's own hooks; that is
      // allowed, since refusing every commit while gated costs more than a hook that runs tests.
      'add', 'commit', 'checkout', 'switch', 'restore', 'fetch', 'pull', 'push', 'merge', 'rebase', 'rm', 'mv',
      'reset', 'revert', 'cherry-pick',
    ],
    docker: [
      'ps', 'stats', 'images', 'logs', 'inspect', 'top', 'port', 'version', 'info', 'events', 'diff', 'history',
      'stop', 'kill', 'rm', 'rmi', 'pause', 'wait',
      'container ls', 'container list', 'container ps', 'container inspect', 'container logs', 'container stats',
      'container top', 'container port', 'container stop', 'container kill', 'container rm', 'container prune',
      'container pause', 'container wait',
      'image ls', 'image list', 'image inspect', 'image history', 'image rm', 'image prune',
      'volume ls', 'volume list', 'volume inspect', 'volume rm', 'volume prune',
      'network ls', 'network list', 'network inspect', 'network rm', 'network prune',
      'system df', 'system info', 'system events', 'system prune',
      'builder ls', 'builder du', 'builder prune', 'buildx ls', 'buildx du', 'buildx prune', 'buildx inspect', 'buildx version',
      'context ls', 'context show', 'context inspect',
      'compose ps', 'compose ls', 'compose logs', 'compose top', 'compose images', 'compose config', 'compose version',
      'compose down', 'compose stop', 'compose kill', 'compose rm', 'compose pause', 'compose port',
    ],
    gh: [
      'status', 'auth status', 'api', 'pr view', 'pr list', 'pr status', 'pr checks', 'pr diff', 'run view', 'run list',
      'run watch', 'run cancel', 'issue view', 'issue list', 'issue status', 'repo view', 'repo list', 'release view',
      'release list', 'workflow view', 'workflow list', 'search', 'pr create', 'pr comment', 'pr edit', 'pr ready',
      'pr merge', 'pr close', 'pr review', 'issue create', 'issue comment', 'issue edit', 'issue close', 'run rerun',
      'label list', 'browse',
    ],
    brew: ['cleanup', 'list', 'ls', 'info', 'uninstall', 'remove', 'rm', 'autoremove', 'leaves', 'deps', 'config', 'services list'],
    npm: ['cache clean', 'cache verify', 'ls', 'list', 'view', 'why', 'config get', 'config list', 'prune'],
    pnpm: ['store prune', 'store path', 'ls', 'list', 'why', 'config get', 'config list'],
    yarn: ['cache clean', 'cache list', 'list', 'why', 'info'],
    pip: ['list', 'show', 'freeze', 'cache purge', 'cache remove', 'cache list', 'cache info', 'cache dir', 'uninstall'],
    uv: ['cache clean', 'cache prune', 'cache dir', 'pip list', 'pip show', 'pip freeze', 'pip uninstall', 'version'],
    conda: ['clean', 'list', 'info', 'env list', 'config', 'remove', 'uninstall'],
    mamba: ['clean', 'list', 'info', 'env list', 'remove', 'uninstall'],
    cargo: ['clean'],
    go: ['clean', 'env', 'version'],
    tmux: ['ls', 'list-sessions', 'list-windows', 'list-panes', 'has-session', 'capture-pane', 'kill-session', 'kill-server', 'kill-window', 'kill-pane'],
    screen: ['-ls', '-list', '-wipe'],
    hf: ['cache', 'env', 'whoami', 'scan-cache', 'delete-cache'],
    'huggingface-cli': ['scan-cache', 'delete-cache', 'env', 'whoami'],
    tmutil: ['listlocalsnapshots', 'deletelocalsnapshots', 'thinlocalsnapshots', 'listbackups'],
    diskutil: ['list', 'info', 'apfs list'],
    launchctl: ['list', 'print'],
  }).map(([tool, subs]) => [tool, new Set(subs)]),
)
/** Tools spelled differently that share a table: `podman` is `docker`, `pip3` is `pip`. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['podman', 'docker'], ['docker-compose', 'docker compose'], ['podman-compose', 'docker compose'], ['pip3', 'pip'],
  ['gmake', 'make'],
])
/** Global flags that take a value and come before a tool's subcommand: `git -C dir status`, `docker --context x ps`. */
const GLOBAL_VALUED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git', new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])],
  ['docker', new Set(['--context', '-c', '-H', '--host', '--config', '--log-level', '-l', '--tlscacert', '--tlscert', '--tlskey'])],
  ['compose', new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress'])],
  ['gh', new Set(['-R', '--repo'])],
  ['brew', new Set([])],
])
/** `screen -X -S name quit` and its kin stop a session; `-r`/`-x` attach to one; any other use starts one. */
const SCREEN_STOP = /^-S\s+\S+\s+-X\s+quit$|^-X\s+-S\s+\S+\s+quit$|^-XS\s+\S+\s+quit$/

/**
 * The subcommand words of a tool's segment, its global flags (and their values) dropped:
 * `git -C repo --no-pager log -5` reads `log -5`.
 */
function subcommandWords(tool: string, words: readonly string[], table = LIGHT_SUBCOMMANDS.get(tool)): string[] {
  const valued = GLOBAL_VALUED.get(tool) ?? NONE
  let i = 0
  while (i < words.length && /^-/.test(words[i] ?? '') && !(table?.has(words[i] ?? '') ?? false)) {
    i += valued.has(words[i] ?? '') ? 2 : 1
  }

  return words.slice(i)
}

/**
 * Whether a tool's subcommand (one or two words, global flags dropped) is in its light table: the
 * built-in one, or the user's `gateLightSubcommands`.
 */
function isLightSubcommand(tool: string, args: readonly string[], extra: LightTable = new Map()): boolean {
  const builtIn = LIGHT_SUBCOMMANDS.get(tool)
  const added = extra.get(tool)
  const table = added === undefined ? builtIn : new Set([...(builtIn ?? []), ...added])
  if (table === undefined) {
    return false
  }
  let rest = subcommandWords(tool, args, table)
  if (tool === 'docker' && rest[0] === 'compose') {
    rest = ['compose', ...subcommandWords('compose', rest.slice(1))]
  }
  const [first = '', second = ''] = rest

  return table.has(first) || table.has(`${first} ${second}`)
}

/** `curl` only reads unless it saves a file (`-O`, `-o file`, `--output file`). */
const CURL_SAVES = /\s(?:-[A-Za-z]*O|--remote-name|-[A-Za-z]*o\s+(?!\/dev\/null\b)|--output\s+(?!\/dev\/null\b))/

/** How deep a command may nest (`bash -c "$(...)"`) before the gate stops reading and refuses it. */
const MAX_DEPTH = 4

const notLight = (command: readonly string[]): string => `not on the light list: ${describe(command)}`

/**
 * Names whose value decides what a light command runs: `PATH=./bin ls`, `GIT_EXTERNAL_DIFF=./x git diff`,
 * `LESSOPEN='|./x %s' less f`, an editor or pager git starts, a library loaded into every program.
 */
const RISKY_NAME = /^(?:PATH|GIT_\w+|LESSOPEN|LESSCLOSE|LESS|\w*PAGER|EDITOR|VISUAL|BASH_ENV|ENV|DYLD_\w+|LD_\w+)$/
/** Values of those names that start nothing: `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `LESS='-R -F'`. */
const INERT_VALUE = /^(?:|cat|less|more|true|false|:|\d+|-[A-Za-z]+(?:\s+-[A-Za-z]+)*)$/
/**
 * One part of a `PATH` that names no folder relative to where the command runs: absolute (`/opt/x/bin`),
 * under a home (`~/bin`, `$HOME/.local/bin`, `${HOME}/go/bin`), or the old `PATH` itself.
 */
const ANCHORED_PATH_PART = /^(?:[/~]|\$HOME(?:\/|$)|\$\{HOME\}(?:\/|$)|\$PATH$|\$\{PATH\}$)/

/** Whether a risky name's value starts nothing: an inert value, or a `PATH` whose every part is anchored (none relative or empty). */
function isInertValue(name: string, value: string): boolean {
  return INERT_VALUE.test(value) || (name === 'PATH' && value.split(':').every(part => ANCHORED_PATH_PART.test(part)))
}

/** The first `NAME=value` among these that sets a risky name to anything but an inert value, or null. */
function riskyAssignment(assignments: readonly string[]): string | null {
  for (const assignment of assignments) {
    const equals = assignment.indexOf('=')
    const name = assignment.slice(0, equals).replace(/\[.*$|\+$/, '')
    // `PATH+=:/opt/bin` appends, so its leading `:` joins the old value and leaves no empty part.
    const value = assignment.slice(equals + 1).replace(assignment[equals - 1] === '+' ? /^:/ : /^$/, '')
    if (RISKY_NAME.test(name) && !isInertValue(name, value)) {
      return name
    }
  }

  return null
}

/** Builtins that set the names they are handed: `export PATH=./bin`. */
const SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])

/**
 * Where a light name may be found: a bare name, or one of the system and Homebrew folders. Any other
 * path (`./bin/ls`, `/tmp/cat`, a symlink to `make`) runs whatever is there, light name or not.
 */
const TRUSTED_PATH = /^\/(?:usr\/)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/
const isTrustedName = (word: string): boolean => !word.includes('/') || TRUSTED_PATH.test(word)

/**
 * Options of light tools that run another program, each as `[tool, why, matches]`: `rg --pre ./x`,
 * `sort --compress-program=./x`, `hash -p /usr/bin/make ls`, `less +!make`.
 */
const RUNS_PROGRAM: readonly (readonly [string, string, RegExp])[] = [
  ['rg', 'rg --pre', /^--pre(?:=|$)/],
  ['sort', 'sort --compress-program', /^--compress-program(?:=|$)/],
  ['hash', 'hash -p', /^-[A-Za-z]*p/],
  ['less', 'less +! command', /^\+.*[!|]/],
  ['more', 'more +! command', /^\+.*[!|]/],
]

/** An awk program that runs a command: `system(...)`, or a `|` pipe to or from one (`print | "sh"`). */
function isLightAwk(args: readonly string[]): boolean {
  let i = 0
  while (i < args.length && /^-./.test(args[i] ?? '') && args[i] !== '--') {
    // A program read from a file, or gawk's extensions and includes, cannot be read here.
    if (/^(?:-[fEeil]|--(?:file|exec|source|include|load))/.test(args[i] ?? '')) {
      return false
    }
    i += /^(?:-[Fv]|--field-separator|--assign)$/.test(args[i] ?? '') ? 2 : 1
  }
  const program = args[args[i] === '--' ? i + 1 : i] ?? ''
  // A string (`"a|b"`, `FS="|"`), a regular expression (`/a|b/`) and a logical or (`||`) hold no pipe.
  // Strings and regular expressions are dropped in one pass from the left, so a `"` inside `/"/` opens
  // no string that would hide a pipe after it.
  const pipes = program.replace(/"(?:\\.|[^"\\])*"|\/(?:\\.|[^/\\\n])*\//g, '').replace(/\|\|/g, '')

  return !/\bsystem\s*\(/.test(program) && !pipes.includes('|')
}

/**
 * A sed that runs no command: no `e` command or `s///e` flag in any script (GNU sed runs it), and no
 * script file (`-f`) the gate cannot read. Every word that is not a flag is checked, since BSD sed's
 * `-i ''` makes the script the second one.
 */
function isLightSed(args: readonly string[]): boolean {
  if (args.some(word => /^-[nErsuz]*f|^--file/.test(word))) {
    return false
  }
  const scripts = args.filter(word => !/^-/.test(word)).concat(args.flatMap(word => /^--expression=(.*)$/s.exec(word)?.[1] ?? []))
  const runs = /(?:^|[;\n{}0-9$/!])\s*e(?:\s|;|$)|s([^\w\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM0-9]*e/

  return !scripts.some(script => runs.test(script))
}

/** `tar` only lists an archive (`tar tzf x.tgz`, `tar --list`), with no option that runs a program. */
function isLightTar(args: readonly string[]): boolean {
  if (args.some(word => /^(?:-I|-F|--use-compress-program|--to-command|--checkpoint-action|--info-script|--new-volume-script|--rsh-command|--rmt-command)/.test(word))) {
    return false
  }
  const mode = args.find(word => /^--(?:list|extract|get|create|append|update|catenate|concatenate|delete|diff|compare)$/.test(word))
  if (mode !== undefined) {
    return mode === '--list'
  }
  const letters = (args[0] ?? '').replace(/^-/, '')

  return /^[A-Za-z]+$/.test(letters) && letters.includes('t') && !/[xcruA]/.test(letters)
}

/** The standard modules a `python -c` one-liner may import: they compute, read and print, and start nothing. */
const SAFE_PYTHON_MODULES: ReadonlySet<string> = new Set([
  'json', 'sys', 'os', 'os.path', 're', 'math', 'datetime', 'pathlib', 'platform', 'collections', 'itertools', 'csv',
  'hashlib', 'base64', 'time', 'glob', 'textwrap', 'pprint', 'shlex', 'statistics', 'string', 'functools', 'operator',
  'typing', 'dataclasses', 'enum',
])
/** The `os` functions that start another program. */
const OS_RUNS = String.raw`(?:system|popen|exec[lv]p?e?|spawn\w*|posix_spawn\w*|fork\w*)`
/**
 * What runs code or another program in a one-liner: a call of `exec(`, `eval(`, `compile(`,
 * `__import__(` or `breakpoint(` (not `re.compile(`, not `d['eval']`); taking an `os` runner or `*` from
 * `os` (`from os import system as s`); and `subprocess.` in any form. An `os` runner reached through
 * the module is `osRunner`'s.
 */
const PYTHON_RUNS = new RegExp(
  String.raw`(?<![\w.])(?:exec|eval|compile|__import__|breakpoint)\s*\(|\bfrom\s+os\s+import\b[^;\n]*(?:\b${OS_RUNS}\b|\*)|\bsubprocess\s*\.`,
)

/** Whether a program reaches an `os` runner through `os` or a name it imported `os` as: `os.system`, `o.popen` after `import os as o`. */
function reachesOsRunner(program: string): boolean {
  const names = ['os', ...[...program.matchAll(/\bos\s+as\s+(\w+)/g)].map(match => match[1] ?? 'os')]

  return new RegExp(String.raw`(?<![\w.])(?:${names.join('|')})\s*\.\s*${OS_RUNS}\b`).test(program)
}
/** How long a `python -c` program may be and still count as a one-liner. */
const PYTHON_C_MAX = 300

/** The modules a Python program imports (`import a, b.c as d`, `from e import f`); a relative `from . import x` names `.`. */
function pythonImports(program: string): string[] {
  const from = /\bfrom\s+([\w.]*)\s+import\b/g
  const froms = [...program.matchAll(from)].map(match => match[1] ?? '')
  const plain = [...program.replace(from, ';').matchAll(/\bimport\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/g)]

  return [...froms, ...plain.flatMap(match => (match[1] ?? '').split(',').map(part => part.trim().split(/\s+/)[0] ?? ''))]
}

/**
 * `python3 -c 'print(1)'`: a short inline program, only flags before `-c`, that imports only safe
 * standard modules and runs nothing (`PYTHON_RUNS`, `reachesOsRunner`); or `python3 -m json.tool`.
 */
function isLightPython(args: readonly string[]): boolean {
  if (args[0] === '-m' && args[1] === 'json.tool') {
    return true
  }
  const at = args.indexOf('-c')
  const program = args[at + 1] ?? ''

  return (
    at !== -1 &&
    args.slice(0, at).every(word => /^-[A-Za-z]+$/.test(word) && !word.includes('m')) &&
    program.length <= PYTHON_C_MAX &&
    !PYTHON_RUNS.test(program) &&
    !reachesOsRunner(program) &&
    pythonImports(program).every(module => SAFE_PYTHON_MODULES.has(module))
  )
}

/**
 * `git -c` keys that run nothing, lowercased as git reads them: names, colours, hints, log and format
 * settings, and a pager that is `cat` or `less`. Any other key may name a program (`core.fsmonitor`,
 * `diff.external`, `core.sshCommand`, `alias.*`, `core.hooksPath`), so it is refused.
 */
const SAFE_GIT_CONFIG = /^(?:(?:user|color|advice|log|format)\.[\w.-]+|core\.quotepath|safe\.directory|init\.defaultbranch|commit\.gpgsign)$/
/** A key ending in `.cmd` or `.command` names a program whatever its section. */
const GIT_CONFIG_COMMAND = /\.(?:cmd|command)$/

/** Whether a `git -c` setting (`key=value`, or a bare `key` that sets it true) runs nothing. */
function isSafeGitConfig(setting: string): boolean {
  const equals = setting.indexOf('=')
  const key = (equals === -1 ? setting : setting.slice(0, equals)).toLowerCase()
  const value = equals === -1 ? '' : setting.slice(equals + 1)
  if (GIT_CONFIG_COMMAND.test(key)) {
    return false
  }

  return SAFE_GIT_CONFIG.test(key) || (key === 'core.pager' && (value === 'cat' || value === 'less'))
}

/** Why a git segment runs something else, or null: a `-c` key off the safe list, `--config-env`, `--exec-path=`, or `git grep -O`. */
function gitRunsProgram(args: readonly string[]): string | null {
  const sub = subcommandWords('git', args)
  const globals = args.slice(0, args.length - sub.length)
  for (let i = 0; i < globals.length; i++) {
    const word = globals[i] ?? ''
    if (/^(?:--config-env|--exec-path=)/.test(word)) {
      return 'git --config-env or --exec-path'
    }
    // `-c key=value`, or joined as `-ckey=value`; a `-c` with nothing after it is refused too.
    const setting = word === '-c' ? globals[++i] : word.startsWith('-c') ? word.slice(2) : null
    if (setting !== null && (setting === undefined || !isSafeGitConfig(setting))) {
      return 'git -c (config that can run a program)'
    }
  }
  if (sub[0] === 'grep' && sub.some(word => /^-[A-Za-z]*O|^--open-files-in-pager/.test(word))) {
    return 'git grep -O'
  }

  return null
}

/** Why a segment is not light (`not on the light list: docker run`, `custom rule /x/`), or null when it is. */
function heavySegment(words: readonly string[], overrides: Overrides, depth: number): string | null {
  const { command, assigned } = unwrapAll(words)
  const risky = riskyAssignment(assigned)
  if (command.length === 0) {
    // A bare `PATH=./bin` changes what every later name runs.
    return risky === null ? null : `not on the light list: setting ${risky}`
  }
  const line = command.join(' ')
  const custom = overrides.extraBlock.find(pattern => pattern.test(line))
  if (custom !== undefined) {
    return `custom rule /${custom.source}/`
  }
  const own = overrides.extraSegment?.(words) ?? null
  if (own !== null) {
    return own
  }
  if (overrides.extraAllow.some(pattern => pattern.test(line))) {
    return null
  }
  if (risky !== null) {
    return `not on the light list: ${describe(command)} with ${risky} set`
  }
  if (isHelp(command)) {
    return null
  }
  // An arithmetic command `(( ... ))`; the substitutions in it were recorded on its word and judged with the line's.
  if (/^\(\(.*\)\)$/s.test(command[0] ?? '')) {
    return null
  }
  if (!isTrustedName(command[0] ?? '')) {
    return notLight(command)
  }
  const nested = (inner: string): string | null => (depth < MAX_DEPTH ? heavyCommand(inner, overrides, depth + 1) : notLight(command))
  const inner = shellString(command)
  if (inner !== null) {
    return nested(inner)
  }
  const head = basename(command[0] ?? '')
  const tool = ALIASES.get(head) ?? head
  const args = command.slice(1)
  if (head === 'eval') {
    return nested(args.join(' '))
  }
  if (head === 'trap') {
    // `trap 'cmd' EXIT` runs its string later; `trap - EXIT` and `trap -p` set nothing to run.
    const action = args[0] === '--' ? args[1] : args[0]
    return action === undefined || /^-/.test(action) ? null : nested(action)
  }
  if (head === 'alias') {
    // `alias ls='make -j8'`: the value is what the name will run.
    for (const definition of args.filter(word => word.includes('='))) {
      const heavy = nested(definition.slice(definition.indexOf('=') + 1))
      if (heavy !== null) {
        return heavy
      }
    }
    return null
  }
  if (SETTERS.has(head)) {
    const set = riskyAssignment(args.filter(word => ASSIGNMENT.test(word)))
    return set === null ? null : `not on the light list: setting ${set}`
  }
  if (head === 'find') {
    return heavyExec(args, /^-(?:exec|execdir|ok|okdir)$/, overrides, depth)
  }
  if (head === 'fd') {
    return heavyExec(args, /^(?:-[A-Za-z0-9]*[xX]|--exec|--exec-batch)$/, overrides, depth)
  }
  if (head === 'curl') {
    return CURL_SAVES.test(` ${args.join(' ')}`) ? 'not on the light list: curl saving a file' : null
  }
  const option = RUNS_PROGRAM.find(([name, , matches]) => name === head && args.some(word => matches.test(word)))
  if (option !== undefined) {
    return `not on the light list: ${option[1]}`
  }
  const gitProgram = tool === 'git' ? gitRunsProgram(args) : null
  if (gitProgram !== null) {
    return `not on the light list: ${gitProgram}`
  }
  const isLight =
    tool === 'make' ? isLightMake(args)
    : tool === 'screen' ? SCREEN_STOP.test(args.join(' ')) || isLightSubcommand('screen', args)
    : tool === 'docker compose' ? isLightSubcommand('docker', ['compose', ...args])
    : /^g?awk$|^[mn]awk$/.test(head) ? isLightAwk(args)
    : head === 'sed' ? isLightSed(args)
    : head === 'tar' ? isLightTar(args)
    : PYTHON.test(head) ? isLightPython(args)
    : LIGHT.has(head) || isLightSubcommand(tool, args, overrides.lightSubcommands)

  return isLight ? null : notLight(command)
}

/** `find ... -exec cmd {} \;` or `fd -x cmd`: the commands it runs (up to `;`, `+` or the end) must be light too. */
function heavyExec(args: readonly string[], flag: RegExp, overrides: Overrides, depth: number): string | null {
  for (let i = 0; i < args.length; i++) {
    if (flag.test(args[i] ?? '')) {
      const end = args.findIndex((word, j) => j > i && (word === ';' || word === '+'))
      const run = args.slice(i + 1, end === -1 ? args.length : end)
      const heavy = heavySegment(run, overrides, depth + 1)
      if (heavy !== null) {
        return heavy
      }
      i = end === -1 ? args.length : end
    }
  }

  return null
}

/** Subcommands that group others, so the refusal names the next word too: `docker compose up`, `git stash push`. */
const GROUPS = new Set(['compose', 'container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'context', 'stash', 'worktree', 'notes', 'cache', 'pip', 'pr', 'issue', 'repo', 'release', 'workflow', 'auth', 'store', 'env'])

/**
 * A segment as a refusal names it: the tool and its subcommand (`docker run`, `docker compose up`), the
 * module (`python -m train`) or the script or path it is handed (`python train.py`, `pytest tests/`).
 */
function describe(command: readonly string[]): string {
  const head = basename(command[0] ?? '')
  const clip = (word: string): string => (word.length > 40 ? `${word.slice(0, 37)}...` : word)
  const isPlain = (word: string): boolean => /^[a-z][a-z0-9-]*$/.test(word)
  const moduleAt = command.indexOf('-m')
  if (PYTHON.test(head) && moduleAt > 0) {
    return `${head} -m ${clip(command[moduleAt + 1] ?? '')}`.trim()
  }
  const [, first = '', second = ''] = command
  if (first === '' || first.startsWith('-')) {
    return head
  }
  if (!isPlain(first)) {
    return `${head} ${clip(first)}`
  }

  return GROUPS.has(first) && isPlain(second) ? `${head} ${first} ${second}` : `${head} ${first}`
}

/** `make` only cleans, prints help or dry-runs: every target it names is `clean`, `distclean` or `help`, or it is given `-n`. */
function isLightMake(args: readonly string[]): boolean {
  if (args.some(word => /^(?:-n|--dry-run|--just-print|--recon)$/.test(word))) {
    return true
  }
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? ''
    if (/^(?:-C|-f|--directory|--file)$/.test(word)) {
      i++
    } else if (!word.startsWith('-') && !word.includes('=')) {
      targets.push(word)
    }
  }

  return targets.length > 0 && targets.every(target => target === 'clean' || target === 'distclean' || target === 'help')
}

/** The first part of a command line that is not light, or null when every part is (allowlist mode). */
function heavyCommand(command: string, overrides: Overrides, depth: number): string | null {
  const { segments: parts, substitutions } = parse(command)
  for (const inner of substitutions) {
    const heavy = depth < MAX_DEPTH ? heavyCommand(inner, overrides, depth + 1) : 'not on the light list: a deeply nested command'
    if (heavy !== null) {
      return heavy
    }
  }
  for (const words of parts) {
    const heavy = heavySegment(words, overrides, depth)
    if (heavy !== null) {
      return heavy
    }
  }

  return null
}

// ---- patterns mode ----

function classifySegment(words: readonly string[], overrides: Overrides, depth: number): string | null {
  const command = normalize(words)
  const inner = shellString(command)
  if (inner !== null && depth < 3) {
    return classifyPatterns(inner, overrides, depth + 1)
  }
  const line = command.join(' ')
  if (overrides.extraAllow.some(pattern => pattern.test(line))) {
    return null
  }
  const custom = overrides.extraBlock.find(pattern => pattern.test(line))
  if (custom !== undefined) {
    return `custom rule /${custom.source}/`
  }
  if (isHelp(unwrap(words))) {
    return null
  }
  const rule = HEAVY_RULES.find(({ pattern }) => pattern.test(line))
  if (rule !== undefined) {
    return rule.name
  }
  const module = pythonModule(words)
  if (module !== null && TRAIN_MODULE.test(module)) {
    return 'train/eval script'
  }
  if (DETACHED_SESSION.test(line) && depth < 3) {
    // The launched command is the session's trailing words; try each tail, since its own flags vary.
    for (let from = 1; from < command.length; from++) {
      const launched = classifyPatterns(command.slice(from).join(' '), overrides, depth + 1)
      if (launched !== null) {
        return `detached session: ${launched}`
      }
    }
  }

  return null
}

function classifyPatterns(command: string, overrides: Overrides, depth: number): string | null {
  const { segments: parts, substitutions } = parse(command)
  for (const words of [...parts, ...(depth < 3 ? substitutions.flatMap(inner => segments(inner)) : [])]) {
    const rule = classifySegment(words, overrides, depth)
    if (rule !== null) {
      return rule
    }
  }

  return null
}

/**
 * Why a Bash command may not run while gated, or null when it may. In `allowlist` mode that is the first
 * part that is not light (`not on the light list: make`); in `patterns` mode the heavy rule it trips.
 * Running in the background (`cmd &`, `run_in_background`) is not a reason on its own.
 */
export function classifyBash(command: string, { mode = 'allowlist', overrides = NO_OVERRIDES, depth = 0 }: Partial<GateRules> & { depth?: number } = {}): string | null {
  if (mode === 'patterns') {
    return classifyPatterns(command, overrides, depth)
  }
  return heavyCommand(command, overrides, depth)
}

/** A tool call as the gate reads it: only Agent and Bash are ever refused. */
export type GateCall = { tool: string; command?: unknown; run_in_background?: unknown }

/** What the gate would refuse in this call, or null to let it through. Assumes the limit is crossed. */
export function heavyWork(call: GateCall, rules: GateRules = DEFAULT_RULES): string | null {
  if (call.tool === 'Agent') {
    return 'spawning a subagent'
  }
  if (call.tool !== 'Bash' || typeof call.command !== 'string') {
    return null
  }

  return classifyBash(call.command, rules)
}

/** Whether a reading stamped `at` may still gate at `now`: present and no older than STALE_INTERVALS checks. */
export function isFresh(at: unknown, now: number, intervalMs: number): boolean {
  return typeof at === 'number' && Number.isFinite(at) && now - at <= STALE_INTERVALS * intervalMs
}

export type Refusal = {
  /** The tool refused, from `GateCall`; anything but `Agent` reads as a command. */
  tool?: string
  /** `mem-watch` */
  plugin: string
  /** `Memory is low` */
  condition: string
  /** `free 12% · swap 5G` */
  figure: string
  /** `free at least 28%, swap at most 28G` */
  limit: string
  /** `memory recovers` */
  recovery: string
  /** The reason, from `heavyWork`. */
  rule: string
  /** The biggest users of what ran short, one short line each (`python3 (pid 4242) 9.0 GB`); none when unknown. */
  culprits?: readonly string[]
  /** What the culprits are biggest users of: `memory`, `disk space`. */
  resource?: string
}

/** What still runs while gated, as the refusal lists it. */
const STILL_ALLOWED =
  'Still allowed: reading and inspecting (ls, cat, grep, jq, ps, df, du, git status/log/diff, docker ps/stats, gh pr view), small file chores (cp, mv, mkdir), everyday git (add, commit, push, pull, checkout), stopping and cleanup (kill, pkill, docker stop/rm/prune, rm, git worktree remove), --help and --version, and every tool but Bash and Agent.'

/** The culprits line, or none: the largest users, and that nothing was stopped. */
export function culpritsLine(culprits: readonly string[] | undefined, resource = 'memory'): string[] {
  return culprits === undefined || culprits.length === 0 ? [] : [`Largest users of ${resource} now: ${culprits.join('; ')}. Nothing has been stopped; ask the user before stopping what you did not start.`]
}

/** Short and calm: the figure and limit, that nothing ran and why, what is still allowed, the culprits, and that it lifts itself. */
export function refusalReason(r: Refusal): string {
  const isAgent = r.tool === 'Agent'

  return [
    `${r.plugin}: ${isAgent ? 'this subagent was not started' : 'this command was not run'}. ${r.condition} (${r.figure}; limit: ${r.limit}), so new work is paused (${r.rule}).`,
    STILL_ALLOWED,
    ...culpritsLine(r.culprits, r.resource),
    `The pause lifts by itself when ${r.recovery}. Do not retry ${isAgent ? 'starting it' : 'this command'} in a loop or reword it to get past the gate; free resources, wait, or tell the user.`,
  ].join('\n')
}

const BYTES_PER_UNIT: Record<string, number> = {
  B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
}

/** `1.2GiB`, `512MB`, `12.3kB`, `0B`: a size as Docker prints it, in bytes; null when it is not one. Shared by both mods' culprits. */
export function parseSize(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B)\s*$/i.exec(text)
  const perUnit = BYTES_PER_UNIT[(match?.[2] ?? '').toUpperCase()]

  return match === null || perUnit === undefined ? null : Number(match[1]) * perUnit
}

/** The culprits a tick stored for every session, stamped `at`, read defensively: null unless both are well formed. */
export function asStoredCulprits(value: unknown): { at: number; lines: string[] } | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { at, lines } = value as Record<string, unknown>
  const isLines = Array.isArray(lines) && lines.every(line => typeof line === 'string')

  return typeof at === 'number' && Number.isFinite(at) && isLines ? { at, lines: lines as string[] } : null
}

/** The one-line toast each refusal shows. */
export function refusalToast(r: Refusal): string {
  return `paused ${r.rule.replace(/^not on the light list: /, '')}: ${r.figure}`
}
