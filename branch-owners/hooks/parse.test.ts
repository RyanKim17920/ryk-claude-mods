import { describe, expect, test } from 'claude-code/testing'

import { parseBranchCreations, splitCommands } from './parse'

const branches = (command: string) => parseBranchCreations(command).map(one => one.branch)

describe('parseBranchCreations', () => {
  test('finds each creating form', () => {
    expect(branches('git checkout -b feat/a')).toEqual(['feat/a'])
    expect(branches('git checkout -B feat/a origin/main')).toEqual(['feat/a'])
    expect(branches('git checkout --orphan docs')).toEqual(['docs'])
    expect(branches('git switch -c feat/b')).toEqual(['feat/b'])
    expect(branches('git switch -C feat/b main')).toEqual(['feat/b'])
    expect(branches('git switch --create feat/b')).toEqual(['feat/b'])
    expect(branches('git branch feat/c')).toEqual(['feat/c'])
    expect(branches('git branch feat/c origin/main')).toEqual(['feat/c'])
    expect(branches('git branch -f --no-track feat/c HEAD~1')).toEqual(['feat/c'])
    expect(branches('git branch -c old new')).toEqual(['new'])
  })

  test('leaves alone the forms that create nothing', () => {
    for (const command of [
      'git branch -d x',
      'git branch -D x',
      'git branch --delete x',
      'git branch --list',
      'git branch --list "feat/*"',
      'git branch',
      'git branch -a',
      'git branch -vv',
      'git branch -m old new',
      'git branch --show-current',
      'git branch --merged main',
      'git branch --no-merged main',
      'git branch -u origin/x x',
      'git branch 2>/dev/null',
      'git checkout main',
      'git checkout -- file',
      'git checkout -',
      'git switch main',
      'git switch -',
      'git worktree list',
      'git worktree remove ../wt',
      'git worktree add --detach ../wt',
      'git worktree add ../wt main',
      'git status',
      'git log --oneline -b',
      'ls -b x',
    ]) {
      expect(branches(command), command).toEqual([])
    }
  })

  test('never reads a quoted argument as a command', () => {
    expect(branches('echo "git checkout -b nope"')).toEqual([])
    expect(branches(`git commit -m 'wip && git checkout -b nope'`)).toEqual([])
    expect(branches('git commit -m "a; git branch nope"')).toEqual([])
  })

  test('never claims a name the shell would expand', () => {
    expect(branches('git checkout -b "$BRANCH"')).toEqual([])
    expect(branches('git switch -c feat/$(date +%s)')).toEqual([])
    expect(branches('git checkout -b `whoami`/x')).toEqual([])
    expect(branches('git checkout -b')).toEqual([])
  })

  test('reads a quoted literal name', () => {
    expect(branches(`git checkout -b 'feat/q'`)).toEqual(['feat/q'])
    expect(branches('git switch -c "feat/q"')).toEqual(['feat/q'])
  })

  test('follows chains, in order', () => {
    expect(branches('git fetch && git checkout -b one; git switch -c two || true')).toEqual(['one', 'two'])
    expect(branches('git stash\ngit checkout -b three | cat')).toEqual(['three'])
    expect(branches('(git checkout -b four)')).toEqual(['four'])
    expect(branches('git checkout -b five 2>&1')).toEqual(['five'])
  })

  test('reads where git ran from -C and a leading cd', () => {
    expect(parseBranchCreations('git -C /repo checkout -b a')).toEqual([{ branch: 'a', dir: '/repo' }])
    expect(parseBranchCreations('cd /repo && git switch -c a')).toEqual([{ branch: 'a', dir: '/repo' }])
    expect(parseBranchCreations('cd /repo && git -C sub branch a')).toEqual([{ branch: 'a', dir: '/repo/sub' }])
    expect(parseBranchCreations('git -c user.name=x -C /repo --no-pager checkout -b a')).toEqual([
      { branch: 'a', dir: '/repo' },
    ])
    expect(parseBranchCreations('GIT_PAGER=cat git checkout -b a')).toEqual([{ branch: 'a' }])
  })

  test('reads a worktree and its branch', () => {
    expect(parseBranchCreations('git worktree add -b feat/w ../wt')).toEqual([
      { branch: 'feat/w', worktreePath: '../wt' },
    ])
    expect(parseBranchCreations('git worktree add ../wt -b feat/w origin/main')).toEqual([
      { branch: 'feat/w', worktreePath: '../wt' },
    ])
    expect(parseBranchCreations('git worktree add /tmp/wt/topic')).toEqual([
      { branch: 'topic', worktreePath: '/tmp/wt/topic' },
    ])
    expect(parseBranchCreations('git -C /repo worktree add -B w .trees/w')).toEqual([
      { branch: 'w', dir: '/repo', worktreePath: '/repo/.trees/w' },
    ])
    expect(parseBranchCreations('git worktree add --lock --reason "in use" -b w ../w')).toEqual([
      { branch: 'w', worktreePath: '../w' },
    ])
  })
})

