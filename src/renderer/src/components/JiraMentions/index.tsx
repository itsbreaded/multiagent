import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JiraAttachmentMetadata, JiraCommentRecord, JiraIssueMetadata, JiraMentionProjectionItem, JiraQuickSnooze, JiraReplyDraftToken, JiraUserReference } from '../../../../shared/jiraMentions'
import { getQuickSnoozeUntil, normalizeJiraInlineImageMimeType, orderMentionItems, type JiraAttachmentPreviewResult } from '../../../../shared/jiraMentions'
import { useJiraMentionsStore, type JiraMentionsFilter } from '../../store/jiraMentions'
import { usePanesStore } from '../../store/panes'
import refreshIcon from '../../assets/refresh.png'
import closeIcon from '../../assets/close.png'
import { border, ui } from '../../styles/theme'

const buttonStyle: React.CSSProperties = {
  border: border.default, borderRadius: 5, background: ui.color.control, color: ui.color.text,
  fontSize: 11, padding: '5px 9px', cursor: 'pointer',
}
const linkButtonStyle: React.CSSProperties = {
  border: 0, background: 'transparent', padding: 0, color: ui.color.accent, font: 'inherit',
  textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer',
}
const issuePropertyChipStyle: React.CSSProperties = {
  borderRadius: 4, padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap',
}
const jiraStatusStyles: Record<'new' | 'in-progress' | 'done', React.CSSProperties> = {
  new: { color: ui.color.jiraStatusNew, background: ui.color.jiraStatusNewBackground, border: `1px solid ${ui.color.jiraStatusNewBorder}` },
  'in-progress': { color: ui.color.jiraStatusProgress, background: ui.color.jiraStatusProgressBackground, border: `1px solid ${ui.color.jiraStatusProgressBorder}` },
  done: { color: ui.color.jiraStatusDone, background: ui.color.jiraStatusDoneBackground, border: `1px solid ${ui.color.jiraStatusDoneBorder}` },
}
const jiraIssueTypeStyle: React.CSSProperties = {
  ...issuePropertyChipStyle, color: ui.color.jiraIssueType, background: ui.color.jiraIssueTypeBackground,
  border: `1px solid ${ui.color.jiraIssueTypeBorder}`,
}
const jiraPriorityStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, color: ui.color.jiraPriority,
  borderLeft: border.default, paddingLeft: 9, marginLeft: 1, fontSize: 11, whiteSpace: 'nowrap',
}
const jiraAssigneeStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, paddingLeft: 8, fontSize: 11, whiteSpace: 'nowrap',
}
const DESCRIPTION_MIN_HEIGHT = 90
const DESCRIPTION_MAX_HEIGHT = 360
const DESCRIPTION_MAX_VIEWPORT_RATIO = 0.35
const MIN_REPLY_EDITOR_HEIGHT = 95
const MAX_REPLY_EDITOR_HEIGHT = 300

type JiraStatusGroup = 'new' | 'in-progress' | 'done'
type JiraIssueProperty = { label: string; value: string; kind: 'status' | 'type' | 'priority' | 'assignee'; statusGroup?: JiraStatusGroup }

function jiraStatusGroup(category: string | null | undefined): JiraStatusGroup {
  const normalized = category?.trim().toLowerCase() ?? ''
  if (normalized.includes('done')) return 'done'
  if (normalized.includes('new') || normalized.includes('to do') || normalized.includes('todo')) return 'new'
  return 'in-progress'
}

function displayTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function stateMessage(status: string, code: string | null): string {
  if (code === 'invalid_config') return 'Add a Jira site, email, and token in Settings to start tracking.'
  if (code === 'auth') return 'Jira rejected the saved credentials. Update them in Settings.'
  if (code === 'permission') return 'Jira denied access to some issues. The inbox keeps the last complete results.'
  if (code === 'rate_limited') return 'Jira asked MultiAgent to wait before checking again.'
  if (code === 'validation') return 'Jira rejected a request. Check the Jira settings and try again.'
  if (code === 'network') return 'Jira could not be reached. Showing the last complete results.'
  if (code === 'database_unavailable') return 'Local Jira data is unavailable because the application database could not be opened.'
  if (status === 'partial') return 'This check was incomplete. The last complete inbox is still shown.'
  if (status === 'loading') return 'Checking Jira…'
  if (status === 'not-checked') return 'Jira mentions have not been checked yet.'
  return 'Jira mentions could not be refreshed. The last complete inbox is still shown.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function adfChildren(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.content) ? value.content : []
}

type AdfRenderContext = {
  issueId: string
  attachments: readonly JiraAttachmentMetadata[]
  comment: JiraCommentRecord
  inferredAttachmentIds: Set<string>
}

type AttachmentPreviewCacheContextValue = {
  scopeKey: string
  load: (issueId: string, attachmentId: string) => Promise<JiraAttachmentPreviewResult>
}

const AttachmentPreviewCacheContext = createContext<AttachmentPreviewCacheContextValue | null>(null)

function AttachmentPreviewCacheProvider({ scopeKey, children }: { scopeKey: string; children: React.ReactNode }): JSX.Element {
  const requests = useRef<{ scopeKey: string; byAttachment: Map<string, Promise<JiraAttachmentPreviewResult>> }>({
    scopeKey,
    byAttachment: new Map(),
  })
  if (requests.current.scopeKey !== scopeKey) {
    requests.current = { scopeKey, byAttachment: new Map() }
  }

  const load = useCallback((issueId: string, attachmentId: string): Promise<JiraAttachmentPreviewResult> => {
    const entries = requests.current.byAttachment
    const existing = entries.get(attachmentId)
    if (existing) return existing

    let request: Promise<JiraAttachmentPreviewResult>
    request = window.ipc.invoke('jira-mentions:get-attachment-preview', issueId, attachmentId)
      .catch((): JiraAttachmentPreviewResult => ({ ok: false, reason: 'unavailable' }))
      .then((result) => {
        if (!result.ok && entries.get(attachmentId) === request) entries.delete(attachmentId)
        return result
      })
    entries.set(attachmentId, request)
    return request
  }, [])

  const value = useMemo(() => ({ scopeKey, load }), [scopeKey, load])
  return <AttachmentPreviewCacheContext.Provider value={value}>{children}</AttachmentPreviewCacheContext.Provider>
}

