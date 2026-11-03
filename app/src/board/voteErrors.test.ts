import { describe, expect, it } from 'vitest'
import { CLUSTER_GONE_MESSAGE } from './clusterErrors'
import {
  toVoteErrorCode,
  VOTE_ERROR_CODES,
  VOTE_ERROR_MESSAGES,
  voteErrorCodeOf,
  voteErrorMessage,
  VotesApiError,
  type VoteErrorCode,
} from './voteErrors'

const TABLE: Record<
  VoteErrorCode,
  { readonly add: string | null; readonly remove: string | null }
> = {
  not_project_member: { add: null, remove: null },
  cycle_not_voting: {
    add: 'Votes can only be changed during the Vote stage.',
    remove: 'Votes can only be changed during the Vote stage.',
  },
  cluster_not_found: {
    add: 'This cluster no longer exists.',
    remove: 'This cluster no longer exists.',
  },
  no_votes_remaining: {
    add: 'You have already used all 3 votes. Remove one to vote again.',
    remove: 'Could not remove your vote.',
  },
  no_vote_to_remove: {
    add: 'Could not add your vote.',
    remove: 'You have no vote on this cluster to remove.',
  },
  unknown: {
    add: 'Could not add your vote.',
    remove: 'Could not remove your vote.',
  },
}

describe('voteErrors', () => {
  it("lists exactly #22's five codes", () => {
    expect([...VOTE_ERROR_CODES]).toEqual([
      'not_project_member',
      'cycle_not_voting',
      'cluster_not_found',
      'no_votes_remaining',
      'no_vote_to_remove',
    ])
  })

  it.each(Object.entries(TABLE))(
    '%s has the Add and Remove copy of the table',
    (code, copy) => {
      const typed = code as VoteErrorCode
      expect(voteErrorMessage(typed, 'add')).toBe(copy.add)
      expect(voteErrorMessage(typed, 'remove')).toBe(copy.remove)
    },
  )

  it('has copy for every code and unknown, and none for not_project_member', () => {
    expect(Object.keys(VOTE_ERROR_MESSAGES).sort()).toEqual(
      [...VOTE_ERROR_CODES, 'unknown'].sort(),
    )
    expect(VOTE_ERROR_MESSAGES.not_project_member).toEqual({
      add: null,
      remove: null,
    })
    for (const code of VOTE_ERROR_CODES) {
      if (code !== 'not_project_member') {
        expect(VOTE_ERROR_MESSAGES[code].add).toEqual(expect.any(String))
        expect(VOTE_ERROR_MESSAGES[code].remove).toEqual(expect.any(String))
      }
    }
  })

  it('reuses the cluster copy for cluster_not_found', () => {
    expect(voteErrorMessage('cluster_not_found', 'add')).toBe(
      CLUSTER_GONE_MESSAGE,
    )
  })

  it('maps each code to itself and anything else to unknown', () => {
    for (const code of VOTE_ERROR_CODES) {
      expect(toVoteErrorCode(code)).toBe(code)
    }
    for (const message of [
      null,
      undefined,
      '',
      'voting_not_closed',
      'NO_VOTES_REMAINING',
      ' no_votes_remaining',
    ]) {
      expect(toVoteErrorCode(message)).toBe('unknown')
    }
  })

  it('reads the code of a VotesApiError, and unknown from anything else', () => {
    expect(voteErrorCodeOf(new VotesApiError('cycle_not_voting'))).toBe(
      'cycle_not_voting',
    )
    expect(voteErrorCodeOf(new Error('cycle_not_voting'))).toBe('unknown')
    expect(voteErrorCodeOf('cycle_not_voting')).toBe('unknown')
  })

  it('a VotesApiError carries only its code', () => {
    const error = new VotesApiError('no_vote_to_remove')
    expect(error.message).toBe('no_vote_to_remove')
    expect(error.name).toBe('VotesApiError')
    expect(Object.keys(error).sort()).toEqual(['code', 'name'])
  })
})
