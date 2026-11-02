import { describe, expect, it } from 'vitest'
import type { BoardCard, BoardCluster } from './boardApi'
import {
  mergeAnnouncement,
  mergeOptionLabel,
  mergeSummary,
  pruneSplitSelection,
  splitAnnouncement,
  splitCheckboxLabel,
  splitSelectionCount,
  validateSplit,
} from './clusterEdits'

function cluster(
  name: string,
  cardIds: readonly string[],
  clusterId = `id-${name}`,
): BoardCluster {
  return { clusterId, name, source: 'manual', cardIds }
}

const X = cluster('Process', ['a', 'b', 'c', 'd'])
const Y = cluster('Tools', ['e'])

describe('validateSplit', () => {
  it('returns the trimmed name for a valid split', () => {
    expect(validateSplit(X, ['b'], '  Docs \t', [X, Y])).toEqual({
      name: 'Docs',
    })
  })

  it('reports the messages in the design order', () => {
    // Nothing selected comes before a bad name.
    expect(validateSplit(X, [], '', [X, Y])).toEqual({
      error: {
        field: 'selection',
        message: 'Select at least one card to move.',
      },
    })
    // Everything selected comes before a bad name, and names the cluster.
    expect(validateSplit(X, ['d', 'c', 'b', 'a'], '', [X, Y])).toEqual({
      error: {
        field: 'selection',
        message:
          'Leave at least one card in Process. To rename the cluster, use Rename.',
      },
    })
    expect(validateSplit(X, ['a'], '   ', [X, Y])).toEqual({
      error: { field: 'name', message: 'Enter a cluster name.' },
    })
    expect(validateSplit(X, ['a'], 'x'.repeat(101), [X, Y])).toEqual({
      error: { field: 'name', message: 'Use 100 characters or fewer.' },
    })
    expect(validateSplit(X, ['a'], 'x'.repeat(100), [X, Y])).toEqual({
      name: 'x'.repeat(100),
    })
    // Every cluster's name counts, the one being split included.
    expect(validateSplit(X, ['a'], 'PROCESS', [X, Y])).toEqual({
      error: {
        field: 'name',
        message: 'A cluster with this name already exists.',
      },
    })
    expect(validateSplit(X, ['a'], 'tools', [X, Y])).toEqual({
      error: {
        field: 'name',
        message: 'A cluster with this name already exists.',
      },
    })
    expect(validateSplit(X, ['a'], 'ungrouped', [X, Y])).toEqual({
      error: {
        field: 'name',
        message: 'Choose a name other than Ungrouped.',
      },
    })
    const fifty = Array.from({ length: 50 }, (_unused, index) =>
      index === 0 ? X : cluster(`C${String(index)}`, []),
    )
    expect(validateSplit(X, ['a'], 'New', fifty)).toEqual({
      error: { field: 'name', message: 'This cycle already has 50 clusters.' },
    })
  })

  it('ignores selected ids that are no longer in the cluster', () => {
    expect(validateSplit(X, ['gone'], 'New', [X, Y])).toEqual({
      error: {
        field: 'selection',
        message: 'Select at least one card to move.',
      },
    })
    expect(validateSplit(X, ['a', 'b', 'c', 'gone'], 'New', [X, Y])).toEqual({
      name: 'New',
    })
  })
})

describe('pruneSplitSelection', () => {
  it('drops ids that left and keeps the cluster order', () => {
    expect(pruneSplitSelection(X, ['d', 'gone', 'b'])).toEqual(['b', 'd'])
    expect(pruneSplitSelection(X, [])).toEqual([])
    expect(pruneSplitSelection(cluster('Empty', []), ['a'])).toEqual([])
  })
})

describe('mergeSummary', () => {
  it('describes a merge of a non-empty source', () => {
    expect(mergeSummary(cluster('Tools', ['e', 'f']), X)).toBe(
      'Move the 2 cards of "Tools" to the end of "Process" and remove "Tools"? "Process" will have 6 cards.',
    )
    expect(mergeSummary(Y, cluster('Empty', []))).toBe(
      'Move the 1 card of "Tools" to the end of "Empty" and remove "Tools"? "Empty" will have 1 card.',
    )
  })

  it('describes a merge of an empty source', () => {
    expect(mergeSummary(cluster('Empty', []), X)).toBe(
      '"Empty" has no cards. Merging removes it.',
    )
  })
})

describe('labels and announcements', () => {
  const card: BoardCard = {
    cardId: 'a',
    category: 'start',
    text: `${'y'.repeat(40)}z`,
    isAnonymous: true,
  }

  it('builds the option, checkbox, count and status copy', () => {
    expect(mergeOptionLabel(X)).toBe('Process (4 cards)')
    expect(mergeOptionLabel(Y)).toBe('Tools (1 card)')
    expect(mergeOptionLabel(cluster('Empty', []))).toBe('Empty (0 cards)')
    expect(splitCheckboxLabel(card)).toBe(`Select card: ${'y'.repeat(40)}…`)
    expect(splitCheckboxLabel({ ...card, text: 'Short' })).toBe(
      'Select card: Short',
    )
    expect(splitSelectionCount(0, 4)).toBe('0 of 4 cards selected')
    expect(mergeAnnouncement('Tools', 'Process')).toBe(
      'Merged cluster Tools into Process.',
    )
    expect(splitAnnouncement(2, 'Docs')).toBe('Split 2 cards into Docs.')
    expect(splitAnnouncement(1, 'Docs')).toBe('Split 1 card into Docs.')
  })
})