function resolveAdfAttachment(attrs: Record<string, unknown>, context: AdfRenderContext): JiraAttachmentMetadata | null {
  if (attrs.type !== undefined && attrs.type !== 'file') return null
  const mediaId = typeof attrs.id === 'string' ? attrs.id : typeof attrs.id === 'number' ? String(attrs.id) : null
  const exactId = mediaId ? context.attachments.find((item) => item.id === mediaId) : undefined
  if (exactId) return exactId

  const alt = typeof attrs.alt === 'string' ? attrs.alt.trim().toLocaleLowerCase() : ''
  if (alt) {
    const nameMatches = context.attachments.filter((item) => item.name.trim().toLocaleLowerCase() === alt
      && normalizeJiraInlineImageMimeType(item.mimeType))
    if (nameMatches.length === 1) return nameMatches[0]
    return null
  }

  const comment = context.comment
  if (!comment.authorAccountId) return null
  const nearbyByAuthor = context.attachments.filter((item) => item.author?.accountId === comment.authorAccountId
    && item.createdAt !== null && Math.abs(item.createdAt - comment.createdAt) <= 5 * 60_000
    && !context.inferredAttachmentIds.has(item.id)
    && normalizeJiraInlineImageMimeType(item.mimeType))
  if (nearbyByAuthor.length !== 1) return null
  context.inferredAttachmentIds.add(nearbyByAuthor[0].id)
  return nearbyByAuthor[0]
}

function JiraInlineImage({ issueId, attachment, alt, inline = false, linkMode = false, thumbnailMode = false }: { issueId: string; attachment: JiraAttachmentMetadata; alt?: string; inline?: boolean; linkMode?: boolean; thumbnailMode?: boolean }): JSX.Element {
  const previewCache = useContext(AttachmentPreviewCacheContext)
  const targetRef = useRef<HTMLSpanElement | null>(null)
  const [state, setState] = useState<{ kind: 'idle' | 'loading' | 'unavailable' | 'too_large' | 'unsupported' | 'ready'; url?: string }>({ kind: 'idle' })
  const [viewerOpen, setViewerOpen] = useState(false)
  const [loadRequested, setLoadRequested] = useState(!linkMode || thumbnailMode)
  const imageAlt = alt?.trim() || attachment.name

  useEffect(() => {
    if (linkMode && !loadRequested) return
    setState({ kind: 'idle' })
    let cancelled = false
    let objectUrl: string | null = null
    let requested = false
    let observer: IntersectionObserver | null = null
    const load = () => {
      if (requested) return
      requested = true
      setState({ kind: 'loading' })
      if (!previewCache) {
        setState({ kind: 'unavailable' })
        return
      }
      void previewCache.load(issueId, attachment.id).then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setState({ kind: result.reason })
          return
        }
        const imageBuffer = new ArrayBuffer(result.bytes.byteLength)
        new Uint8Array(imageBuffer).set(result.bytes)
        objectUrl = URL.createObjectURL(new Blob([imageBuffer], { type: result.mimeType }))
        setState({ kind: 'ready', url: objectUrl })
      }).catch(() => {
        if (!cancelled) setState({ kind: 'unavailable' })
      })
    }

    const target = targetRef.current
    if (linkMode || !target || typeof IntersectionObserver === 'undefined') load()
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect()
          load()
        }
      }, { rootMargin: '160px' })
      observer.observe(target)
    }

    return () => {
      cancelled = true
      observer?.disconnect()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.id, issueId, linkMode, loadRequested, previewCache])

  useEffect(() => {
    if (!viewerOpen) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewerOpen(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewerOpen])

  if (state.kind !== 'ready' || !state.url) {
    if (linkMode && state.kind === 'idle') {
      if (thumbnailMode) {
        return <span ref={targetRef} role="status" title={attachment.name} style={{ boxSizing: 'border-box', width: 132, height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 7, border: border.default, borderRadius: 5, background: ui.color.panelSubtle, color: ui.color.textMuted, fontSize: 10, textAlign: 'center', overflowWrap: 'anywhere' }}>Loading preview…</span>
      }
      return <span ref={targetRef} style={{ display: 'inline-block' }}>
        <button type="button" aria-label={`Preview image ${attachment.name}`} title="Preview image in MultiAgent" onClick={() => setLoadRequested(true)} style={{ ...linkButtonStyle, color: ui.color.text, fontSize: 10 }}>{attachment.name}</button>
      </span>
    }
    if (thumbnailMode) {
      const label = state.kind === 'loading' ? 'Loading preview…'
        : state.kind === 'too_large' ? 'Image is too large to preview'
          : state.kind === 'unsupported' ? 'Image format is unsupported'
            : 'Image preview unavailable'
      return <span ref={targetRef} role={state.kind === 'loading' ? 'status' : undefined} title={`${label}: ${attachment.name}`} style={{ boxSizing: 'border-box', width: 132, height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 7, border: border.default, borderRadius: 5, background: ui.color.panelSubtle, color: ui.color.textMuted, fontSize: 10, textAlign: 'center', overflowWrap: 'anywhere' }}>{label}</span>
    }
    const label = state.kind === 'idle' || state.kind === 'loading'
      ? `Loading image preview: ${attachment.name}`
      : state.kind === 'too_large' ? `Image is too large to preview: ${attachment.name}`
        : state.kind === 'unsupported' ? `Image format cannot be previewed: ${attachment.name}`
          : `Image preview unavailable: ${attachment.name}`
    return <span ref={targetRef} role={state.kind === 'loading' ? 'status' : undefined} style={{ display: 'inline-block', padding: '7px 9px', border: border.default, borderRadius: 5, color: ui.color.textMuted, fontSize: 11 }}>{label}</span>
  }

  return <>
    <button type="button" aria-label={`Zoom image ${attachment.name}`} title="Click to zoom" onClick={() => setViewerOpen(true)} style={{ display: inline ? 'inline-block' : 'block', verticalAlign: 'middle', width: thumbnailMode ? 132 : undefined, height: thumbnailMode ? 88 : undefined, boxSizing: 'border-box', maxWidth: '100%', border: border.default, borderRadius: 5, background: ui.color.panelSubtle, padding: 3, cursor: 'zoom-in' }}>
      <img src={state.url} alt={imageAlt} style={thumbnailMode ? { display: 'block', width: '100%', height: '100%', objectFit: 'contain' } : { display: 'block', maxWidth: 'min(100%, 640px)', maxHeight: inline ? 180 : 360, objectFit: 'contain' }} />
    </button>
    {viewerOpen && <div role="dialog" aria-modal="true" aria-label={`Image preview: ${attachment.name}`} onClick={(event) => { if (event.target === event.currentTarget) setViewerOpen(false) }} style={{ position: 'fixed', inset: 0, zIndex: 5000, display: 'grid', placeItems: 'center', padding: 28, background: 'rgba(0, 0, 0, 0.86)' }}>
      <button type="button" aria-label="Close image preview" onClick={() => setViewerOpen(false)} style={{ position: 'absolute', top: 16, right: 18, display: 'grid', placeItems: 'center', width: 34, height: 34, padding: 8, border: border.default, borderRadius: 5, background: ui.color.panel, cursor: 'pointer' }}>
        <img src={closeIcon} alt="" style={{ display: 'block', width: 16, height: 16, filter: 'brightness(0) invert(1)' }} />
      </button>
      <img src={state.url} alt={imageAlt} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }} />
      <span style={{ position: 'absolute', bottom: 12, left: 16, color: ui.color.textMuted, fontSize: 11 }}>{attachment.name}</span>
    </div>}
  </>
}