describe('parseBranchCreations, hardened forms', () => {
  test('reads a name attached to its flag', () => {
    expect(branches('git checkout -bfeat/a')).toEqual(['feat/a'])
    expect(branches('git checkout --orphan=docs')).toEqual(['docs'])
    expect(branches('git switch --create=feat/b')).toEqual(['feat/b'])
    expect(branches('git switch -cfeat/b')).toEqual(['feat/b'])
    expect(branches('git worktree add -bfeat/w ../w')).toEqual(['feat/w'])
  })

  test('reads nothing after a lone -- as an option', () => {
    expect(branches('git checkout -- -b x')).toEqual([])
    expect(branches('git checkout main -- -b')).toEqual([])
    expect(branches('git branch -- feat/x')).toEqual(['feat/x'])
    expect(branches('git worktree add -- ../wt')).toEqual(['wt'])
  })

  test('a redirection with its target apart is no argument', () => {
    expect(branches('git branch -c old new > /dev/null')).toEqual(['new'])
    expect(parseBranchCreations('git worktree add ../w > log 2>&1')).toEqual([{ branch: 'w', worktreePath: '../w' }])
    expect(branches('git branch x 2> err.txt')).toEqual(['x'])
    expect(branches('git branch x &>/dev/null')).toEqual(['x'])
    expect(branches('git branch x >&2')).toEqual(['x'])
  })

  test('2>&1 does not split the command, and a lone & still does', () => {
    expect(splitCommands('git branch x 2>&1 | cat')).toEqual([['git', 'branch', 'x', '2>&1'], ['cat']])
    expect(branches('git checkout -b bg & git checkout -b fg')).toEqual(['bg', 'fg'])
  })

  test('never reads a comment as a command', () => {
    expect(branches('git status # git checkout -b nope')).toEqual([])
    expect(branches('# git checkout -b nope\ngit checkout -b yes')).toEqual(['yes'])
    expect(branches('git commit -m wip#1 && git branch issue#2')).toEqual(['issue#2'])
  })

  test('never reads a here-document body as a command', () => {
    expect(branches(`cat > run.sh <<'EOF'\ngit checkout -b nope\nEOF\ngit checkout -b yes`)).toEqual(['yes'])
    expect(branches('cat <<-END | sh\n\tgit branch nope\n\tEND\ngit branch yes')).toEqual(['yes'])
    expect(branches('cat <<A <<B\ngit branch one\nA\ngit branch two\nB\ngit branch yes')).toEqual(['yes'])
    expect(branches('cat <<EOF\ngit branch nope')).toEqual([])
    expect(branches('git branch yes <<< "git branch nope"')).toEqual(['yes'])
  })

  test('a cd alone or to - leaves where git runs unknown or home', () => {
    expect(parseBranchCreations('cd /repo && cd - && git branch a')).toEqual([{ branch: 'a' }])
    expect(parseBranchCreations('cd && git branch a')).toEqual([{ branch: 'a', dir: '~' }])
    expect(parseBranchCreations('cd ~/r && git branch a')).toEqual([{ branch: 'a', dir: '~/r' }])
  })

  test('a line of assignments alone is no command', () => {
    expect(branches('A=1 B=2')).toEqual([])
    expect(branches('A=1 git branch a')).toEqual(['a'])
  })
})

describe('splitCommands', () => {
  test('splits on separators outside quotes', () => {
    expect(splitCommands(`a b && c "d && e"; f 'g;h' | i`)).toEqual([
      ['a', 'b'],
      ['c', 'd && e'],
      ['f', 'g;h'],
      ['i'],
    ])
    expect(splitCommands('a\\ b ""')).toEqual([['a b', '']])
  })
})
