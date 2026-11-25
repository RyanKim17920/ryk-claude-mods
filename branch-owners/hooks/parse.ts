// Pure parsing of a shell command line for git branch creation. No `$` here.

export type Creation = {
  branch: string
  /** Where git ran: the last `cd` before it joined with its `-C` values. */
  dir?: string
  worktreePath?: string
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

/** git options before the subcommand that take a separate value. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
])

/** `git branch` flags that still leave `git branch <name> [start]` a creation. */
const BRANCH_CREATE_FLAGS = new Set([
  '-f',
  '--force',
  '-t',
  '--track',
  '--no-track',
  '-q',
  '--quiet',
  '--create-reflog',
  '--recurse-submodules',
])

const BRANCH_COPY_FLAGS = new Set(['-c', '-C', '--copy'])

/** `git worktree add` options that take a separate value (not a branch). */
const WORKTREE_VALUE_OPTIONS = new Set(['--reason'])

/** The delimiter a here-document operator at `command[at]` (`<<`, `<<-`) names, and where it ends. */
function readHereDelimiter(command: string, at: number): { delimiter: string; end: number } | undefined {
  let i = at + 2
  if (command[i] === '-') i++
  while (command[i] === ' ' || command[i] === '\t') i++
  let delimiter = ''
  for (; i < command.length; i++) {
    const char = command[i] as string
    if (char === '"' || char === "'" || char === '\\') continue
    if (/[\s;&|<>()]/.test(char)) break
    delimiter += char
  }

  return delimiter === '' ? undefined : { delimiter, end: i }
}

/**
 * Splits a command line into simple commands of words, honouring quotes and
 * backslashes, so text inside a quoted argument is never read as a command.
 * A `#` comment and the body of a here-document are skipped: neither runs.
 */
export function splitCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | undefined
  /** Delimiters of the here-documents whose bodies start after the next newline. */
  const heredocs: string[] = []

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  /** From the newline at `at`, skips each owed body; answers the index of its last line's end. */
  const skipHeredocs = (at: number): number => {
    let end = at
    for (const delimiter of heredocs.splice(0)) {
      for (;;) {
        const lineEnd = command.indexOf('\n', end + 1)
        const line = command.slice(end + 1, lineEnd < 0 ? command.length : lineEnd)
        end = lineEnd < 0 ? command.length : lineEnd
        if (lineEnd < 0 || line.replace(/^\t+/, '') === delimiter) break
      }
    }

    return end
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string

    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        word += command[++i]
      } else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasWord = true
      continue
    }
    if (char === '\\' && i + 1 < command.length) {
      const escaped = command[++i] as string
      if (escaped !== '\n') {
        word += escaped
        hasWord = true
      }
      continue
    }
    if (char === '#' && !hasWord) {
      const lineEnd = command.indexOf('\n', i)
      i = (lineEnd < 0 ? command.length : lineEnd) - 1
      continue
    }
    // `<<<` is a here-string: its word is an ordinary word.
    if (command.startsWith('<<<', i)) {
      word += '<<<'
      hasWord = true
      i += 2
      continue
    }
    if (char === '<' && command[i + 1] === '<') {
      const here = readHereDelimiter(command, i)
      if (here !== undefined) {
        heredocs.push(here.delimiter)
        endWord()
        i = here.end - 1
        continue
      }
    }
    // `2>&1`, `>&2`, `<&3` and `&>file` are redirections, not a background `&`.
    if (char === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) {
      word += char
      hasWord = true
      continue
    }
    if (char === '\n') {
      endCommand()
      i = skipHeredocs(i)
      continue
    }
    const two = command.slice(i, i + 2)
    if (SEPARATORS.has(two)) {
      endCommand()
      i++
      continue
    }
    if (SEPARATORS.has(char) || char === '(' || char === ')') {
      endCommand()
      continue
    }
    if (char === ' ' || char === '\t') {
      endWord()
      continue
    }
    word += char
    hasWord = true
  }
  endCommand()

  return commands
}