function renderAdf(value: unknown, key = 'adf', context?: AdfRenderContext): React.ReactNode {
  if (Array.isArray(value)) return value.map((child, index) => <React.Fragment key={`${key}-${index}`}>{renderAdf(child, `${key}-${index}`, context)}</React.Fragment>)
  if (!isRecord(value)) return null
  if (value.type === 'text') return typeof value.text === 'string' ? value.text : null
  if (value.type === 'mention') {
    const attrs = isRecord(value.attrs) ? value.attrs : {}
    const label = typeof attrs.text === 'string' ? attrs.text : typeof attrs.displayName === 'string' ? `@${attrs.displayName}` : '@Unknown user'
    return <span key={key} style={{ color: ui.color.accent, background: ui.color.accentBg, borderRadius: 3, padding: '1px 3px' }}>{label}</span>
  }
  if (value.type === 'hardBreak') return <br key={key} />
  const attrs = isRecord(value.attrs) ? value.attrs : {}
  if (value.type === 'media' || value.type === 'mediaInline') {
    const attachment = context ? resolveAdfAttachment(attrs, context) : null
    if (!context || !attachment) return <span key={key} style={{ color: ui.color.textMuted, fontSize: 11 }}>Attachment preview unavailable</span>
    const alt = typeof attrs.alt === 'string' ? attrs.alt : undefined
    if (normalizeJiraInlineImageMimeType(attachment.mimeType)) {
      return <JiraInlineImage key={key} issueId={context.issueId} attachment={attachment} alt={alt} inline={value.type === 'mediaInline'} />
    }
    return <span key={key} style={{ color: ui.color.textMuted, fontSize: 11 }}>[Attachment: {attachment.name}]</span>
  }
  const children = adfChildren(value)
  const body = children.map((child, index) => <React.Fragment key={`${key}-${index}`}>{renderAdf(child, `${key}-${index}`, context)}</React.Fragment>)
  const spanProps = {
    ...(Number.isInteger(attrs.colspan) && Number(attrs.colspan) > 1 ? { colSpan: Number(attrs.colspan) } : {}),
    ...(Number.isInteger(attrs.rowspan) && Number(attrs.rowspan) > 1 ? { rowSpan: Number(attrs.rowspan) } : {}),
  }
  switch (value.type) {
    case 'doc': return <React.Fragment key={key}>{body}</React.Fragment>
    case 'paragraph': return <p key={key} style={{ margin: '0 0 8px', lineHeight: 1.55 }}>{body}</p>
    case 'heading': return <div key={key} style={{ fontWeight: 650, margin: '10px 0 6px' }}>{body}</div>
    case 'blockquote': return <blockquote key={key} style={{ margin: '6px 0', paddingLeft: 10, borderLeft: border.default, color: ui.color.textMuted }}>{body}</blockquote>
    case 'bulletList': return <ul key={key} style={{ margin: '4px 0', paddingLeft: 22 }}>{body}</ul>
    case 'orderedList': return <ol key={key} style={{ margin: '4px 0', paddingLeft: 22 }}>{body}</ol>
    case 'listItem': return <li key={key}>{body}</li>
    case 'codeBlock': return <pre key={key} style={{ whiteSpace: 'pre-wrap', background: ui.color.input, padding: 8, borderRadius: 4 }}>{body}</pre>
    case 'table': return <div key={key} style={{ maxWidth: '100%', overflowX: 'auto' }}><table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}><tbody>{body}</tbody></table></div>
    case 'tableRow': return <tr key={key}>{body}</tr>
    case 'tableCell': return <td key={key} {...spanProps} style={{ border: border.default, padding: 6, verticalAlign: 'top', overflowWrap: 'anywhere' }}>{body}</td>
    case 'tableHeader': return <th key={key} {...spanProps} scope="col" style={{ border: border.default, padding: 6, textAlign: 'left', verticalAlign: 'top', fontWeight: 600, background: ui.color.panelSubtle, overflowWrap: 'anywhere' }}>{body}</th>
    default: return children.length ? <React.Fragment key={key}>{body}</React.Fragment> : null
  }
}

function issueGroups(items: JiraMentionProjectionItem[]): Array<{ issue: JiraIssueMetadata; items: JiraMentionProjectionItem[] }> {
  const groups = new Map<string, JiraMentionProjectionItem[]>()
  for (const item of items) {
    const group = groups.get(item.issue.issueId) ?? []
    group.push(item)
    groups.set(item.issue.issueId, group)
  }
  return [...groups.values()].map((group) => ({ issue: group[0].issue, items: group }))
}

function filterItems(items: JiraMentionProjectionItem[], filter: string, now: number): JiraMentionProjectionItem[] {
  if (filter === 'all') return [...items].sort((a, b) => b.comment.createdAt - a.comment.createdAt
    || a.issue.issueKey.localeCompare(b.issue.issueKey) || b.comment.commentId.localeCompare(a.comment.commentId))
  if (filter === 'answered') return items.filter((item) => item.state.state === 'answered')
  if (filter === 'snoozed') return items.filter((item) => item.state.state === 'unanswered' && item.action?.disposition === 'snoozed' && (item.action.snoozeUntil ?? 0) > now)
  if (filter === 'dismissed') return items.filter((item) => item.state.state === 'unanswered' && item.action?.disposition === 'dismissed')
  const ordered = orderMentionItems(items, now)
  const unknown = items.filter((item) => item.state.state === 'unknown')
  return [...ordered, ...unknown]
}

function makeDraftTokens(value: string, mentions: readonly { start: number; end: number; accountId: string; displayName: string }[]): JiraReplyDraftToken[] {
  const tokens: JiraReplyDraftToken[] = []
  let offset = 0
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start < offset || mention.end > value.length) continue
    if (mention.start > offset) tokens.push({ kind: 'text', id: `text-${offset}`, text: value.slice(offset, mention.start) })
    tokens.push({ kind: 'mention', id: `mention-${mention.start}-${mention.accountId}`, accountId: mention.accountId, displayName: mention.displayName })
    offset = mention.end
  }
  if (offset < value.length || tokens.length === 0) tokens.push({ kind: 'text', id: `text-${offset}`, text: value.slice(offset) })
  return tokens
}

function CommentBody({ comment, issueId, attachments }: { comment: JiraCommentRecord; issueId: string; attachments: readonly JiraAttachmentMetadata[] }): JSX.Element {
  if (comment.availability !== 'visible') return <div style={{ color: ui.color.textMuted, fontSize: 12 }}>This comment is no longer available.</div>
  return <div style={{ color: ui.color.text, fontSize: 13, overflowWrap: 'anywhere' }}>{renderAdf(comment.body, 'adf', { issueId, attachments, comment, inferredAttachmentIds: new Set() })}</div>
}

function draftKeyFor(selected: { issueId: string; incomingCommentId: string } | null): string | null {
  return selected ? `${selected.issueId}\0${selected.incomingCommentId}` : null
}

