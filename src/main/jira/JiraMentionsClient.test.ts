import { describe, expect, it, vi } from 'vitest'
import { buildMentionCandidateJql, JiraMentionsClient } from './JiraMentionsClient'
import type { JiraStoredSettings } from './JiraSettingsStore'
import { JIRA_INLINE_IMAGE_MAX_BYTES } from '../../shared/jiraMentions'

const settings: JiraStoredSettings = {
  baseUrl: 'https://jira.example.test', email: 'user@example.test', token: 'secret', patterns: [],
  mentionsEnabled: true, mentionsPollingEnabled: false, mentionsPollingMinutes: 15,
}

function response(status: number, body: unknown, retryAfter?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? retryAfter ?? null : null },
    json: async () => body,
  }
}

function rawComment(id: string, created: string, body: unknown, accountId = 'author-id') {
  return {
    id,
    author: { accountId, displayName: 'Author' },
    body,
    created,
    updated: created,
    visibility: null,
  }
}

describe('JiraMentionsClient', () => {
  it('fetches bounded inline image previews with authenticated ranged requests', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 206,
      headers: { get: (name: string) => ({
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
        'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      }[name.toLowerCase()] ?? null) },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
      json: async () => null,
    })

    const preview = await new JiraMentionsClient({ fetch }).fetchAttachmentPreview(
      settings,
      '10001',
      'image/png',
      bytes.byteLength,
    )

    expect(preview).toEqual({ mimeType: 'image/png', bytes })
    const init = fetch.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(fetch.mock.calls[0][0]).toBe('https://jira.example.test/rest/api/3/attachment/content/10001?redirect=false')
    expect(init.redirect).toBe('manual')
    expect(headers.get('Authorization')).toBe(`Basic ${Buffer.from('user@example.test:secret').toString('base64')}`)
    expect(headers.get('Range')).toBe(`bytes=0-${bytes.byteLength - 1}`)
    expect(headers.get('Accept')).toBe('*/*')
  })

  it('rejects a ranged preview when Jira content size disagrees with attachment metadata', async () => {
    const bytes = Uint8Array.from([1, 2, 3])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 206,
      headers: { get: (name: string) => ({
        'content-type': 'image/png',
        'content-range': 'bytes 0-2/3',
      }[name.toLowerCase()] ?? null) },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
      json: async () => null,
    })

    await expect(new JiraMentionsClient({ fetch }).fetchAttachmentPreview(
      settings, '10001', 'image/png', 4,
    )).rejects.toMatchObject({ code: 'invalid_response' })
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Range')).toBe('bytes=0-3')
  })

  it('follows only Jira media-service redirects without forwarding Jira credentials', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const mediaUrl = 'https://api.media.atlassian.com/file/ff4a5337-ab17-4572-ac66-04e3d869d92a/binary?token=signed&client=client-id&name=diagram.png'
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 303,
        headers: { get: (name: string) => name.toLowerCase() === 'location' ? mediaUrl : null },
        json: async () => null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: { get: (name: string) => ({
          'content-type': 'image/png',
          'content-length': String(bytes.byteLength),
          'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
        }[name.toLowerCase()] ?? null) },
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
        json: async () => null,
      })

    await expect(new JiraMentionsClient({ fetch }).fetchAttachmentPreview(
      settings, '10001', 'image/png', bytes.byteLength,
    )).resolves.toMatchObject({ mimeType: 'image/png', bytes })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('https://jira.example.test/rest/api/3/attachment/content/10001?redirect=false')
    expect((fetch.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
    expect(fetch.mock.calls[1][0]).toBe(mediaUrl)
    expect((fetch.mock.calls[1][1] as RequestInit).redirect).toBe('error')
    expect(new Headers((fetch.mock.calls[1][1] as RequestInit).headers).has('Authorization')).toBe(false)
  })

  it('rejects a Jira attachment redirect that points outside the Media Services host', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 303,
      headers: { get: (name: string) => name.toLowerCase() === 'location' ? 'https://attacker.example/file/image.png?token=signed&client=id' : null },
      json: async () => null,
    })
    await expect(new JiraMentionsClient({ fetch }).fetchAttachmentPreview(
      settings, '10001', 'image/png',
    )).rejects.toMatchObject({ code: 'invalid_response' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects unsafe image URLs and image data above the preview memory limit', async () => {
    const fetch = vi.fn()
    const client = new JiraMentionsClient({ fetch })
    await expect(client.fetchAttachmentPreview(settings, 'https://attacker.example/diagram.png', 'image/png')).rejects.toMatchObject({ code: 'validation' })
    await expect(client.fetchAttachmentPreview(settings, '10001', 'image/svg+xml')).rejects.toMatchObject({ code: 'validation' })
    await expect(client.fetchAttachmentPreview({ ...settings, baseUrl: 'http://jira.example.test' }, '10001', 'image/png')).rejects.toMatchObject({ code: 'validation' })
    expect(fetch).not.toHaveBeenCalled()

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 206,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/png' : name.toLowerCase() === 'content-range' ? `bytes 0-${JIRA_INLINE_IMAGE_MAX_BYTES - 1}/${JIRA_INLINE_IMAGE_MAX_BYTES + 1}` : null },
      arrayBuffer: vi.fn(),
      json: async () => null,
    })
    await expect(client.fetchAttachmentPreview(settings, '10001', 'image/png')).rejects.toMatchObject({ code: 'too_large' })
    expect(fetch.mock.calls[0][0]).toBe('https://jira.example.test/rest/api/3/attachment/content/10001?redirect=false')
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })

    const unboundedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(JIRA_INLINE_IMAGE_MAX_BYTES))
        controller.enqueue(Uint8Array.of(1))
        controller.close()
      },
    })
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/png' : null },
      body: unboundedBody,
      json: async () => null,
    })
    await expect(client.fetchAttachmentPreview(settings, '10001', 'image/png')).rejects.toMatchObject({ code: 'too_large' })
    expect(new Headers(fetch.mock.calls[1][1].headers).get('Range')).toBeNull()
  })

  it('retains custom-field names while identifying the existing user-valued query subset', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, [
      { id: 'customfield_10001', name: 'dEv TeStEr', schema: { type: 'user' } },
      { id: 'customfield_10002', name: 'Main Dev', schema: { type: 'array', items: 'user' } },
      { id: 'customfield_10003', name: 'Other Field', schema: { type: 'user' } },
      { id: 'customfield_10004', name: 'Dev Tester', schema: { type: 'string' } },
      { id: 'assignee', name: 'Assignee', schema: { type: 'user' } },
    ]))
    const client = new JiraMentionsClient({ fetch })
    const catalog = await client.getCustomFieldCatalog(settings)
    expect(catalog).toEqual([
      { id: 'customfield_10001', name: 'dEv TeStEr', userValued: true },
      { id: 'customfield_10002', name: 'Main Dev', userValued: true },
      { id: 'customfield_10003', name: 'Other Field', userValued: true },
      { id: 'customfield_10004', name: 'Dev Tester', userValued: false },
    ])
    expect(catalog.filter((field) => field.userValued).map((field) => field.id)).toEqual([
      'customfield_10001', 'customfield_10002', 'customfield_10003',
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps standard and comment users available when field discovery is permission-limited', async () => {
    const mention = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] }
    const incoming = rawComment('comment-1', '2026-10-16T10:00:00Z', mention, 'alice-id')
    const updated = '2026-10-16T11:00:00Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(403, { errorMessages: ['Field metadata is restricted'] }))
      .mockResolvedValueOnce(response(200, { id: '100', key: 'APP-1', fields: {
        summary: 'Request', updated, project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
        assignee: { accountId: 'assignee-id', displayName: 'Assignee' }, reporter: null, creator: null,
      } }))
    const client = new JiraMentionsClient({ fetch })
    const catalog = await client.getCustomFieldCatalog(settings)
    const userFieldIds = catalog.filter((field) => field.userValued).map((field) => field.id)
    expect(catalog).toEqual([])
    expect(userFieldIds).toEqual([])

    const snapshot = await client.fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'APP-1', updatedMarker: updated, updatedAt: Date.parse(updated), commentTotal: 1,
      inlineComments: [incoming], inlineStartAt: 0, inlineMaxResults: 20, summary: 'Request',
      project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
    }, userFieldIds, 'self-id')
    expect(snapshot.commentsComplete).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(snapshot.users.map((user) => user.accountId).sort()).toEqual(['alice-id', 'assignee-id', 'self-id'])
    const detailUrl = new URL(String(fetch.mock.calls[1][0]))
    expect(detailUrl.searchParams.get('fields')).toContain('assignee')
    expect(detailUrl.searchParams.get('fields')).not.toContain('comment')
    expect(detailUrl.searchParams.get('fields')).not.toContain('customfield_')
  })

  it('verifies the authenticated account and uses enhanced-search token pagination', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { accountId: 'self-id', displayName: 'Self', timeZone: 'America/Chicago' }))
      .mockResolvedValueOnce(response(200, {
        issues: [{ id: '1', key: 'OPS-1', fields: { summary: 'First', updated: '2026-10-16T12:00:00Z', project: { id: '1', key: 'OPS', name: 'Operations' }, comment: { startAt: 0, total: 0, comments: [] } } }],
        nextPageToken: 'next-1', isLast: false,
      }))
      .mockResolvedValueOnce(response(200, {
        issues: [{ id: '2', key: 'FIN-2', fields: { summary: 'Second', updated: '2026-10-16T12:01:00Z', project: { id: '2', key: 'FIN', name: 'Finance' }, comment: { startAt: 0, total: 0, comments: [] } } }],
        isLast: true,
      }))
    const client = new JiraMentionsClient({ fetch })
    await expect(client.getIdentity(settings)).resolves.toEqual({ accountId: 'self-id', displayName: 'Self', timeZone: 'America/Chicago' })
    const identityRequest = fetch.mock.calls[0][1] as RequestInit
    expect(fetch.mock.calls[0][0]).toBe('https://jira.example.test/rest/api/3/myself')
    expect(new Request(String(fetch.mock.calls[0][0]), identityRequest).method).toBe('GET')
    expect(new Headers(identityRequest.headers).get('Authorization')).toBe(`Basic ${Buffer.from('user@example.test:secret').toString('base64')}`)
    const candidateJql = buildMentionCandidateJql(Date.parse('2026-10-16T12:00:00Z'), 'UTC', 'self-id')
    expect(candidateJql).toBe('updated >= "2026/10/16 12:00" AND comment ~ "self-id" ORDER BY updated ASC, key ASC')
    expect(candidateJql).not.toMatch(/\b(project|status|assignee)\b\s*(=|in)\b/i)
    expect(buildMentionCandidateJql(Date.parse('2026-10-16T12:00:00Z'), 'UTC', 'self"id\\tail'))
      .toContain('comment ~ "self\\"id\\\\tail"')
    const results = await client.searchAll({ ...settings, patterns: ['APP-'] }, candidateJql)
    expect(results.map((issue) => issue.issueId)).toEqual(['1', '2'])
    expect(results.map((issue) => issue.project.key)).toEqual(['OPS', 'FIN'])
    expect(fetch.mock.calls[1][0]).toBe('https://jira.example.test/rest/api/3/search/jql')
    const firstRequest = fetch.mock.calls[1][1] as RequestInit
    expect(firstRequest.method).toBe('POST')
    expect(firstRequest.redirect).toBe('error')
    expect(JSON.parse(String(firstRequest.body))).toMatchObject({
      fields: ['summary', 'updated', 'comment', 'project'],
      jql: candidateJql,
    })
    expect(JSON.parse(String((fetch.mock.calls[2][1] as RequestInit).body))).toHaveProperty('nextPageToken', 'next-1')
  })

  it('completes paginated comment history, fetches selected detail for mentions, and checks stable markers', async () => {
    const mentionDoc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'self-id', text: '@Self' } }] }] }
    const older = rawComment('comment-1', '2026-10-15T10:00:00Z', { type: 'doc', version: 1, content: [] })
    const incoming = rawComment('comment-2', '2026-10-16T10:00:00Z', mentionDoc)
    const issueTime = '2026-10-16T11:00:00Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { comments: [older], startAt: 0, total: 2 }))
      .mockResolvedValueOnce(response(200, { comments: [incoming], startAt: 1, total: 2 }))
      .mockResolvedValueOnce(response(200, {
        id: '100', key: 'APP-1', fields: {
          summary: 'Summary',
          project: { id: '10', key: 'APP', name: 'Application', projectTypeKey: 'software' },
          status: { id: '3', name: 'Open', statusCategory: { name: 'To Do' } },
          issuetype: { name: 'Task' }, priority: { name: 'High' },
          assignee: { accountId: 'assignee-id', displayName: 'Assignee' }, reporter: { accountId: 'reporter-id', displayName: 'Reporter' },
          creator: { accountId: 'creator-id', displayName: 'Creator' },
          created: '2026-01-01T00:00:00Z', updated: issueTime, description: { type: 'doc', content: [] },
          attachment: [
            { id: 'att-1', filename: 'notes.txt', content: 'https://jira.example.test/rest/api/3/attachment/content/att-1', mimeType: 'text/plain', size: 10 },
            { id: 'att-2', filename: 'untrusted.txt', content: 'https://attacker.example/file.txt', mimeType: 'text/plain', size: 10 },
          ],
          customfield_10001: [{ accountId: 'custom-user', displayName: 'Custom User' }],
        },
      }))
      .mockResolvedValueOnce(response(200, { fields: { updated: issueTime, comment: { total: 2 } } }))
    const client = new JiraMentionsClient({ fetch, pageSize: 1 })
    const snapshot = await client.fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'APP-1', updatedMarker: issueTime, updatedAt: Date.parse(issueTime), commentTotal: 2,
      inlineComments: [older], inlineStartAt: 0, inlineMaxResults: 1, summary: 'Summary',
      project: { id: '10', key: 'APP', name: 'Application', projectTypeKey: 'software' },
    }, ['customfield_10001'], 'self-id')

    expect(snapshot.commentsComplete).toBe(true)
    expect(snapshot.comments).toHaveLength(2)
    expect(snapshot.issue).toMatchObject({ issueKey: 'APP-1', statusName: 'Open', priority: 'High' })
    expect(snapshot.issue.attachments).toEqual([
      expect.objectContaining({ id: 'att-1', contentUrl: 'https://jira.example.test/rest/api/3/attachment/content/att-1' }),
      expect.objectContaining({ id: 'att-2', contentUrl: null }),
    ])
    expect(snapshot.users.map((user) => user.accountId)).toEqual(expect.arrayContaining(['self-id', 'assignee-id', 'reporter-id', 'creator-id', 'custom-user']))
    expect(fetch.mock.calls[2][0]).toContain('fields=summary%2Cstatus')
    expect(fetch.mock.calls[2][0]).not.toContain('avatar')
    expect(fetch.mock.calls[3][0]).toContain('fields=updated%2Ccomment')
  })

  it('avoids issue and marker requests when complete inline comments contain no structured self mention', async () => {
    const fetch = vi.fn()
    const snapshot = await new JiraMentionsClient({ fetch }).fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'APP-1', updatedMarker: '2026-10-16T11:00:00Z', updatedAt: Date.parse('2026-10-16T11:00:00Z'), commentTotal: 0,
      inlineComments: [], inlineStartAt: 0, inlineMaxResults: 20, summary: 'Summary',
      project: { id: '10', key: 'APP', name: 'Application', projectTypeKey: 'software' },
    }, [], 'self-id')
    expect(snapshot.issue.statusName).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('honors pagination beyond one hundred comments and rejects non-advancing or inconsistent pages', async () => {
    const comments = Array.from({ length: 101 }, (_, index) => rawComment(String(index), new Date(1_700_000_000_000 + index * 1000).toISOString(), { type: 'doc', content: [] }))
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { comments: comments.slice(0, 50), startAt: 0, total: 101 }))
      .mockResolvedValueOnce(response(200, { comments: comments.slice(50, 100), startAt: 50, total: 101 }))
      .mockResolvedValueOnce(response(200, { comments: comments.slice(100), startAt: 100, total: 101 }))
      .mockResolvedValueOnce(response(200, { fields: { updated: '2023-11-14T22:13:20.000Z', comment: { total: 101 } } }))
    const client = new JiraMentionsClient({ fetch, pageSize: 50 })
    const result = await client.fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'APP-1', updatedMarker: null, updatedAt: null, commentTotal: 101,
      inlineComments: [], inlineStartAt: null, inlineMaxResults: null, summary: 'Summary',
      project: { id: null, key: null, name: null, projectTypeKey: null },
    }, [], 'self-id')
    expect(result.comments).toHaveLength(101)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('reads a complete 1,001-comment history for an account-ID JQL candidate', async () => {
    const issueTime = '2026-10-16T12:00:00.000Z'
    const selfMention = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'self-id', text: '@Self' } },
    ] }] }
    const allComments = Array.from({ length: 1_001 }, (_, index) => rawComment(
      `comment-${index}`,
      new Date(Date.parse('2026-10-15T00:00:00Z') + index * 1000).toISOString(),
      index === 1_000 ? selfMention : { type: 'doc', version: 1, content: [] },
    ))
    let requestedJql: string | null = null
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/search/jql')) {
        requestedJql = JSON.parse(String(init?.body)).jql
        return response(200, { issues: [{
        id: '100', key: 'APP-1', fields: {
          summary: 'Request', updated: issueTime,
          project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
          comment: { startAt: 0, maxResults: 20, total: allComments.length, comments: [] },
        },
        }], isLast: true })
      }
      if (url.pathname.endsWith('/issue/100/comment')) {
        const startAt = Number(url.searchParams.get('startAt'))
        const pageSize = Number(url.searchParams.get('maxResults'))
        return response(200, { comments: allComments.slice(startAt, startAt + pageSize), startAt, total: allComments.length })
      }
      if (url.pathname.endsWith('/issue/100')) {
        const fields = url.searchParams.get('fields')
        if (fields === 'updated,comment') return response(200, { fields: { updated: issueTime, comment: { total: allComments.length } } })
        return response(200, { id: '100', key: 'APP-1', fields: {
          summary: 'Request', updated: issueTime,
          project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
          status: { id: '1', name: 'Open', statusCategory: { name: 'To Do' } },
          comment: { total: allComments.length },
        } })
      }
      throw new Error(`Unexpected Jira fixture request: ${url.pathname}`)
    })
    const client = new JiraMentionsClient({ fetch, pageSize: 100 })
    const jql = buildMentionCandidateJql(Date.parse('2026-10-14T00:00:00Z'), 'UTC', 'self-id')
    const candidates = await client.searchAll(settings, jql)
    expect(candidates).toHaveLength(1)
    expect(requestedJql).toBe(jql)
    expect(jql).toContain('comment ~ "self-id"')

    const snapshot = await client.fetchIssueSnapshot(settings, candidates[0], [], 'self-id')
    expect(snapshot.commentsComplete).toBe(true)
    expect(snapshot.comments).toHaveLength(1_001)
    expect(snapshot.comments.at(-1)?.commentId).toBe('comment-1000')
    expect(snapshot.comments.at(-1)?.body).toEqual(selfMention)
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/comment?'))).toHaveLength(11)
  })

  it('rejects a comment snapshot whose issue update marker moves while pages are being read', async () => {
    const before = '2026-10-16T10:00:00.000Z'
    const after = '2026-10-16T10:01:00.000Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { comments: [rawComment('c1', before, { type: 'doc', content: [] })], startAt: 0, total: 2 }))
      .mockResolvedValueOnce(response(200, { comments: [rawComment('c2', before, { type: 'doc', content: [] })], startAt: 1, total: 2 }))
      .mockResolvedValueOnce(response(200, { fields: { updated: after, comment: { total: 2 } } }))
    const client = new JiraMentionsClient({ fetch, pageSize: 1 })

    await expect(client.fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'APP-1', updatedMarker: before, updatedAt: Date.parse(before), commentTotal: 2,
      inlineComments: [], inlineStartAt: null, inlineMaxResults: null, summary: 'Summary',
      project: { id: '10', key: 'APP', name: 'Application', projectTypeKey: 'software' },
    }, [], 'self-id')).rejects.toMatchObject({ code: 'invalid_response' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps safe retry feedback, refuses redirects, and broadens JQL when the account time zone is unavailable', async () => {
    const fetch = vi.fn().mockResolvedValue(response(429, { errorMessages: ['secret'] }, '120'))
    const client = new JiraMentionsClient({ fetch })
    await expect(client.getIdentity(settings)).rejects.toMatchObject({ code: 'rate_limited', retryAt: expect.any(Number) })
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
    expect(buildMentionCandidateJql(Date.parse('2026-10-16T00:00:00Z'), null, 'self-id'))
      .toContain('updated >= "2026/10/14 00:00" AND comment ~ "self-id"')
    expect(JSON.stringify({ code: 'rate_limited' })).not.toContain('secret')
  })

  it('rechecks a known issue directly and preserves a group ID in the only write request', async () => {
    const sentBody = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'author-id', text: '@Author' } }] }],
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, {
        id: '100', key: 'APP-1', fields: {
          summary: 'Summary', updated: '2026-10-16T12:00:00Z',
          comment: { startAt: 0, maxResults: 20, total: 1, comments: [] },
          project: { id: '10', key: 'APP', name: 'App', projectTypeKey: 'software' },
        },
      }))
      .mockResolvedValueOnce(response(201, {
        id: 'comment-reply', author: { accountId: 'self-id', displayName: 'Self' },
        body: sentBody, created: '2026-10-16T12:10:00Z', updated: '2026-10-16T12:10:00Z',
        visibility: { type: 'group', value: 'jira-developers', identifier: 'group-123' },
      }))
    const client = new JiraMentionsClient({ fetch })
    await expect(client.getIssueCandidate(settings, '100')).resolves.toMatchObject({ issueId: '100', issueKey: 'APP-1', commentTotal: 1 })
    expect(fetch.mock.calls[0][0]).toContain('/rest/api/3/issue/100?fields=summary%2Cupdated%2Ccomment%2Cproject')
    await expect(client.postComment(settings, '100', sentBody, { type: 'group', value: 'jira-developers', identifier: 'group-123' })).resolves.toMatchObject({
      commentId: 'comment-reply', authorAccountId: 'self-id',
      visibility: { type: 'group', value: 'jira-developers', identifier: 'group-123' },
    })
    const request = fetch.mock.calls[1][1] as RequestInit
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('error')
    expect(JSON.parse(String(request.body))).toEqual({
      body: sentBody,
      visibility: { type: 'group', value: 'jira-developers', identifier: 'group-123' },
    })
    expect(fetch.mock.calls[1][0]).toBe('https://jira.example.test/rest/api/3/issue/100/comment')
  })

  it('reads group-restricted visibility and its stable identifier in Jira response shape', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, {
      ...rawComment('comment-restricted', '2026-10-16T12:00:00Z', { type: 'doc', version: 1, content: [] }),
      visibility: { identifier: 'group-123', type: 'group', value: 'jira-developers' },
    }))
    const client = new JiraMentionsClient({ fetch })

    await expect(client.getComment(settings, '100', 'comment-restricted')).resolves.toMatchObject({
      commentId: 'comment-restricted',
      visibility: { type: 'group', value: 'jira-developers', identifier: 'group-123' },
    })
    expect(fetch.mock.calls[0][0]).toBe('https://jira.example.test/rest/api/3/issue/100/comment/comment-restricted')
    expect((fetch.mock.calls[0][1] as RequestInit).method).toBeUndefined()
  })

  it('treats an omitted Jira comment visibility as an unrestricted comment', async () => {
    const comment = { ...rawComment('public-comment', '2026-10-16T12:00:00Z', { type: 'doc', version: 1, content: [] }) }
    delete (comment as { visibility?: unknown }).visibility
    const fetch = vi.fn().mockResolvedValue(response(200, comment))
    await expect(new JiraMentionsClient({ fetch }).getComment(settings, '100', 'public-comment'))
      .resolves.toMatchObject({ commentId: 'public-comment', visibility: null })
  })

  it('reads public/internal audience for JSM comments and keeps it on the comment record', async () => {
    const mentionBody = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'self-id', text: '@Self' } },
    ] }] }
    const updated = '2026-10-16T12:00:00Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { id: '100', key: 'SD-1', fields: {
        summary: 'Request', updated, project: { id: '10', key: 'SD', name: 'Service Desk', projectTypeKey: 'service_desk' },
      } }))
      .mockResolvedValueOnce(response(200, { start: 0, limit: 100, isLastPage: true, values: [{ id: 'comment-internal', public: false }] }))
    const client = new JiraMentionsClient({ fetch })
    const snapshot = await client.fetchIssueSnapshot(settings, {
      issueId: '100', issueKey: 'SD-1', updatedMarker: updated, updatedAt: Date.parse(updated), commentTotal: 1,
      inlineComments: [rawComment('comment-internal', updated, mentionBody)], inlineStartAt: 0, inlineMaxResults: 20,
      summary: 'Request', project: { id: '10', key: 'SD', name: 'Service Desk', projectTypeKey: 'service_desk' },
    }, [], 'self-id')

    expect(snapshot.comments[0].visibility).toEqual({ type: 'service_desk', value: 'internal' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toBe('https://jira.example.test/rest/servicedeskapi/request/SD-1/comment?start=0&limit=100')
  })

  it('posts JSM replies with the source public/internal audience and verifies the created audience', async () => {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Internal reply' }] }] }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(201, {
        ...rawComment('reply-internal', '2026-10-16T12:10:00Z', body, 'self-id'),
        visibility: { identifier: 'group-123', type: 'group', value: 'jira-agents' },
      }))
      .mockResolvedValueOnce(response(200, { id: 'reply-internal', public: false }))
    const client = new JiraMentionsClient({ fetch })
    const visibility = {
      type: 'service_desk', value: 'internal',
      restriction: { type: 'group', value: 'jira-agents', identifier: 'group-123' },
    } as const

    await expect(client.postComment(settings, '100', body, visibility, 'SD-1')).resolves.toMatchObject({
      commentId: 'reply-internal', visibility,
    })
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({
      body,
      visibility: visibility.restriction,
      properties: [{ key: 'sd.public.comment', value: { internal: true } }],
    })
    expect(fetch.mock.calls[1][0]).toBe('https://jira.example.test/rest/servicedeskapi/request/SD-1/comment/reply-internal')
  })

  it('classifies Jira reply validation failures without exposing the response body', async () => {
    const fetch = vi.fn().mockResolvedValue(response(400, { errorMessages: ['secret validation detail'] }))
    await expect(new JiraMentionsClient({ fetch }).postComment(settings, '100', { type: 'doc', version: 1, content: [] }, null))
      .rejects.toMatchObject({ code: 'validation', status: 400 })
    expect(JSON.stringify(fetch.mock.calls[0])).not.toContain('secret validation detail')
  })

  it('classifies missing Add comments permission as a safe reply error', async () => {
    const fetch = vi.fn().mockResolvedValue(response(403, { errorMessages: ['secret permission detail'] }))
    await expect(new JiraMentionsClient({ fetch }).postComment(settings, '100', { type: 'doc', version: 1, content: [] }, null))
      .rejects.toMatchObject({ code: 'permission', status: 403 })
    expect(JSON.stringify(fetch.mock.calls[0])).not.toContain('secret permission detail')
  })
})
