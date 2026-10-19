import { create } from 'zustand'
import type {
  JiraIssueSnapshot,
  JiraMentionsActionInput,
  JiraMentionsProjection,
  JiraMentionsRefreshMode,
  JiraMentionsReplyInput,
  JiraMentionsReplyResult,
} from '../../../shared/jiraMentions'

export interface JiraMentionDraft {
  text: string
  mentions: Array<{ start: number; end: number; accountId: string; displayName: string }>
}

export type JiraMentionsFilter = 'all' | 'active' | 'snoozed' | 'dismissed' | 'answered'

interface JiraMentionsStoreState {
  projection: JiraMentionsProjection
  hydrated: boolean
  selected: { issueId: string; incomingCommentId: string } | null
  detail: JiraIssueSnapshot | null
  detailLoading: boolean
  filter: JiraMentionsFilter
  search: string
  lastReplyResult: JiraMentionsReplyResult | null
  drafts: Record<string, JiraMentionDraft>
  hydrate: () => Promise<void>
  receiveProjection: (projection: JiraMentionsProjection) => void
  refresh: (mode?: JiraMentionsRefreshMode) => Promise<void>
  select: (issueId: string, incomingCommentId: string) => Promise<void>
  clearSelection: () => void
  saveDraft: (key: string, draft: JiraMentionDraft) => void
  clearDrafts: () => void
  setAction: (input: JiraMentionsActionInput) => Promise<void>
  clearCache: () => Promise<void>
  postReply: (input: JiraMentionsReplyInput) => Promise<JiraMentionsReplyResult>
  setFilter: (filter: JiraMentionsFilter) => void
  setSearch: (search: string) => void
}

interface PendingRefreshAttempt {
  lastAttemptAt: number
  generation: number
}

const EMPTY: JiraMentionsProjection = {
  enabled: false,
  identityVerified: false,
  status: 'not-configured',
  errorCode: null,
  activeCount: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  historyFrom: null,
  coverageThrough: null,
  cached: false,
  items: [],
}

