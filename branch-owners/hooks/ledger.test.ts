import { describe, expect, test } from 'claude-code/testing'

import { MAX_ENTRIES, claim, compact, formatAge, formatTable, parseBranchNames, parseLedger, parseRefs, prune, toExport, toRows, without, worktreeOf } from './ledger'
import type { Ledger, Owned, Ref } from './ledger'

const owned = (branch: string, over: Partial<Owned> = {}): Owned => ({
  branch,
  owner: 'main',
  sessionId: 's1',
  createdAt: 1_000,
  createdSha: 'aaa',
  ...over,
})
const ref = (branch: string, sha: string, committedAt = 0): Ref => ({
  branch,
  sha,
  shortSha: sha.slice(0, 7),
  committedAt,
})

describe('claim', () => {
  test('first writer wins', () => {
    const first = claim({}, owned('x', { owner: 'builder' }))
    const second = claim(first, owned('x', { owner: 'reviewer' }))

    expect(second).toBe(first)
    expect(second.x?.owner).toBe('builder')
  })

  test('a branch named like an object member is an ordinary branch', () => {
    const ledger = claim({}, owned('constructor'))

    expect(Object.keys(ledger)).toEqual(['constructor'])
    expect(toRows({}, [ref('toString', 'abc')], ['toString'])[0]?.owner).toBe('unknown')
  })
})

describe('parsing git output', () => {
  test('reads for-each-ref lines and skips broken ones', () => {
    expect(parseRefs('main\tabc123\tabc\t1700000000\nfeat/x\tdef456\tdef\t\n\ngarbage\n')).toEqual([
      { branch: 'main', sha: 'abc123', shortSha: 'abc', committedAt: 1_700_000_000 },
      { branch: 'feat/x', sha: 'def456', shortSha: 'def', committedAt: 0 },
    ])
    expect(parseBranchNames('  a\nb  \n\n')).toEqual(['a', 'b'])
  })
})

describe('worktreeOf', () => {
  const porcelain = [
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main',
    'worktree /trees/w one\nHEAD bbb\nbranch refs/heads/feat/w',
    'worktree /trees/d\nHEAD ccc\ndetached',
  ].join('\n\n')

  test('the absolute path of the worktree a branch is checked out in', () => {
    expect(worktreeOf(porcelain, 'feat/w')).toBe('/trees/w one')
    expect(worktreeOf(porcelain, 'main')).toBe('/repo')
    expect(worktreeOf(porcelain, 'feat')).toBeUndefined()
    expect(worktreeOf('', 'main')).toBeUndefined()
  })
})

describe('prune', () => {
  const ledger: Ledger = {
    open: owned('open', { createdSha: 'o0' }),
    merged: owned('merged', { createdSha: 'm0' }),
    fresh: owned('fresh', { createdSha: 'f0' }),
    deleted: owned('deleted'),
  }
  const refs = [ref('open', 'o1'), ref('merged', 'm1'), ref('fresh', 'f0'), ref('main', 'f0')]

  test('drops deleted and merged branches, keeps open ones', () => {
    expect(Object.keys(prune(ledger, refs, ['open']))).toEqual(['open', 'fresh'])
  })

  test('keeps a branch with no commits yet, which git reports as merged', () => {
    expect(prune(ledger, refs, ['open']).fresh?.createdSha).toBe('f0')
  })

  test('drops a merged branch that was created and committed in one command', () => {
    const committed: Ledger = { fresh: owned('fresh', { createdSha: 'f0', wasFresh: false }) }

    expect(prune(committed, refs, ['open'])).toEqual({})
    expect(Object.keys(prune(committed, refs, ['open', 'fresh']))).toEqual(['fresh'])
  })
})

