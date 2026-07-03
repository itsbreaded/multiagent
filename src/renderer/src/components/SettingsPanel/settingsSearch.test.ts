import { describe, expect, it } from 'vitest'
import { matchesSettingQuery } from './settingsSearch'

describe('matchesSettingQuery', () => {
  const keywords = 'git branch badges tabs panes terminal scrollback lines history memory buffer maximum server mcp update upgrades'
  it.each([['', true], ['scrollb', true], ['branch badges', true], ['badges branch', true], ['branch zebra', false], ['SERV', true], ['update', true], ['lines scrollback', true]])(
    'matches %j consistently', (query, expected) => expect(matchesSettingQuery(query, keywords)).toBe(expected),
  )
})