/** A name the shell would expand is unknowable from the text: never claimed. */
function isLiteralName(name: string | undefined): name is string {
  return name !== undefined && name !== '' && !/[$`*?]/.test(name) && !name.startsWith('-')
}

function joinDir(base: string | undefined, dir: string): string {
  if (base === undefined || dir.startsWith('/') || dir.startsWith('~')) return dir

  return `${base.replace(/\/+$/, '')}/${dir}`
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** The words before a lone `--`: after it, git reads paths, never options. */
function optionsPart(args: readonly string[]): readonly string[] {
  const at = args.indexOf('--')

  return at < 0 ? args : args.slice(0, at)
}

/**
 * The value of the first of `flags` in `args`, e.g. the name after `-b`: the
 * next word, or attached, as `-bname` (short) or `--orphan=name` (long).
 */
function valueAfter(args: readonly string[], flags: readonly string[]): string | undefined {
  const options = optionsPart(args)
  for (let i = 0; i < options.length; i++) {
    const arg = options[i] as string
    if (flags.includes(arg)) return options[i + 1]
    for (const flag of flags) {
      if (flag.startsWith('--') && arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
      if (!flag.startsWith('--') && !arg.startsWith('--') && arg.length > flag.length && arg.startsWith(flag)) {
        return arg.slice(flag.length)
      }
    }
  }

  return undefined
}

function parseBranch(args: readonly string[]): string | undefined {
  const options = optionsPart(args)
  const flags = options.filter(arg => arg.startsWith('-'))
  // After `--` every word is a name, even one that starts with a dash (refused later).
  const names = [...options.filter(arg => !arg.startsWith('-')), ...args.slice(options.length + 1)]
  const isCopy = flags.some(flag => BRANCH_COPY_FLAGS.has(flag))
  const isCreate = flags.every(
    flag => BRANCH_CREATE_FLAGS.has(flag) || BRANCH_COPY_FLAGS.has(flag) || flag.startsWith('--track='),
  )
  if (!isCreate) return undefined

  // `git branch -c [old] new` names the new branch last; a bare `git branch` lists.
  return isCopy ? names.at(-1) : names[0]
}

function parseWorktreeAdd(args: readonly string[]): { branch?: string; path?: string } {
  const named = valueAfter(args, ['-b', '-B'])
  const positionals: string[] = []
  let isOption = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (isOption && arg === '--') isOption = false
    else if (isOption && (arg === '-b' || arg === '-B' || WORKTREE_VALUE_OPTIONS.has(arg))) i++
    else if (!isOption || !arg.startsWith('-')) positionals.push(arg)
  }
  const [path, commitIsh] = positionals
  if (path === undefined) return {}
  if (named !== undefined) return { branch: named, path }

  // Detached, or `<path> <commit-ish>`: a checkout of something that exists.
  const isDetached = args.includes('--detach') || args.includes('-d')
  if (isDetached || commitIsh !== undefined) return {}

  // `git worktree add <path>` creates a branch named after the path's last part.
  return { branch: baseName(path), path }
}

function parseGit(words: readonly string[], cwd: string | undefined): Creation | undefined {
  let dir = cwd
  let i = 1
  for (; i < words.length; i++) {
    const word = words[i] as string
    if (!word.startsWith('-')) break
    if (word === '-C') dir = joinDir(dir, words[i + 1] ?? '')
    if (GIT_VALUE_OPTIONS.has(word)) i++
  }
  const subcommand = words[i]
  const args = words.slice(i + 1)
  const place = dir === undefined ? {} : { dir }

  if (subcommand === 'checkout') {
    const branch = valueAfter(args, ['-b', '-B', '--orphan'])

    return isLiteralName(branch) ? { branch, ...place } : undefined
  }
  if (subcommand === 'switch') {
    const branch = valueAfter(args, ['-c', '-C', '--create', '--force-create', '--orphan'])

    return isLiteralName(branch) ? { branch, ...place } : undefined
  }
  if (subcommand === 'branch') {
    const branch = parseBranch(args)

    return isLiteralName(branch) ? { branch, ...place } : undefined
  }
  if (subcommand === 'worktree' && args[0] === 'add') {
    const { branch, path } = parseWorktreeAdd(args.slice(1))
    if (!isLiteralName(branch) || path === undefined) return undefined

    return { branch, ...place, worktreePath: joinDir(dir, path) }
  }

  return undefined
}

/** A redirection (`2>/dev/null`, `> out`, `2>&1`) is no argument of git's: dropped with its target. */
function withoutRedirections(words: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    const redirection = /^(?:\d*|&)(?:>>?|<<<|<|>&|<&|>\|)(.*)$/.exec(word)
    if (redirection === null) kept.push(word)
    else if (redirection[1] === '') i++
  }

  return kept
}

/**
 * Every branch a command line creates, in order: `git checkout -b|-B|--orphan`,
 * `git switch -c|-C|--orphan`, `git branch <name> [start]`, `git worktree add`.
 *
 * Handles `git -C <dir>`, a leading `cd <dir>`, variable assignments before
 * `git`, redirections, comments, here-documents, and commands chained with
 * `&&`, `||`, `;`, `|`, `&` or a newline.
 */
export function parseBranchCreations(command: string): Creation[] {
  const found: Creation[] = []
  let cwd: string | undefined

  for (const all of splitCommands(command)) {
    const first = all.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
    if (first < 0) continue
    const words = all.slice(first)
    if (words[0] === 'cd') {
      // `cd` alone goes home; `cd -` goes back to a place the text does not say.
      const to = words[1]
      cwd = to === undefined ? '~' : to === '-' ? undefined : joinDir(cwd, to)
      continue
    }
    if (words[0] !== 'git') continue
    const creation = parseGit(withoutRedirections(words), cwd)
    if (creation !== undefined) found.push(creation)
  }

  return found
}