describe('parseLedger', () => {
  test('anything but an object of well-formed records reads as empty', () => {
    for (const stored of [undefined, null, 'x', 42, ['a'], true]) expect(parseLedger(stored)).toEqual({})
  })

  test('keeps well-formed records, drops the rest', () => {
    const good = owned('good', { wasFresh: false, ownerAgentId: 'a1', worktreePath: '/w' })
    const stored = {
      good,
      renamed: owned('other'),
      noOwner: { ...owned('noOwner'), owner: 3 },
      badTime: { ...owned('badTime'), createdAt: 'yesterday' },
      badFresh: { ...owned('badFresh'), wasFresh: 'yes' },
      list: [],
      constructor: owned('constructor'),
    }

    expect(parseLedger(stored)).toEqual({ good, constructor: owned('constructor') })
  })
})

describe('compact', () => {
  const ledger: Ledger = { a: owned('a', { createdAt: 1 }), b: owned('b', { createdAt: 3 }), c: owned('c', { createdAt: 2 }) }

  test('drops branches that no longer exist', () => {
    expect(Object.keys(compact(ledger, new Set(['a', 'c', 'zzz'])))).toEqual(['a', 'c'])
  })

  test('keeps the newest claims past the cap', () => {
    expect(Object.keys(compact(ledger, undefined, 2)).sort()).toEqual(['b', 'c'])
    expect(compact(ledger, undefined, 0)).toEqual({})
  })

  test('answers the ledger itself when nothing is dropped', () => {
    expect(compact(ledger, undefined)).toBe(ledger)
    expect(compact(ledger, new Set(['a', 'b', 'c']))).toBe(ledger)
    expect(MAX_ENTRIES).toBeGreaterThan(0)
  })
})

describe('without', () => {
  test('removes only the dropped branches, keeping ones added since', () => {
    const current: Ledger = { a: owned('a'), b: owned('b'), added: owned('added') }

    expect(Object.keys(without(current, ['a', 'gone']))).toEqual(['b', 'added'])
    expect(without(current, ['gone'])).toBe(current)
  })
})

describe('the table', () => {
  const refs = [ref('feat/new', 'bbbbbbbbbb', 990_000), ref('feat/old', 'aaaaaaaaaa', 100_000), ref('main', 'cccccccccc', 999_000)]
  const ledger: Ledger = { 'feat/old': owned('feat/old', { owner: 'grader-fairness', ownerAgentId: 'a1' }) }
  const rows = toRows(ledger, refs, ['feat/new', 'feat/old'])

  test('lists unmerged branches only, oldest first, unknown where unowned', () => {
    expect(rows.map(row => [row.branch, row.owner])).toEqual([
      ['feat/old', 'grader-fairness'],
      ['feat/new', 'unknown'],
    ])
  })

  test('formats aligned columns and a summary line', () => {
    expect(formatTable(rows, 'origin/main', 1_000_000_000)).toBe(
      [
        '2 branches unmerged into origin/main, 1 with no known owner:',
        'branch    owner            age  head',
        'feat/old  grader-fairness  10d  aaaaaaa',
        'feat/new  unknown          2h   bbbbbbb',
      ].join('\n'),
    )
    expect(formatTable([], 'main', 0)).toBe('No branches unmerged into main.')
  })

  test('formats ages', () => {
    expect([59, 3599, 3600, 86_399, 86_400, -1, Number.NaN].map(formatAge)).toEqual(['0m', '59m', '1h', '23h', '1d', '?', '?'])
  })

  test('exports the same rows as JSON', () => {
    const exported = JSON.parse(toExport('/repo', 'main', rows, 1_000_000_000))

    expect(exported.repo).toBe('/repo')
    expect(exported.branches).toHaveLength(2)
    expect(exported.branches[0]).toEqual({
      branch: 'feat/old',
      owner: 'grader-fairness',
      ownerAgentId: 'a1',
      sessionId: 's1',
      createdAt: '1970-01-01T00:00:01.000Z',
      worktreePath: null,
      sha: 'aaaaaaaaaa',
      shortSha: 'aaaaaaa',
      lastCommitAt: '1970-01-02T03:46:40.000Z',
    })
    expect(exported.branches[1].ownerAgentId).toBe(null)
  })
})
