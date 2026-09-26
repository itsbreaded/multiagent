import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JIRA_BASE_URL,
  buildJiraIssueUrl,
  matchJiraIssueLabel,
  normalizeJiraBaseUrl,
  normalizeJiraPatterns,
} from './jira'

describe('jira shared contracts', () => {
  it('normalizes prefixes without duplicates or whitespace patterns', () => {
    expect(normalizeJiraPatterns([' DZ- ', 'dz-', '', 'X Y', null])).toEqual(['DZ-'])
  })

  it('matches only the exact leading whitespace-delimited issue token', () => {
    expect(matchJiraIssueLabel('DZ-1234', ['DZ-'])?.issueKey).toBe('DZ-1234')
    expect(matchJiraIssueLabel('dz-1234 ticket', ['DZ-'])?.issueKey).toBe('dz-1234')
    expect(matchJiraIssueLabel('X-DZ-1234', ['DZ-'])).toBeNull()
    expect(matchJiraIssueLabel('DZ-ABC', ['DZ-'])).toBeNull()
    expect(matchJiraIssueLabel('DZ-1234abc', ['DZ-'])).toBeNull()
    expect(matchJiraIssueLabel('DZ-1234.', ['DZ-'])).toBeNull()
  })

  it('normalizes and validates safe HTTP(S) Jira bases', () => {
    expect(DEFAULT_JIRA_BASE_URL).toBe('')
    expect(normalizeJiraBaseUrl('https://jira.example.com/')).toBe('https://jira.example.com')
    expect(normalizeJiraBaseUrl('https://jira.example.test/jira///')).toBe('https://jira.example.test/jira')
    expect(normalizeJiraBaseUrl('https://user:pass@jira.example.test')).toBeNull()
    expect(normalizeJiraBaseUrl('https://jira.example.test?token=secret')).toBeNull()
    expect(normalizeJiraBaseUrl('file:///tmp/jira')).toBeNull()
  })

  it('builds an issue URL only for a validated Jira key', () => {
    expect(buildJiraIssueUrl('https://jira.example.com', 'DEMO-1955')).toBe(
      'https://jira.example.com/browse/DEMO-1955',
    )
    expect(buildJiraIssueUrl('https://jira.example.com', 'javascript:alert(1)')).toBeNull()
  })
})