export const useJiraMentionsStore = create<JiraMentionsStoreState>((set, get) => {
  let detailRequestGeneration = 0
  let refreshAttemptGeneration = 0
  let pendingRefreshAttempt: PendingRefreshAttempt | null = null
  let completedRefreshAttempt: PendingRefreshAttempt | null = null

  const readDetail = async (
    selected: { issueId: string; incomingCommentId: string },
    clearBeforeRead: boolean,
  ): Promise<void> => {
    const requestGeneration = ++detailRequestGeneration
    if (clearBeforeRead) set({ selected, detail: null, detailLoading: true, lastReplyResult: null })
    try {
      const detail = await window.ipc.invoke('jira-mentions:get-issue-detail', selected.issueId)
      const current = get()
      if (requestGeneration === detailRequestGeneration
        && current.selected?.issueId === selected.issueId
        && current.selected?.incomingCommentId === selected.incomingCommentId) {
        set({ detail, detailLoading: false })
      }
    } catch {
      const current = get()
      if (requestGeneration === detailRequestGeneration
        && current.selected?.issueId === selected.issueId
        && current.selected?.incomingCommentId === selected.incomingCommentId) {
        set(clearBeforeRead ? { detail: null, detailLoading: false } : current.detailLoading ? { detailLoading: false } : {})
      }
    }
  }

  return ({
  projection: EMPTY,
  hydrated: false,
  selected: null,
  detail: null,
  detailLoading: false,
  filter: 'active',
  search: '',
  lastReplyResult: null,
  drafts: {},

  hydrate: async () => {
    try {
      const projection = await window.ipc.invoke('jira-mentions:get-state')
      get().receiveProjection(projection)
    } catch {
      set({ hydrated: true })
    }
  },

  receiveProjection: (projection) => {
    const current = get()
    const receivedAttemptAt = projection.lastAttemptAt
    const previousAttemptAt = current.projection.lastAttemptAt
    // Refresh responses can arrive after their corresponding state-change
    // broadcast. Do not let a late loading snapshot roll a completed attempt
    // backwards or arm a second detail reconciliation for that same attempt.
    if (projection.status === 'loading' && receivedAttemptAt !== null
      && previousAttemptAt === receivedAttemptAt && current.projection.status !== 'loading'
      && pendingRefreshAttempt === null) return
    if (receivedAttemptAt !== null && previousAttemptAt !== null && receivedAttemptAt < previousAttemptAt) return

    const selected = current.selected
    const selectedStillVisible = projection.identityVerified && projection.enabled && selected && projection.items.some((item) => item.issue.issueId === selected.issueId
      && item.comment.commentId === selected.incomingCommentId)
    const selectedItem = selectedStillVisible
      ? projection.items.find((item) => item.issue.issueId === selected.issueId && item.comment.commentId === selected.incomingCommentId)
      : undefined
    const previousSelectedItem = selected
      ? current.projection.items.find((item) => item.issue.issueId === selected.issueId && item.comment.commentId === selected.incomingCommentId)
      : undefined
    const recheckedReplyResult = selectedItem && projection.status === 'ready'
      && selectedItem.replyUncertain !== true
      && (previousSelectedItem?.replyUncertain === true || (current.lastReplyResult?.ok === false && current.lastReplyResult.outcome === 'unknown'))
      ? { ok: false as const, outcome: 'rejected' as const, errorCode: selectedItem.state.state === 'unanswered' ? 'delivery_rechecked' : 'already_answered' }
      : null
    const identityBoundary = !projection.identityVerified || !projection.enabled
    const selectionInvalidated = Boolean(selected && !selectedStillVisible)
    let reconcileSelectedDetail = false
    if (projection.status === 'loading' && receivedAttemptAt !== null) {
      if (pendingRefreshAttempt?.lastAttemptAt !== receivedAttemptAt) {
        if (completedRefreshAttempt?.lastAttemptAt === receivedAttemptAt) return
        refreshAttemptGeneration++
        pendingRefreshAttempt = { lastAttemptAt: receivedAttemptAt, generation: refreshAttemptGeneration }
      }
    } else if (pendingRefreshAttempt && receivedAttemptAt === pendingRefreshAttempt.lastAttemptAt
      && pendingRefreshAttempt.generation === refreshAttemptGeneration
      && (projection.status === 'ready' || projection.status === 'partial' || projection.status === 'error')) {
      completedRefreshAttempt = pendingRefreshAttempt
      pendingRefreshAttempt = null
      reconcileSelectedDetail = Boolean(selectedStillVisible)
    }
    if (identityBoundary || selectionInvalidated) {
      pendingRefreshAttempt = null
      detailRequestGeneration++
      if (identityBoundary) completedRefreshAttempt = null
    }
    set({
      projection,
      hydrated: true,
      ...(recheckedReplyResult ? { lastReplyResult: recheckedReplyResult } : {}),
      ...(identityBoundary ? { drafts: {}, selected: null, detail: null, lastReplyResult: null }
        : selectionInvalidated ? { selected: null, detail: null, lastReplyResult: null } : {}),
    })
    if (reconcileSelectedDetail) {
      const latestSelection = get().selected
      if (latestSelection) void readDetail(latestSelection, false)
    }
  },

  refresh: async (mode = 'manual') => {
    try {
      const projection = await window.ipc.invoke('jira-mentions:refresh', mode)
      get().receiveProjection(projection)
    } catch {
      set((state) => ({ projection: { ...state.projection, status: 'error', errorCode: 'network' } }))
    }
  },

  select: async (issueId, incomingCommentId) => {
    await readDetail({ issueId, incomingCommentId }, true)
  },

  clearSelection: () => {
    detailRequestGeneration++
    pendingRefreshAttempt = null
    set({ selected: null, detail: null, detailLoading: false, lastReplyResult: null })
  },

  saveDraft: (key, draft) => set((state) => {
    if (!key || key.length > 300) return state
    const drafts = { ...state.drafts }
    if (!draft.text && draft.mentions.length === 0) delete drafts[key]
    else drafts[key] = draft
    const keys = Object.keys(drafts)
    if (keys.length > 100) delete drafts[keys[0]]
    return { drafts }
  }),

  clearDrafts: () => set({ drafts: {} }),

  setAction: async (input) => {
    try {
      const projection = await window.ipc.invoke('jira-mentions:set-action', input)
      get().receiveProjection(projection)
    } catch { /* main projection remains authoritative */ }
  },

  clearCache: async () => {
    try {
      const projection = await window.ipc.invoke('jira-mentions:clear-cache')
      get().receiveProjection(projection)
    } catch { /* error arrives through the state event */ }
  },

  postReply: async (input) => {
    try {
      const result = await window.ipc.invoke('jira-mentions:post-reply', input)
      set({ lastReplyResult: result })
      if (result.ok) {
        try {
          const projection = await window.ipc.invoke('jira-mentions:get-state')
          get().receiveProjection(projection)
        } catch { /* successful post result remains visible in the editor */ }
      }
      return result
    } catch {
      const result: JiraMentionsReplyResult = { ok: false, outcome: 'unknown', errorCode: 'network' }
      set({ lastReplyResult: result })
      return result
    }
  },

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  })
})
