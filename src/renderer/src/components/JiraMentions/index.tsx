import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JiraAttachmentMetadata, JiraCommentRecord, JiraIssueMetadata, JiraMentionProjectionItem, JiraReplyDraftToken, JiraUserReference } from '../../../../shared/jiraMentions'
import { compareCommentsAscending, normalizeJiraInlineImageMimeType, orderMentionItems, type JiraAttachmentPreviewResult } from '../../../../shared/jiraMentions'
import { useJiraMentionsStore, type JiraMentionsFilter } from '../../store/jiraMentions'
import { usePanesStore } from '../../store/panes'
import refreshIcon from '../../assets/refresh.png'
import closeIcon from '../../assets/close.png'
import { border, ui } from '../../styles/theme'
import './JiraMentions.css'

const buttonStyle: React.CSSProperties = {
  border: border.default, borderRadius: 5, background: ui.color.control, color: ui.color.text,
  fontSize: 11, padding: '5px 9px', cursor: 'pointer',
}
const linkButtonStyle: React.CSSProperties = {
  border: 0, background: 'transparent', padding: 0, color: ui.color.accent, font: 'inherit',
  textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer',
}
const issuePropertyChipStyle: React.CSSProperties = {
  borderRadius: 4, padding: '3px 8px', fontSize: 'calc(11px + 1pt)', whiteSpace: 'nowrap',
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
  borderLeft: border.default, paddingLeft: 9, marginLeft: 1, fontSize: 'calc(11px + 1pt)', whiteSpace: 'nowrap',
}
const jiraAssigneeStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, paddingLeft: 8, fontSize: 'calc(11px + 1pt)', whiteSpace: 'nowrap',
}
const jiraPersonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'calc(10px + 1pt)', whiteSpace: 'normal',
}
const DESCRIPTION_MIN_HEIGHT = 90
const COMMENT_MIN_HEIGHT = 48
const DESCRIPTION_MAX_HEIGHT = 360
const DESCRIPTION_MAX_VIEWPORT_RATIO = 0.35
const MIN_REPLY_EDITOR_HEIGHT = 95
const SNOOZE_UNIT_MILLISECONDS: Record<SnoozeUnit, number> = { minutes: 60_000, hours: 60 * 60_000, days: 24 * 60 * 60_000 }
const MAX_SNOOZE_MILLISECONDS = 370 * 24 * 60 * 60_000