function userSourceLabel(sources: string[]): string {
  const labels: string[] = []
  if (sources.includes('comment_author')) labels.push('comment author')
  if (sources.includes('assignee')) labels.push('assignee')
  if (sources.includes('reporter')) labels.push('reporter')
  if (sources.includes('creator')) labels.push('creator')
  if (sources.some((source) => source.startsWith('field:'))) labels.push('ticket field')
  if (sources.includes('mention')) labels.push('mentioned in ticket')
  return labels.join(' · ') || 'ticket user'
}

function userContextLabel(user: JiraUserReference, users: JiraUserReference[], comments: JiraCommentRecord[]): string {
  const sourceLabel = userSourceLabel(user.sources)
  const sameNameUsers = users.filter((candidate) => candidate.displayName === user.displayName)
  if (sameNameUsers.length < 2) return sourceLabel

  const contextFor = (candidate: JiraUserReference): string => {
    const comment = comments.filter((item) => item.authorAccountId === candidate.accountId)
      .sort((a, b) => b.createdAt - a.createdAt || a.commentId.localeCompare(b.commentId))[0]
    if (!comment) return userSourceLabel(candidate.sources)
    const excerpt = comment.excerpt.replace(/\s+/g, ' ').trim().slice(0, 64)
    return `${userSourceLabel(candidate.sources)} · comment: ${excerpt || 'no text'} · ${displayTime(comment.createdAt)}`
  }

  const label = contextFor(user)
  const peers = sameNameUsers.filter((candidate) => contextFor(candidate) === label)
  if (peers.length < 2) return label
  const ordinal = sameNameUsers.map((candidate) => ({ candidate, label: contextFor(candidate) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.candidate.accountId.localeCompare(b.candidate.accountId))
    .findIndex(({ candidate }) => candidate.accountId === user.accountId) + 1
  return `${label} · candidate ${ordinal}`
}

function replyErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_config':
    case 'auth': return 'Update the Jira credentials in Settings, then try again.'
    case 'permission': return 'Jira denied comment access. Open the issue in Jira or ask an administrator for Add comments permission.'
    case 'validation': return 'Jira rejected the reply. Check its text and selected mentions, then try again.'
    case 'invalid_recipient': return 'Choose reply recipients from this issue’s mention suggestions.'
    case 'unsupported_audience': return 'This comment’s audience cannot be preserved here. Open the issue in Jira to reply.'
    case 'rate_limited': return 'Jira is limiting replies. Wait before trying again.'
    case 'already_answered': return 'This request was answered after you opened it. Refresh the inbox.'
    case 'delivery_rechecked': return 'Jira checked this issue. Review the draft before trying again.'
    case 'missing_issue': return 'This issue is no longer available. Refresh the inbox or open it in Jira.'
    case 'send_in_progress': return 'A reply is already being sent for this issue.'
    case 'identity_changed': return 'The Jira account changed. Confirm the active account before replying.'
    case 'cache_unavailable': return 'Local Jira data is unavailable. Restore database access before replying.'
    case 'invalid_request': return 'Check the reply text and mentions, then try again.'
    default: return 'The reply could not be sent. Check the connection and refresh before trying again.'
  }
}