type JiraStatusGroup = 'new' | 'in-progress' | 'done'
type SnoozeUnit = 'minutes' | 'hours' | 'days'
type JiraIssueProperty = { label: string; value: string; kind: 'status' | 'type' | 'priority' | 'assignee' | 'person' | 'text'; statusGroup?: JiraStatusGroup; user?: JiraUserReference; users?: JiraUserReference[] }

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

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')
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
    return <span ref={targetRef} role={state.kind === 'loading' ? 'status' : undefined} style={{ display: 'inline-block', padding: '7px 9px', border: border.default, borderRadius: 5, color: ui.color.textMuted, fontSize: 'var(--jira-mentions-reading-base)' }}>{label}</span>
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
    if (!context || !attachment) return <span key={key} style={{ color: ui.color.textMuted, fontSize: 'var(--jira-mentions-reading-base)' }}>Attachment preview unavailable</span>
    const alt = typeof attrs.alt === 'string' ? attrs.alt : undefined
    if (normalizeJiraInlineImageMimeType(attachment.mimeType)) {
      return <JiraInlineImage key={key} issueId={context.issueId} attachment={attachment} alt={alt} inline={value.type === 'mediaInline'} />
    }
    return <span key={key} style={{ color: ui.color.textMuted, fontSize: 'var(--jira-mentions-reading-base)' }}>[Attachment: {attachment.name}]</span>
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
  if (comment.availability !== 'visible') return <div className="jira-mentions-comment-body jira-mentions-comment-unavailable">This comment is no longer available.</div>
  return <div className="jira-mentions-comment-body">{renderAdf(comment.body, 'adf', { issueId, attachments, comment, inferredAttachmentIds: new Set() })}</div>
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
  const [snoozeDuration, setSnoozeDuration] = useState('1')
  const [snoozeUnit, setSnoozeUnit] = useState<SnoozeUnit>('hours')
  const [posting, setPosting] = useState(false)
  const [descriptionHeight, setDescriptionHeight] = useState<number | null>(null)
  const [newerCommentsHeight, setNewerCommentsHeight] = useState<number | null>(null)
  const [earlierCommentsHeight, setEarlierCommentsHeight] = useState<number | null>(null)
  const [descriptionCollapsed, setDescriptionCollapsed] = useState(false)
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false)
  const [suggestion, setSuggestion] = useState<{ start: number; end: number; query: string } | null>(null)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const snoozeMenuRef = useRef<HTMLDivElement | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const resizeRef = useRef<{ y: number; height: number } | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  const visibleItems = useMemo(() => {
    const filtered = filterItems(projection.items, filter, Date.now())
    const query = search.trim().toLowerCase()
    return query ? filtered.filter((item) => `${item.issue.issueKey} ${item.issue.summary} ${item.comment.excerpt} ${item.comment.authorDisplayName ?? ''}`.toLowerCase().includes(query)) : filtered
  }, [projection.items, filter, search])
  const groups = useMemo(() => issueGroups(visibleItems), [visibleItems])
  const selectedItem = projection.items.find((item) => item.issue.issueId === selected?.issueId && item.comment.commentId === selected?.incomingCommentId) ?? null
  const issueDetails = detail?.issue ?? selectedItem?.issue ?? null
  const devTesters = detail?.users.filter((user) => user.displayName && user.sources.includes('field-name:dev tester')) ?? []
  const mainDevs = detail?.users.filter((user) => user.displayName && user.sources.includes('field-name:main dev')) ?? []
  const issuePropertyCandidates: Array<JiraIssueProperty | null> = [
    issueDetails?.statusName ? { label: 'Status', value: issueDetails.statusName, kind: 'status', statusGroup: jiraStatusGroup(issueDetails.statusCategory) } : null,
    issueDetails?.issueType ? { label: 'Type', value: issueDetails.issueType, kind: 'type' } : null,
    issueDetails?.priority ? { label: 'Priority', value: issueDetails.priority, kind: 'priority' } : null,
    issueDetails?.assignee?.displayName ? { label: 'Assignee', value: issueDetails.assignee.displayName, kind: 'assignee', user: issueDetails.assignee } : null,
    issueDetails?.reporter?.displayName ? { label: 'Reporter', value: issueDetails.reporter.displayName, kind: 'person', user: issueDetails.reporter } : null,
    devTesters.length > 0 ? { label: 'Dev Tester', value: devTesters.map((user) => user.displayName!).join(', '), kind: 'person', users: devTesters } : null,
    mainDevs.length > 0 ? { label: 'Main Dev', value: mainDevs.map((user) => user.displayName!).join(', '), kind: 'person', users: mainDevs } : null,
    issueDetails?.parent?.issueKey ? { label: 'Parent', value: issueDetails.parent.issueKey, kind: 'text' } : null,
    issueDetails?.dueDate ? { label: 'Due', value: issueDetails.dueDate, kind: 'text' } : null,
    issueDetails?.createdAt == null ? null : { label: 'Created', value: displayTime(issueDetails.createdAt), kind: 'text' },
    issueDetails?.updatedAt == null ? null : { label: 'Updated', value: displayTime(issueDetails.updatedAt), kind: 'text' },
  ]
  const issueProperties = issuePropertyCandidates.filter((item): item is JiraIssueProperty => item !== null)
  const detailAttachments = detail?.issue.attachments.filter((attachment) =>
    Boolean(normalizeJiraInlineImageMimeType(attachment.mimeType))
      || (typeof attachment.contentUrl === 'string' && attachment.contentUrl.length > 0)) ?? []
  const commentAttachments = detail?.issue.attachments ?? []
  const sourceComment = detail?.comments.find((comment) => comment.commentId === selected?.incomingCommentId) ?? selectedItem?.comment ?? null
  const sourceCommentIndex = detail?.comments.findIndex((comment) => comment.commentId === selectedItem?.comment.commentId) ?? -1
  const newestFirst = (a: JiraCommentRecord, b: JiraCommentRecord): number => compareCommentsAscending(b, a)
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
    if (!snoozeMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!snoozeMenuRef.current?.contains(event.target as Node)) setSnoozeMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSnoozeMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [snoozeMenuOpen])
  useEffect(() => {
    setDescriptionHeight(null)
    setDescriptionCollapsed(false)
  }, [detail?.issue.issueId])
  useEffect(() => {
    setAttachmentsExpanded(false)
    setNewerCommentsHeight(null)
    setEarlierCommentsHeight(null)
    setSnoozeMenuOpen(false)
  }, [selected?.issueId, selected?.incomingCommentId])
  useEffect(() => () => { resizeCleanupRef.current?.() }, [])
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
    input.style.height = `${Math.max(MIN_REPLY_EDITOR_HEIGHT, contentHeight)}px`
    input.style.overflowY = 'hidden'
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
    resizeCleanupRef.current?.()
    resizeRef.current = { y: event.clientY, height: content.getBoundingClientRect().height }
    const move = (moveEvent: PointerEvent) => {
      if (!resizeRef.current) return
      setHeight(Math.max(minimumHeight, resizeRef.current.height + moveEvent.clientY - resizeRef.current.y))
    }
    const up = () => {
      resizeRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
    }
    const cleanup = () => {
      resizeRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>, setHeight: React.Dispatch<React.SetStateAction<number | null>>, minimumHeight: number): void {
    if (event.key === 'Home') {
      event.preventDefault()
      setHeight(null)
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const content = event.currentTarget.previousElementSibling as HTMLElement | null
    if (!content) return
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? -24 : 24
    setHeight((current) => Math.max(minimumHeight, (current ?? content.getBoundingClientRect().height) + delta))
  }

  return (
    <AttachmentPreviewCacheProvider scopeKey={attachmentPreviewScopeKey}>
    <div className="jira-mentions-shell">
    <div className="jira-mentions-root" style={{
      background: ui.color.appBg,
      color: ui.color.text,
      '--jira-mentions-border': ui.color.border,
      '--jira-mentions-border-subtle': ui.color.borderSubtle,
      '--jira-mentions-text': ui.color.text,
      '--jira-mentions-text-strong': ui.color.textStrong,
      '--jira-mentions-text-muted': ui.color.textMuted,
      '--jira-mentions-text-dim': ui.color.textDim,
      '--jira-mentions-panel': ui.color.panel,
      '--jira-mentions-panel-raised': ui.color.panelRaised,
      '--jira-mentions-panel-subtle': ui.color.panelSubtle,
      '--jira-mentions-input': ui.color.input,
      '--jira-mentions-control': ui.color.control,
      '--jira-mentions-control-hover': ui.color.controlHover,
      '--jira-mentions-accent': ui.color.accent,
      '--jira-mentions-accent-bg': ui.color.accentBg,
      '--jira-mentions-waiting': ui.color.statusWaiting,
      '--jira-mentions-danger': ui.color.danger,
      '--jira-mentions-menu-shadow': ui.shadow.menu,
    } as React.CSSProperties}>
      <aside className="jira-mentions-inbox">
        <div className="jira-mentions-inbox-header">
          <span className="jira-mentions-inbox-kicker">MENTION INBOX</span>
          <div className="jira-mentions-inbox-title-row">
            <strong>Needs your reply</strong>
            <span className="jira-mentions-inbox-count" aria-label={`${projection.activeCount} active mentions`}>{projection.activeCount}</span>
          </div>
          <span className="jira-mentions-checked" data-checked={Boolean(projection.lastSuccessAt)}>
            <i aria-hidden="true" />
            {projection.lastSuccessAt ? `Checked ${displayTime(projection.lastSuccessAt)}` : 'Not checked'}
          </span>
        </div>
        <div className="jira-mentions-inbox-controls">
          <label className="jira-mentions-search-field">
            <span className="jira-mentions-search-icon" aria-hidden="true" />
            <input aria-label="Search Jira mentions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" style={{ outline: 'none', caretColor: ui.color.accent }} />
          </label>
          <select aria-label="Jira mentions filter" value={filter} onChange={(event) => setFilter(event.target.value as JiraMentionsFilter)}>
            <option value="all">All</option><option value="active">Active</option><option value="snoozed">Snoozed</option><option value="dismissed">Dismissed</option><option value="answered">Answered</option>
          </select>
          <button className="jira-mentions-refresh" title="Refresh Jira mentions" aria-label="Refresh Jira mentions" onClick={() => { void refresh('manual') }}>
            <img src={refreshIcon} alt="" />
          </button>
        </div>
        {projection.status !== 'ready' && <div className="jira-mentions-state-message" role="status" data-status={projection.status}>{stateMessage(projection.status, projection.errorCode)}</div>}
        <div className="jira-mentions-inbox-list dark-scrollbar">
          {projection.status === 'ready' && groups.length === 0 && <div className="jira-mentions-empty-inbox">{filter === 'active' ? 'No unanswered mentions.' : filter === 'all' ? 'No Jira mentions.' : `No ${filter} mentions.`}</div>}
          {groups.length > 0 && <div className="jira-mentions-list-summary"><span>MENTIONS</span><span>{visibleItems.length} shown</span></div>}
          {groups.map((group, index) => (
            <div className="jira-mentions-issue-group" key={group.issue.issueId} data-last={index === groups.length - 1}>
              <div className="jira-mentions-group-heading">
                <div>
                  <strong>
                    <button type="button" aria-label={`Open ${group.issue.issueKey} in Jira`} title="Open issue in Jira" onClick={() => { void window.ipc.invoke('jira:open-issue', group.issue.issueKey) }} style={{ ...linkButtonStyle, fontSize: 10, fontWeight: 600 }}>{group.issue.issueKey}</button>
                  </strong>
                  <span>{group.items.length} comment{group.items.length === 1 ? '' : 's'}</span>
                </div>
                <p>{group.issue.summary}</p>
              </div>
              {group.items.map((item) => {
                const isSelected = selected?.issueId === item.issue.issueId && selected?.incomingCommentId === item.comment.commentId
                return (
                  <button className="jira-mentions-mention-row" data-selected={isSelected} aria-pressed={isSelected} key={item.comment.commentId} onClick={() => { void select(item.issue.issueId, item.comment.commentId) }}>
                    <span className="jira-mentions-mention-mark" aria-hidden="true">@</span>
                    <span className="jira-mentions-mention-copy">
                      <span className="jira-mentions-mention-row-head">
                        <strong>{item.comment.authorDisplayName ?? 'Unknown user'}</strong>
                        <time>{displayTime(item.comment.createdAt)}</time>
                      </span>
                      <span className="jira-mentions-mention-title">{item.issue.summary}</span>
                      <span className="jira-mentions-mention-excerpt">{item.comment.excerpt || 'Mentioned you in a comment'}</span>
                      {item.state.state === 'unknown' && <span className="jira-mentions-unverified">Could not verify</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {projection.historyFrom && <div className="jira-mentions-inbox-footer">
          Initial history since {displayTime(projection.historyFrom)}
        </div>}
      </aside>

      <main ref={mainScrollRef} className="jira-mentions-detail dark-scrollbar" style={{ minWidth: 0, minHeight: 0, overflow: 'auto', containerType: 'size' }}>
        {selectedItem && (
          <div className="jira-mentions-detail-workspace">
            <header className="jira-mentions-issue-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="jira-mentions-issue-keyline">
                  <span>{issueDetails?.projectName ?? issueDetails?.projectKey ?? 'Jira'}</span>
                  <span className="jira-mentions-issue-keyline-separator" aria-hidden="true">›</span>
                  <button type="button" aria-label={`Open issue ${selectedItem.issue.issueKey} in Jira`} title="Open issue in Jira" onClick={() => { void window.ipc.invoke('jira:open-issue', selectedItem.issue.issueKey) }} style={linkButtonStyle}>{selectedItem.issue.issueKey}</button>
                </div>
                <h1 className="jira-mentions-issue-title">{selectedItem.issue.summary}</h1>
              </div>
              {selectedItem.action && <button style={buttonStyle} onClick={() => { void setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'restored' }) }}>{selectedItem.action.disposition === 'snoozed' ? 'Unsnooze' : 'Restore'}</button>}
            </header>

            {issueProperties.length > 0 && <aside className="jira-mentions-details-rail" aria-label="Issue details">
              <div className="jira-mentions-details-kicker">TICKET DETAILS</div>
              <dl className="jira-mentions-properties">
                {issueProperties.map((item) => {
                  const style = item.kind === 'status'
                    ? { ...issuePropertyChipStyle, ...jiraStatusStyles[item.statusGroup ?? 'in-progress'] }
                    : item.kind === 'type' ? jiraIssueTypeStyle
                      : item.kind === 'priority' ? jiraPriorityStyle
                        : item.kind === 'assignee' ? jiraAssigneeStyle
                          : item.kind === 'person' ? jiraPersonStyle : { display: 'block' }
                  const statusColor = item.statusGroup === 'new' ? ui.color.jiraStatusNew
                    : item.statusGroup === 'done' ? ui.color.jiraStatusDone : ui.color.jiraStatusProgress
                  const propertyUsers = item.users ?? (item.user ? [item.user] : [])
                  return <div className="jira-mentions-property-row" key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>
                      <span data-property={item.kind} data-category={item.statusGroup} aria-label={`${item.label} ${item.value}`} style={{ ...style, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {item.kind === 'status' && <span className="jira-mentions-status-dot" aria-hidden="true" style={{ background: statusColor }} />}
                        {propertyUsers.map((user) => <span className="jira-mentions-avatar" key={user.accountId} aria-hidden="true">{initials(user.displayName ?? item.value)}</span>)}
                        {item.value}
                      </span>
                    </dd>
                  </div>
                })}
              </dl>
            </aside>}

            <div className="jira-mentions-detail-content">
            {detailLoading && <div role="status" style={{ color: ui.color.textMuted, fontSize: 12 }}>Loading issue context…</div>}
            {detail && (
              <>
                {detail.issue.description && (
                  <section className="jira-mentions-section jira-mentions-description-section" aria-label="Description">
                    <details open={!descriptionCollapsed}>
                      <summary onClick={(event) => { event.preventDefault(); setDescriptionCollapsed((current) => !current) }}>Description</summary>
                      <div className="jira-mentions-description-copy dark-scrollbar" style={{ height: descriptionHeight ?? 'auto', maxHeight: descriptionHeight === null ? `min(${DESCRIPTION_MAX_HEIGHT}px, ${DESCRIPTION_MAX_VIEWPORT_RATIO * 100}cqh)` : 'none', overflow: 'auto' }}>{renderAdf(detail.issue.description)}</div>
                      <div className="jira-mentions-resize-handle" role="separator" aria-label="Resize description" aria-orientation="horizontal" aria-valuemin={DESCRIPTION_MIN_HEIGHT} aria-valuenow={descriptionHeight ?? undefined} tabIndex={0} onKeyDown={(event) => handleResizeKeyDown(event, setDescriptionHeight, DESCRIPTION_MIN_HEIGHT)} onPointerDown={(event) => startVerticalResize(event, setDescriptionHeight, DESCRIPTION_MIN_HEIGHT)} style={{ cursor: 'ns-resize' }}>
                        <span aria-hidden="true" style={{ width: 36, height: 2 }} />
                      </div>
                    </details>
                  </section>
                )}
                {detailAttachments.length > 0 && <details className="jira-mentions-section jira-mentions-attachments" aria-label="Attachments" open={attachmentsExpanded}>
                  <summary onClick={(event) => { event.preventDefault(); setAttachmentsExpanded((expanded) => !expanded) }}>
                    Attachments <span className="jira-mentions-section-count">{detailAttachments.length}</span>
                  </summary>
                  {attachmentsExpanded && <div className="jira-mentions-attachment-list dark-scrollbar" role="group" aria-label="Attachment previews" style={{ overflowX: 'auto' }}>
                    {detailAttachments.map((attachment) => {
                      const size = formatAttachmentSize(attachment.size)
                      const metadata = [attachment.mimeType, size, attachment.author?.displayName].filter(Boolean)
                      const createdAt = attachment.createdAt === null ? null : displayTime(attachment.createdAt)
                      const isImage = Boolean(normalizeJiraInlineImageMimeType(attachment.mimeType))
                      return <div className="jira-mentions-attachment-card" key={attachment.id} title={metadata.join(' · ')}>
                        {isImage
                          ? <JiraInlineImage issueId={selectedItem.issue.issueId} attachment={attachment} linkMode thumbnailMode />
                          : <button type="button" aria-label={`Open attachment ${attachment.name} in Jira`} title="Open attachment in Jira" onClick={() => { void window.ipc.invoke('jira-mentions:open-attachment', selectedItem.issue.issueId, attachment.id) }} style={{ ...linkButtonStyle, color: ui.color.text, minHeight: 88, overflowWrap: 'anywhere' }}>{attachment.name}</button>}
                        <span className="jira-mentions-attachment-name" title={attachment.name}>{attachment.name}</span>
                        {metadata.length > 0 && <span className="jira-mentions-attachment-metadata">{metadata.join(' · ')}</span>}
                        {createdAt && <span className="jira-mentions-attachment-date">{createdAt}</span>}
                      </div>
                    })}
                  </div>}
                </details>}
                <section className="jira-mentions-reply-composer" aria-label="Reply composer">
                  <div className="jira-mentions-reply-heading">
                    <div>
                      <span className="jira-mentions-reply-mark" aria-hidden="true">
                        <svg viewBox="0 0 16 16"><path d="M5 4 2 7l3 3M2 7h6a4 4 0 0 1 4 4v1" /></svg>
                      </span>
                      <label htmlFor="jira-mentions-reply" aria-label={`Reply to selected mention on ${selectedItem.issue.issueKey}`}>Reply to mention</label>
                    </div>
                  </div>
                  <div className="jira-mentions-reply-input-wrap">
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
                      style={{ minHeight: MIN_REPLY_EDITOR_HEIGHT, overflowY: 'hidden', resize: 'vertical', outline: 'none', caretColor: ui.color.accent }}
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
                  <div className="jira-mentions-reply-footer">
                    {(selectedItem?.replyUncertain || lastReplyResult) && <span className="jira-mentions-reply-feedback">
                      {selectedItem?.replyUncertain && <span role="status" style={{ color: ui.color.statusWaiting }}>Delivery is uncertain. Refresh Jira mentions before trying again.</span>}
                      {lastReplyResult && !lastReplyResult.ok && !selectedItem?.replyUncertain && <span role="status" style={{ color: lastReplyResult.outcome === 'unknown' ? ui.color.statusWaiting : ui.color.danger }}>{lastReplyResult.outcome === 'unknown' ? 'Delivery is uncertain. Refresh Jira mentions before trying again.' : replyErrorMessage(lastReplyResult.errorCode)}</span>}
                      {lastReplyResult?.ok && <span role="status" style={{ color: ui.color.accent }}>Reply posted.</span>}
                    </span>}
                    <button className="jira-mentions-reply-post" disabled={replyDisabled || selectedItem?.replyUncertain === true || !draft.trim() || posting} onClick={() => { void submitReply() }}>{posting ? 'Posting…' : 'Post reply'}</button>
                  </div>
                </section>

                <section className="jira-mentions-comment-history" aria-label="Comment history">
                  <div className="jira-mentions-comments-heading">
                    <div><h2>Comments</h2><span className="jira-mentions-section-count">{detail.observedCommentCount}</span></div>
                    <span>Newest first</span>
                  </div>
                  {laterComments.length > 0 && <section className="jira-mentions-comment-group" aria-label="Newer comments">
                    <div className="jira-mentions-comment-group-heading">Newer comments <span>{laterComments.length}</span></div>
                    <div className="jira-mentions-comment-context dark-scrollbar" style={{ height: newerCommentsHeight ?? 'auto', overflowY: newerCommentsHeight === null ? 'visible' : 'auto' }}>
                      {laterComments.map((comment) => (
                        <article className="jira-mentions-comment-row" key={comment.commentId}>
                          <span className="jira-mentions-comment-avatar" aria-hidden="true">{initials(comment.authorDisplayName ?? 'Unknown user')}</span>
                          <div className="jira-mentions-comment-copy">
                            <div className="jira-mentions-comment-head"><strong>{comment.authorDisplayName ?? 'Unknown user'}</strong><time>{displayTime(comment.createdAt)}</time></div>
                            <CommentBody comment={comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                          </div>
                        </article>
                      ))}
                    </div>
                    <div className="jira-mentions-resize-handle" role="separator" aria-label="Resize newer comments" aria-orientation="horizontal" aria-valuemin={COMMENT_MIN_HEIGHT} aria-valuenow={newerCommentsHeight ?? undefined} tabIndex={0} onKeyDown={(event) => handleResizeKeyDown(event, setNewerCommentsHeight, COMMENT_MIN_HEIGHT)} onPointerDown={(event) => startVerticalResize(event, setNewerCommentsHeight, COMMENT_MIN_HEIGHT)}><span aria-hidden="true" /></div>
                  </section>}
                  <div role="region" aria-label="Selected mention" className="jira-mentions-comment-row" data-selected="true">
                    <span className="jira-mentions-comment-avatar" aria-hidden="true">{initials(sourceComment?.authorDisplayName ?? selectedItem.comment.authorDisplayName ?? 'Unknown user')}</span>
                    <div className="jira-mentions-comment-copy">
                      <div className="jira-mentions-comment-head">
                        <strong>{sourceComment?.authorDisplayName ?? selectedItem.comment.authorDisplayName ?? 'Unknown user'}</strong>
                        <time>{displayTime(sourceComment?.createdAt ?? selectedItem.comment.createdAt)}</time>
                        <span className="jira-mentions-source-tag">Mention</span>
                        {selectedItem.state.state === 'unanswered' && <span className="jira-mentions-source-actions">
                          <div className="jira-mentions-snooze-control" ref={snoozeMenuRef}>
                            <button className="jira-mentions-action-snooze" type="button" aria-haspopup="dialog" aria-expanded={snoozeMenuOpen} onClick={() => setSnoozeMenuOpen((open) => !open)}>Snooze</button>
                            {snoozeMenuOpen && <div className="jira-mentions-snooze-menu" role="dialog" aria-label="Snooze duration">
                              <form className="jira-mentions-snooze-form" onSubmit={(event) => {
                                event.preventDefault()
                                const duration = Number(snoozeDuration)
                                const durationMilliseconds = duration * SNOOZE_UNIT_MILLISECONDS[snoozeUnit]
                                if (!Number.isInteger(duration) || duration < 1 || durationMilliseconds > MAX_SNOOZE_MILLISECONDS) return
                                void setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'snoozed', snoozeUntil: Date.now() + durationMilliseconds })
                                setSnoozeMenuOpen(false)
                              }}>
                                <span className="jira-mentions-snooze-label">Snooze for</span>
                                <div className="jira-mentions-snooze-fields">
                                  <input aria-label="Snooze duration" type="number" min="1" max={Math.floor(MAX_SNOOZE_MILLISECONDS / SNOOZE_UNIT_MILLISECONDS[snoozeUnit])} step="1" required value={snoozeDuration} onChange={(event) => setSnoozeDuration(event.currentTarget.value)} />
                                  <select aria-label="Snooze unit" value={snoozeUnit} onChange={(event) => setSnoozeUnit(event.currentTarget.value as SnoozeUnit)}>
                                    <option value="minutes">minutes</option>
                                    <option value="hours">hours</option>
                                    <option value="days">days</option>
                                  </select>
                                </div>
                                <button type="submit" className="jira-mentions-snooze-submit">Apply snooze</button>
                              </form>
                            </div>}
                          </div>
                          <button className="jira-mentions-action-dismiss" type="button" onClick={() => setAction({ issueId: selectedItem.issue.issueId, incomingCommentId: selectedItem.comment.commentId, action: 'dismissed' })}>Dismiss</button>
                        </span>}
                      </div>
                      <div className="jira-mentions-comment-context-body">
                        <CommentBody comment={sourceComment ?? selectedItem.comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                      </div>
                    </div>
                  </div>
                  {earlierComments.length > 0 && <section className="jira-mentions-comment-group" aria-label="Earlier comments">
                    <div className="jira-mentions-comment-group-heading">Earlier comments <span>{earlierComments.length}</span></div>
                    <div className="jira-mentions-comment-context dark-scrollbar" style={{ height: earlierCommentsHeight ?? 'auto', overflowY: earlierCommentsHeight === null ? 'visible' : 'auto' }}>
                      {earlierComments.map((comment) => (
                        <article className="jira-mentions-comment-row" key={comment.commentId}>
                          <span className="jira-mentions-comment-avatar" aria-hidden="true">{initials(comment.authorDisplayName ?? 'Unknown user')}</span>
                          <div className="jira-mentions-comment-copy">
                            <div className="jira-mentions-comment-head"><strong>{comment.authorDisplayName ?? 'Unknown user'}</strong><time>{displayTime(comment.createdAt)}</time></div>
                            <CommentBody comment={comment} issueId={selectedItem.issue.issueId} attachments={commentAttachments} />
                          </div>
                        </article>
                      ))}
                    </div>
                    <div className="jira-mentions-resize-handle" role="separator" aria-label="Resize earlier comments" aria-orientation="horizontal" aria-valuemin={COMMENT_MIN_HEIGHT} aria-valuenow={earlierCommentsHeight ?? undefined} tabIndex={0} onKeyDown={(event) => handleResizeKeyDown(event, setEarlierCommentsHeight, COMMENT_MIN_HEIGHT)} onPointerDown={(event) => startVerticalResize(event, setEarlierCommentsHeight, COMMENT_MIN_HEIGHT)}><span aria-hidden="true" /></div>
                  </section>}
                  <div className="jira-mentions-history-end">{detail.commentsComplete ? 'End of available comments' : 'Older comments were not included in the available history'}</div>
                </section>
              </>
            )}
            </div>
          </div>
        )}
      </main>
    </div>
    </div>
    </AttachmentPreviewCacheProvider>
  )
}