function formatAttachmentSize(size: number | null): string | null {
  if (size === null || !Number.isFinite(size) || size < 0) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function JiraMentions(): JSX.Element {
  const projection = useJiraMentionsStore((state) => state.projection)
  const selected = useJiraMentionsStore((state) => state.selected)
  const detail = useJiraMentionsStore((state) => state.detail)
  const detailLoading = useJiraMentionsStore((state) => state.detailLoading)
  const filter = useJiraMentionsStore((state) => state.filter)
  const search = useJiraMentionsStore((state) => state.search)
  const lastReplyResult = useJiraMentionsStore((state) => state.lastReplyResult)
  const refresh = useJiraMentionsStore((state) => state.refresh)
  const select = useJiraMentionsStore((state) => state.select)
  const setAction = useJiraMentionsStore((state) => state.setAction)
  const clearCache = useJiraMentionsStore((state) => state.clearCache)
  const postReply = useJiraMentionsStore((state) => state.postReply)
  const saveDraft = useJiraMentionsStore((state) => state.saveDraft)
  const drafts = useJiraMentionsStore((state) => state.drafts)
  const setFilter = useJiraMentionsStore((state) => state.setFilter)
  const setSearch = useJiraMentionsStore((state) => state.setSearch)
  const isJiraDestinationActive = usePanesStore((state) => state.activeDestination.kind === 'feature'
    && state.activeDestination.featureId === 'jira-mentions')
  const draftKey = draftKeyFor(selected)
  const draftEntry = draftKey ? drafts[draftKey] : undefined
  const attachmentPreviewScopeKey = selected ? `${selected.issueId}\0${selected.incomingCommentId}` : ''
  const draft = draftEntry?.text ?? ''
  const draftMentions = draftEntry?.mentions ?? []
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [posting, setPosting] = useState(false)
  const [descriptionHeight, setDescriptionHeight] = useState<number | null>(null)
  const [descriptionCollapsed, setDescriptionCollapsed] = useState(false)
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false)
  const [suggestion, setSuggestion] = useState<{ start: number; end: number; query: string } | null>(null)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const resizeRef = useRef<{ y: number; height: number } | null>(null)

  const visibleItems = useMemo(() => {
    const filtered = filterItems(projection.items, filter, Date.now())
    const query = search.trim().toLowerCase()
    return query ? filtered.filter((item) => `${item.issue.issueKey} ${item.issue.summary} ${item.comment.excerpt} ${item.comment.authorDisplayName ?? ''}`.toLowerCase().includes(query)) : filtered
  }, [projection.items, filter, search])
  const groups = useMemo(() => issueGroups(visibleItems), [visibleItems])
  const selectedItem = projection.items.find((item) => item.issue.issueId === selected?.issueId && item.comment.commentId === selected?.incomingCommentId) ?? null
  const issueDetails = detail?.issue ?? selectedItem?.issue ?? null
  const issueBadges: JiraIssueProperty[] = [
    issueDetails?.statusName ? { label: 'Status', value: issueDetails.statusName, kind: 'status', statusGroup: jiraStatusGroup(issueDetails.statusCategory) } : null,
    issueDetails?.issueType ? { label: 'Type', value: issueDetails.issueType, kind: 'type' } : null,
    issueDetails?.priority ? { label: 'Priority', value: issueDetails.priority, kind: 'priority' } : null,
    issueDetails?.assignee?.displayName ? { label: 'Assignee', value: issueDetails.assignee.displayName, kind: 'assignee' } : null,
  ].filter((item): item is JiraIssueProperty => item !== null)
  const issueFacts = [
    { label: 'Reporter', value: issueDetails?.reporter?.displayName ?? null },
    { label: 'Parent', value: issueDetails?.parent?.issueKey ?? null },
    { label: 'Due', value: issueDetails?.dueDate ?? null },
    { label: 'Updated', value: issueDetails?.updatedAt == null ? null : displayTime(issueDetails.updatedAt) },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value))
  const detailAttachments = detail?.issue.attachments.filter((attachment) =>
    Boolean(normalizeJiraInlineImageMimeType(attachment.mimeType))
      || (typeof attachment.contentUrl === 'string' && attachment.contentUrl.length > 0)) ?? []
  const commentAttachments = detail?.issue.attachments ?? []
  const sourceComment = detail?.comments.find((comment) => comment.commentId === selected?.incomingCommentId) ?? selectedItem?.comment ?? null
  const sourceCommentIndex = detail?.comments.findIndex((comment) => comment.commentId === selectedItem?.comment.commentId) ?? -1
  const newestFirst = (a: JiraCommentRecord, b: JiraCommentRecord): number => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || b.commentId.localeCompare(a.commentId)
  const earlierComments = sourceCommentIndex > 0 ? detail!.comments.slice(0, sourceCommentIndex).sort(newestFirst) : []
  const laterComments = sourceCommentIndex >= 0 ? detail!.comments.slice(sourceCommentIndex + 1).sort(newestFirst) : []
  const replyDisabled = !sourceComment || sourceComment.visibility?.type === 'unsupported' || selectedItem?.state.state !== 'unanswered'
  const availableUsers = useMemo(() => {
    const users = detail?.users ?? selectedItem?.authors ?? []
    return [...new Map(users.filter((user) => user.accountId).map((user) => [user.accountId, user])).values()]
  }, [detail?.users, selectedItem?.authors])
  const suggestionUsers = useMemo(() => {
    if (!suggestion) return []
    const query = suggestion.query.toLowerCase()
    const candidates = availableUsers.filter((user) => user.displayName
      && (query.length === 0 || user.displayName.toLowerCase().includes(query)))
    if (query.length === 0 && sourceComment?.authorAccountId) {
      candidates.sort((a, b) => Number(b.accountId === sourceComment.authorAccountId) - Number(a.accountId === sourceComment.authorAccountId))
    }
    return candidates.slice(0, 8)
  }, [availableUsers, sourceComment?.authorAccountId, suggestion])

  useEffect(() => {
    if (isJiraDestinationActive) void refresh('open-if-stale')
  }, [isJiraDestinationActive, refresh])

  useEffect(() => { setSuggestionIndex(0) }, [suggestion?.start, suggestion?.query])
  useEffect(() => {
    setDescriptionHeight(null)
    setDescriptionCollapsed(false)
  }, [detail?.issue.issueId])
  useLayoutEffect(() => {
    if (selected && mainScrollRef.current) mainScrollRef.current.scrollTop = 0
  }, [selected?.issueId, selected?.incomingCommentId])
  useLayoutEffect(() => {
    const position = pendingCaret.current
    const input = textRef.current
    if (position === null || !input) return
    pendingCaret.current = null
    input.focus()
    input.setSelectionRange(position, position)
  }, [draft])

  useLayoutEffect(() => {
    const input = textRef.current
    if (!input) return
    input.style.height = 'auto'
    const contentHeight = input.scrollHeight
    input.style.height = `${Math.min(MAX_REPLY_EDITOR_HEIGHT, Math.max(MIN_REPLY_EDITOR_HEIGHT, contentHeight))}px`
    input.style.overflowY = contentHeight > MAX_REPLY_EDITOR_HEIGHT ? 'auto' : 'hidden'
  }, [draft, selectedItem?.comment.commentId])

  function handleDraftChange(nextValue: string, caret: number): void {
    const oldValue = draft
    let prefix = 0
    while (prefix < oldValue.length && prefix < nextValue.length && oldValue[prefix] === nextValue[prefix]) prefix++
    let oldEnd = oldValue.length
    let newEnd = nextValue.length
    while (oldEnd > prefix && newEnd > prefix && oldValue[oldEnd - 1] === nextValue[newEnd - 1]) { oldEnd--; newEnd-- }
    const delta = newEnd - oldEnd
    const nextMentions = draftMentions.flatMap((mention) => {
      if (mention.start < oldEnd && mention.end > prefix) return []
      if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
      return [mention]
    })
    if (draftKey) saveDraft(draftKey, { text: nextValue, mentions: nextMentions })
    const beforeCaret = nextValue.slice(0, caret)
    const at = beforeCaret.lastIndexOf('@')
    const query = at >= 0 ? beforeCaret.slice(at + 1) : ''
    const withinWord = at >= 0 && !/\s/.test(query) && !/[\n\r]/.test(query)
    setSuggestion(withinWord ? { start: at, end: caret, query } : null)
  }

  function insertMention(user: { accountId: string; displayName: string | null }): void {
    if (!suggestion) return
    const label = user.displayName ?? 'Unknown user'
    const replacement = `@${label}`
    const next = `${draft.slice(0, suggestion.start)}${replacement}${draft.slice(suggestion.end)}`
    const shift = replacement.length - (suggestion.end - suggestion.start)
    const updated = draftMentions.flatMap((mention) => {
      if (mention.start < suggestion.end && mention.end > suggestion.start) return []
      return mention.start >= suggestion.end ? [{ ...mention, start: mention.start + shift, end: mention.end + shift }] : [mention]
    })
    updated.push({ start: suggestion.start, end: suggestion.start + replacement.length, accountId: user.accountId, displayName: label })
    const position = suggestion.start + replacement.length
    pendingCaret.current = position
    if (draftKey) saveDraft(draftKey, { text: next, mentions: updated.sort((a, b) => a.start - b.start) })
    setSuggestion(null)
  }

  async function submitReply(): Promise<void> {
    if (!selected || !draftKey || replyDisabled || !draft.trim() || posting) return
    const submittedText = draft
    const submittedMentions = draftMentions.map((mention) => ({ ...mention }))
    const submittedSignature = JSON.stringify({ text: submittedText, mentions: submittedMentions })
    setPosting(true)
    try {
      const result = await postReply({ issueId: selected.issueId, sourceCommentId: selected.incomingCommentId, tokens: makeDraftTokens(submittedText, submittedMentions) })
      if (result.ok) {
        const current = useJiraMentionsStore.getState().drafts[draftKey]
        if (JSON.stringify({ text: current?.text ?? '', mentions: current?.mentions ?? [] }) === submittedSignature) {
          saveDraft(draftKey, { text: '', mentions: [] })
        }
        setSuggestion(null)
      }
    } finally {
      setPosting(false)
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (suggestion && suggestionUsers.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSuggestionIndex((index) => (index + 1) % suggestionUsers.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSuggestionIndex((index) => (index + suggestionUsers.length - 1) % suggestionUsers.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const user = suggestionUsers[suggestionIndex]
        if (user) insertMention(user)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSuggestion(null)
        return
      }
    }
    if ((event.key !== 'Backspace' && event.key !== 'Delete') || !draftKey || !draftMentions.length) return
    const input = event.currentTarget
    let start = input.selectionStart
    let end = input.selectionEnd
    if (start === end) {
      const adjacent = event.key === 'Backspace'
        ? draftMentions.find((mention) => mention.start < start && mention.end >= start)
        : draftMentions.find((mention) => mention.start <= start && mention.end > start)
      if (!adjacent) return
      start = adjacent.start
      end = adjacent.end
    } else {
      const intersecting = draftMentions.filter((mention) => mention.start < end && mention.end > start)
      if (!intersecting.length) return
      start = Math.min(start, ...intersecting.map((mention) => mention.start))
      end = Math.max(end, ...intersecting.map((mention) => mention.end))
    }
    event.preventDefault()
    const nextValue = `${draft.slice(0, start)}${draft.slice(end)}`
    const delta = start - end
    const nextMentions = draftMentions.flatMap((mention) => {
      if (mention.start < end && mention.end > start) return []
      return mention.start >= end ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }] : [mention]
    })
    pendingCaret.current = start
    saveDraft(draftKey, { text: nextValue, mentions: nextMentions })
    setSuggestion(null)
  }

  function startVerticalResize(event: React.PointerEvent, setHeight: React.Dispatch<React.SetStateAction<number | null>>, minimumHeight: number): void {
    if (event.button !== 0) return
    const content = event.currentTarget.previousElementSibling as HTMLElement | null
    if (!content) return
    event.preventDefault()
    resizeRef.current = { y: event.clientY, height: content.getBoundingClientRect().height }
    const move = (moveEvent: PointerEvent) => {
      if (!resizeRef.current) return
      setHeight(Math.max(minimumHeight, resizeRef.current.height + moveEvent.clientY - resizeRef.current.y))
    }
    const up = () => {
      resizeRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <AttachmentPreviewCacheProvider scopeKey={attachmentPreviewScopeKey}>
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, background: ui.color.appBg, color: ui.color.text }}>
      <aside style={{ width: 390, minWidth: 330, maxWidth: '40%', display: 'flex', flexDirection: 'column', borderRight: border.default, background: ui.color.panel, minHeight: 0 }}>
        <div style={{ padding: '12px 12px 9px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: border.default }}>
          <strong style={{ color: ui.color.textStrong, fontSize: 13, whiteSpace: 'nowrap' }}>Needs your reply</strong>
          <span style={{ color: ui.color.textMuted, fontSize: 11 }}>{projection.activeCount}</span>
          <span style={{ marginLeft: 'auto', color: ui.color.textDim, fontSize: 10, whiteSpace: 'nowrap' }}>
            {projection.lastSuccessAt ? `Checked ${displayTime(projection.lastSuccessAt)}` : 'Not checked'}
          </span>
          <button title="Clear cached Jira data" aria-label="Clear Jira mentions cache" onClick={() => { void clearCache() }} style={{ ...buttonStyle, width: 28, height: 27, padding: 4 }}>×</button>
        </div>
        <div style={{ padding: '8px 10px', display: 'flex', gap: 6, borderBottom: border.default }}>
          <input aria-label="Search Jira mentions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" style={{ flex: 1, minWidth: 0, background: ui.color.input, color: ui.color.text, border: border.default, borderRadius: 4, padding: '5px 7px', fontSize: 11, outline: 'none', caretColor: ui.color.accent }} />
          <select aria-label="Jira mentions filter" value={filter} onChange={(event) => setFilter(event.target.value as JiraMentionsFilter)} style={{ width: 100, background: ui.color.input, color: ui.color.text, border: border.default, borderRadius: 4, padding: '4px 5px', fontSize: 11 }}>
            <option value="all">All</option><option value="active">Active</option><option value="snoozed">Snoozed</option><option value="dismissed">Dismissed</option><option value="answered">Answered</option>
          </select>
          <button title="Refresh Jira mentions" aria-label="Refresh Jira mentions" onClick={() => { void refresh('manual') }} style={{ ...buttonStyle, width: 28, height: 27, padding: 4 }}>
            <img src={refreshIcon} alt="" style={{ width: 14, height: 14, display: 'block', margin: 'auto' }} />
          </button>
        </div>
        {projection.status !== 'ready' && <div role="status" style={{ padding: '8px 10px', borderBottom: border.default, color: projection.status === 'loading' ? ui.color.statusWorking : ui.color.textMuted, fontSize: 11, lineHeight: 1.4 }}>{stateMessage(projection.status, projection.errorCode)}</div>}
        <div className={`dark-scrollbar`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 7 }}>
          {projection.status === 'ready' && groups.length === 0 && <div style={{ padding: 16, color: ui.color.textMuted, fontSize: 12 }}>{filter === 'active' ? 'No unanswered mentions.' : filter === 'all' ? 'No Jira mentions.' : `No ${filter} mentions.`}</div>}
          {groups.map((group, index) => (
            <div key={group.issue.issueId} style={{ marginBottom: 8, borderBottom: index < groups.length - 1 ? border.default : 'none' }}>
              <div style={{ padding: '6px 7px 4px', color: ui.color.textDim, fontSize: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>
                    <button type="button" aria-label={`Open ${group.issue.issueKey} in Jira`} title="Open issue in Jira" onClick={() => { void window.ipc.invoke('jira:open-issue', group.issue.issueKey) }} style={{ ...linkButtonStyle, fontSize: 10, fontWeight: 600 }}>{group.issue.issueKey}</button>
                  </strong>
                  <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{group.items.length} comment{group.items.length === 1 ? '' : 's'}</span>
                </div>
                <div style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.issue.summary}</div>
              </div>
              {group.items.map((item) => {
                const isSelected = selected?.issueId === item.issue.issueId && selected?.incomingCommentId === item.comment.commentId
                return (
                  <button key={item.comment.commentId} onClick={() => { void select(item.issue.issueId, item.comment.commentId) }} style={{
                    display: 'block', width: '100%', textAlign: 'left', background: isSelected ? ui.color.control : 'transparent',
                    border: `1px solid ${isSelected ? ui.color.border : 'transparent'}`, borderRadius: 5, cursor: 'pointer', color: ui.color.text, padding: '7px 8px', marginBottom: 2,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: ui.color.textStrong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.comment.authorDisplayName ?? 'Unknown user'}</span>
                      <span style={{ fontSize: 10, color: ui.color.textDim, whiteSpace: 'nowrap' }}>{displayTime(item.comment.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.4, color: ui.color.textMuted, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{item.comment.excerpt || 'Mentioned you in a comment'}</div>
                    {item.state.state === 'unknown' && <div style={{ marginTop: 4, fontSize: 10, color: ui.color.statusWaiting }}>Could not verify</div>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {projection.historyFrom && <div style={{ padding: '7px 10px', borderTop: border.default, color: ui.color.textDim, fontSize: 10 }}>
          Initial history since {displayTime(projection.historyFrom)}
        </div>}
      </aside>

      <main ref={mainScrollRef} className="dark-scrollbar" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: '18px 24px', containerType: 'size' }}>
        {selectedItem && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: ui.color.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em' }}>
                  {issueDetails?.projectName ?? issueDetails?.projectKey ?? 'Jira'} / <button type="button" aria-label={`Open issue ${selectedItem.issue.issueKey} in Jira`} title="Open issue in Jira" onClick={() => { void window.ipc.invoke('jira:open-issue', selectedItem.issue.issueKey) }} style={{ ...linkButtonStyle, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em' }}>{selectedItem.issue.issueKey}</button>
                </div>
                <h1 style={{ fontSize: 20, lineHeight: 1.35, margin: '8px 0 0', color: ui.color.textStrong, fontWeight: 600 }}>{selectedItem.issue.summary}</h1>
              </div>
              {selectedItem.action && <button style={buttonStyle} onClick={() => { void setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'restored' }) }}>{selectedItem.action.disposition === 'snoozed' ? 'Unsnooze' : 'Restore'}</button>}
            </header>

            {issueBadges.length > 0 && <div aria-label="Issue details" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
              {issueBadges.map((item) => {
                const style = item.kind === 'status'
                  ? { ...issuePropertyChipStyle, ...jiraStatusStyles[item.statusGroup ?? 'in-progress'] }
                  : item.kind === 'type' ? jiraIssueTypeStyle
                    : item.kind === 'priority' ? jiraPriorityStyle : jiraAssigneeStyle
                return <span key={item.label} data-property={item.kind} data-category={item.statusGroup} aria-label={`${item.label} ${item.value}`} style={style}>
                  {item.kind === 'assignee' && <span style={{ color: ui.color.textMuted }}>Assignee </span>}{item.value}
                </span>
              })}
            </div>}
            {issueFacts.length > 0 && <div aria-label="Issue facts" style={{ display: 'flex', flexWrap: 'wrap', columnGap: 22, rowGap: 6, margin: '2px 0 6px', color: ui.color.textMuted, fontSize: 11 }}>
              {issueFacts.map((item) => <span key={item.label}>{item.label} <strong style={{ color: ui.color.text, fontWeight: 400, marginLeft: 5 }}>{item.value}</strong></span>)}
            </div>}

            {detailLoading && <div role="status" style={{ color: ui.color.textMuted, fontSize: 12 }}>Loading issue context…</div>}
            {detail && (
              <>
                {detail.issue.description && (
                  <section aria-label="Description" style={{ borderTop: border.default, borderBottom: border.default }}>
                    <details open={!descriptionCollapsed}>
                      <summary onClick={(event) => { event.preventDefault(); setDescriptionCollapsed((current) => !current) }} style={{ cursor: 'pointer', padding: '10px 0 8px', color: ui.color.textMuted, fontSize: 11 }}>Description</summary>
                      <div className="dark-scrollbar" style={{ height: descriptionHeight ?? 'auto', maxHeight: descriptionHeight === null ? `min(${DESCRIPTION_MAX_HEIGHT}px, ${DESCRIPTION_MAX_VIEWPORT_RATIO * 100}cqh)` : 'none', overflow: 'auto', padding: '0 12px 8px 0', fontSize: 12, lineHeight: 1.6 }}>{renderAdf(detail.issue.description)}</div>
                      <div role="separator" aria-label="Resize description" aria-orientation="horizontal" aria-valuemin={DESCRIPTION_MIN_HEIGHT} aria-valuenow={descriptionHeight ?? undefined} onPointerDown={(event) => startVerticalResize(event, setDescriptionHeight, DESCRIPTION_MIN_HEIGHT)} style={{ height: 8, cursor: 'ns-resize', display: 'flex', justifyContent: 'center', alignItems: 'center', touchAction: 'none', userSelect: 'none' }}>
                        <span aria-hidden="true" style={{ width: 36, height: 2, borderRadius: 2, background: ui.color.textDim }} />
                      </div>
                    </details>
                  </section>
                )}
                {detailAttachments.length > 0 && <details aria-label="Attachments" open={attachmentsExpanded} style={{ marginTop: 4 }}>
                  <summary onClick={(event) => { event.preventDefault(); setAttachmentsExpanded((expanded) => !expanded) }} style={{ marginTop: 8, color: ui.color.textMuted, fontSize: 11, cursor: 'pointer' }}>
                    Attachments <span style={{ marginLeft: 5, color: ui.color.text }}>{detailAttachments.length}</span>
                  </summary>
                  {attachmentsExpanded && <div className="dark-scrollbar" role="group" aria-label="Attachment previews" style={{ display: 'flex', gap: 9, overflowX: 'auto', padding: '9px 0 6px', alignItems: 'stretch' }}>
                    {detailAttachments.map((attachment) => {
                      const size = formatAttachmentSize(attachment.size)
                      const metadata = [attachment.mimeType, size, attachment.author?.displayName, attachment.createdAt === null ? null : displayTime(attachment.createdAt)].filter(Boolean)
                      const isImage = Boolean(normalizeJiraInlineImageMimeType(attachment.mimeType))
                      return <div key={attachment.id} title={metadata.join(' · ')} style={{ flex: '0 0 140px', width: 140, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, padding: 4, border: border.default, borderRadius: 6, background: ui.color.panelSubtle, fontSize: 10 }}>
                        {isImage
                          ? <JiraInlineImage issueId={selectedItem.issue.issueId} attachment={attachment} linkMode thumbnailMode />
                          : <button type="button" aria-label={`Open attachment ${attachment.name} in Jira`} title="Open attachment in Jira" onClick={() => { void window.ipc.invoke('jira-mentions:open-attachment', selectedItem.issue.issueId, attachment.id) }} style={{ ...linkButtonStyle, color: ui.color.text, minHeight: 88, overflowWrap: 'anywhere' }}>{attachment.name}</button>}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: ui.color.text }} title={attachment.name}>{attachment.name}</span>
                        {metadata.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: ui.color.textDim }}>{metadata.join(' · ')}</span>}
                      </div>
                    })}
                  </div>}
                </details>}
                <section aria-label="Reply composer" style={{ borderBottom: border.default, padding: '12px 0 14px', position: 'relative' }}>
                  <label htmlFor="jira-mentions-reply" style={{ display: 'block', marginBottom: 6, color: ui.color.textMuted, fontSize: 10, letterSpacing: '.11em', textTransform: 'uppercase', fontWeight: 700 }}>Reply</label>
                  <div style={{ position: 'relative', margin: '10px 0' }}>
                    <textarea
                      id="jira-mentions-reply"
                      ref={textRef}
                      value={draft}
                      onChange={(event) => handleDraftChange(event.target.value, event.target.selectionStart)}
                      onClick={(event) => handleDraftChange(draft, event.currentTarget.selectionStart)}
                      onKeyDown={handleComposerKeyDown}
                      aria-expanded={Boolean(suggestion && suggestionUsers.length)}
                      aria-activedescendant={suggestion && suggestionUsers.length ? `jira-mention-option-${suggestionIndex}` : undefined}
                      placeholder={replyDisabled ? 'Open this issue in Jira to reply to this audience.' : 'Write a reply'}
                      disabled={replyDisabled}
                      rows={4}
                      style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: MIN_REPLY_EDITOR_HEIGHT, maxHeight: MAX_REPLY_EDITOR_HEIGHT, resize: 'vertical', overflowY: 'hidden', background: 'transparent', border: 0, borderRadius: 0, color: ui.color.text, padding: 0, font: 'inherit', fontSize: 12, lineHeight: 1.8, outline: 'none', caretColor: ui.color.accent }}
                    />
                    {suggestion && !replyDisabled && suggestionUsers.length > 0 && (
                      <div role="listbox" aria-label="Mention suggestions" style={{ position: 'absolute', top: '100%', left: 0, width: 'min(350px, 100%)', maxHeight: 180, overflow: 'auto', background: ui.color.panelRaised, border: border.default, borderRadius: 5, boxShadow: ui.shadow.menu, zIndex: 5 }}>
                        {suggestionUsers.map((user, index) => (
                          <button id={`jira-mention-option-${index}`} key={user.accountId} role="option" aria-selected={index === suggestionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(user)} style={{ display: 'block', width: '100%', padding: '7px 9px', border: 0, background: index === suggestionIndex ? ui.color.control : 'transparent', color: ui.color.text, textAlign: 'left', cursor: 'pointer', fontSize: 11 }}>
                            {user.displayName}<span style={{ display: 'block', color: ui.color.textDim, fontSize: 9, marginTop: 2 }}>{userContextLabel(user, availableUsers, detail?.comments ?? (selectedItem ? [selectedItem.comment] : []))}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    {selectedItem?.replyUncertain && <span role="status" style={{ color: ui.color.statusWaiting, fontSize: 10 }}>Delivery is uncertain. Refresh Jira mentions before trying again.</span>}
                    {lastReplyResult && !lastReplyResult.ok && !selectedItem?.replyUncertain && <span role="status" style={{ color: lastReplyResult.outcome === 'unknown' ? ui.color.statusWaiting : ui.color.danger, fontSize: 10 }}>{lastReplyResult.outcome === 'unknown' ? 'Delivery is uncertain. Refresh Jira mentions before trying again.' : replyErrorMessage(lastReplyResult.errorCode)}</span>}
                    {lastReplyResult?.ok && <span role="status" style={{ color: ui.color.accent, fontSize: 10 }}>Reply posted.</span>}
                    <button style={{ ...buttonStyle, marginLeft: 'auto', background: ui.color.accentBg, color: ui.color.accent }} disabled={replyDisabled || selectedItem?.replyUncertain === true || !draft.trim() || posting} onClick={() => { void submitReply() }}>{posting ? 'Posting…' : 'Post reply'}</button>
                  </div>
                </section>

                <section aria-label="Comment history" style={{ border: border.default, borderRadius: 7, overflow: 'hidden', background: ui.color.panel }}>
                  {laterComments.length > 0 && <section aria-label="Later comments" style={{ borderBottom: border.default, background: ui.color.panelSubtle }}>
                    <div style={{ padding: '10px 16px', color: ui.color.textMuted, fontSize: 11, borderBottom: border.default }}>
                      Later comments <span style={{ marginLeft: 5, color: ui.color.text }}>{laterComments.length}</span>
                    </div>
                    {laterComments.map((comment) => (
                      <div key={comment.commentId} style={{ padding: '9px 16px', borderBottom: border.default }}>
                        <div style={{ color: ui.color.textMuted, fontSize: 10, marginBottom: 5 }}>{comment.authorDisplayName ?? 'Unknown user'} · {displayTime(comment.createdAt)}</div>
                        <CommentBody comment={comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                      </div>
                    ))}
                  </section>}
                  <div style={{ padding: '10px 12px', borderBottom: border.default, display: 'flex', gap: 10, alignItems: 'center', position: 'relative' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ color: ui.color.textStrong, fontSize: 12 }}>{sourceComment?.authorDisplayName ?? 'Unknown user'}</strong>
                      <span style={{ marginLeft: 8, color: ui.color.textDim, fontSize: 10 }}>{displayTime(sourceComment?.createdAt)}</span>
                    </div>
                    {selectedItem.state.state === 'unanswered' && <>
                      <button style={buttonStyle} onClick={() => setSnoozeMenuOpen((open) => !open)}>Snooze</button>
                      <button style={buttonStyle} onClick={() => setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'dismissed' })}>Dismiss</button>
                    </>}
                    {snoozeMenuOpen && <div role="menu" style={{ position: 'absolute', right: 10, top: 'calc(100% + 4px)', display: 'flex', gap: 4, background: ui.color.panelRaised, border: border.default, borderRadius: 5, padding: 5, boxShadow: ui.shadow.menu, zIndex: 5 }}>
                      {(['2-hours', '1-day', 'next-monday'] as JiraQuickSnooze[]).map((kind) => {
                        const until = getQuickSnoozeUntil(kind, Date.now())
                        const label = kind === '2-hours' ? '2 hours' : kind === '1-day' ? '1 day' : 'Next Monday'
                        return <button key={kind} title={displayTime(until)} role="menuitem" style={{ ...buttonStyle, whiteSpace: 'nowrap' }} onClick={() => {
                          void setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'snoozed', snoozeUntil: until })
                          setSnoozeMenuOpen(false)
                        }}>{label}<span style={{ display: 'block', color: ui.color.textDim, fontSize: 9, marginTop: 3 }}>{new Date(until).toLocaleString()}</span></button>
                      })}
                    </div>}
                  </div>
                  <div role="region" aria-label="Selected mention" style={{ borderLeft: `2px solid ${ui.color.accent}`, background: ui.color.panelSubtle, padding: '14px 16px', boxSizing: 'border-box' }}>
                    <CommentBody comment={sourceComment ?? selectedItem.comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                  </div>
                  {earlierComments.length > 0 && <section aria-label="Earlier comments" style={{ borderTop: border.default, background: ui.color.panelSubtle }}>
                    <div style={{ padding: '10px 16px', color: ui.color.textMuted, fontSize: 11, borderBottom: border.default }}>
                      Earlier comments <span style={{ marginLeft: 5, color: ui.color.text }}>{earlierComments.length}</span>
                    </div>
                    {earlierComments.map((comment) => (
                      <div key={comment.commentId} style={{ padding: '9px 16px', borderBottom: border.default }}>
                        <div style={{ color: ui.color.textMuted, fontSize: 10, marginBottom: 5 }}>{comment.authorDisplayName ?? 'Unknown user'} · {displayTime(comment.createdAt)}</div>
                        <CommentBody comment={comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                      </div>
                    ))}
                  </section>}
                </section>
                {issueDetails?.createdAt != null && <div style={{ color: ui.color.textDim, fontSize: 10, marginTop: -3 }}>Created {displayTime(issueDetails.createdAt)}</div>}
              </>
            )}
          </div>
        )}
      </main>
    </div>
    </AttachmentPreviewCacheProvider>
  )
}
