import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { usePanesStore } from '../../store/panes'
import { useSessions } from '../../hooks/useSessions'
import { useSessionsStore } from '../../store/sessions'
import type { Session, SessionSearchResult } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/time'
import { agentLabel } from '../../utils/agents'
import { displayGitBranch } from '../../utils/git'
import { AgentIcon } from '../AgentIcon'
import { DirPicker } from '../DirPicker'

function groupByProject(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    const key = s.projectName
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return map
}

function groupResultsByProject(results: SessionSearchResult[]): Map<string, SessionSearchResult[]> {
  const map = new Map<string, SessionSearchResult[]>()
  for (const r of results) {
    const key = r.session.projectName
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return map
}

export function SessionBrowser(): JSX.Element {
  const closeOverlays = usePanesStore((s) => s.closeOverlays)
  const resumeSession = usePanesStore((s) => s.resumeSession)
  const resumeSessionInNewTab = usePanesStore((s) => s.resumeSessionInNewTab)
  const repairSessionCwd = useSessionsStore((s) => s.repairSessionCwd)
  const { sessions, search } = useSessions()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'summary' | 'deep'>('summary')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [detailSession, setDetailSession] = useState<Session | null>(null)
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [deepResults, setDeepResults] = useState<SessionSearchResult[]>([])
  const [deepSearching, setDeepSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mouseDownOnOverlay = useRef(false)
  const searchGenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Reset project selection when mode or query changes
  useEffect(() => {
    setSelectedProject(null)
  }, [mode, query])

  // Bump the generation unconditionally on every invocation — including the
  // empty-query branch — so an in-flight response to a superseded query is
  // always discarded. Without this bump, clearing the input leaves the gen
  // equal to the in-flight request's, and stale results repopulate the empty
  // view (spec 036, item 5).
  const runDeepSearch = useCallback(async (q: string) => {
    const gen = ++searchGenRef.current
    if (!q.trim()) {
      setDeepResults([])
      setDeepSearching(false)
      return
    }
    setDeepSearching(true)
    try {
      const results = (await window.ipc.invoke('sessions:search-deep', { query: q })) as SessionSearchResult[]
      if (searchGenRef.current !== gen) return
      setDeepResults(results)
    } catch {
      if (searchGenRef.current !== gen) return
      setDeepResults([])
    } finally {
      if (searchGenRef.current === gen) setDeepSearching(false)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'deep') return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void runDeepSearch(query), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, mode, runDeepSearch])

  const summarySessions = useMemo(() => query ? search(query) : sessions, [query, sessions, search])
  const summaryGrouped = useMemo(() => groupByProject(summarySessions), [summarySessions])
  const deepGrouped = useMemo(() => groupResultsByProject(deepResults), [deepResults])

  const projects = mode === 'deep' ? Array.from(deepGrouped.keys()) : Array.from(summaryGrouped.keys())
  const activeProject = selectedProject ?? projects[0] ?? null

  const projectHasSevered = useMemo<Set<string>>(() => {
    const set = new Set<string>()
    if (mode === 'summary') {
      for (const [proj, ss] of summaryGrouped) {
        if (ss.some((s) => !s.cwdExists)) set.add(proj)
      }
    } else {
      for (const [proj, rs] of deepGrouped) {
        if (rs.some((r) => !r.session.cwdExists)) set.add(proj)
      }
    }
    return set
  }, [mode, summaryGrouped, deepGrouped])

  function statusLabel(s: Session): string {
    if (!s.cwdExists) return 'SEVERED'
    if (s.status === 'live-attached') return 'LIVE'
    return 'RESUMABLE'
  }

  function statusColor(s: Session): string {
    if (!s.cwdExists) return '#f87171'
    if (s.status === 'live-attached') return '#4ade80'
    return '#6b7280'
  }

  async function repairProjectDirectory(session: Session, dir: string): Promise<void> {
    setRepairError(null)
    const result = await repairSessionCwd(session.cwd, dir)
    if (!result.ok) {
      setRepairError(result.error ?? 'Directory repair failed')
      return
    }
    const updated = result.sessions
    const updatedCurrent = updated.find((s) => s.agentKind === session.agentKind && s.sessionId === session.sessionId)
    if (updatedCurrent) {
      setDetailSession((prev) =>
        prev?.agentKind === updatedCurrent.agentKind && prev.sessionId === updatedCurrent.sessionId ? updatedCurrent : prev
      )
    }
    setEditingSession(null)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget }}
      onClick={() => { if (mouseDownOnOverlay.current) closeOverlays() }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '85vw',
          maxWidth: 960,
          height: '75vh',
          backgroundColor: '#1a1b1e',
          border: '1px solid #2a2b2e',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid #2a2b2e',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: '#d4d4d4' }}>Session Browser</span>
          <span style={{ fontSize: 11, color: '#4a4b4e' }}>ESC to close</span>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left: search + mode toggle + project list */}
          <div
            style={{
              width: 200,
              borderRight: '1px solid #2a2b2e',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
            }}
          >
            <div style={{ padding: '8px 8px 0' }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions..."
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  backgroundColor: '#141517',
                  border: '1px solid #2a2b2e',
                  borderRadius: 5,
                  color: '#d4d4d4',
                  fontSize: 12,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {/* Mode toggle */}
            <div style={{ padding: '6px 8px', display: 'flex', gap: 4 }}>
              <ModeButton active={mode === 'summary'} onClick={() => setMode('summary')}>Summary</ModeButton>
              <ModeButton active={mode === 'deep'} onClick={() => setMode('deep')}>Deep</ModeButton>
            </div>
            {mode === 'deep' && deepSearching && (
              <div style={{ padding: '0 8px 4px', fontSize: 10, color: '#4a4b4e' }}>Searching…</div>
            )}
            <div className="dark-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
              {projects.map((proj) => (
                <button
                  key={proj}
                  onClick={() => setSelectedProject(proj)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '7px 12px',
                    background: activeProject === proj ? '#242528' : 'none',
                    border: 'none',
                    borderLeft: activeProject === proj ? '2px solid #4ade80' : '2px solid transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: activeProject === proj ? '#d4d4d4' : '#6b7280',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {projectHasSevered.has(proj) && <MissingDirectoryMark />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {proj.split('/').pop()}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right: content */}
          <div className="dark-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
            {mode === 'summary' ? (
              <SummaryPane
                grouped={summaryGrouped}
                activeProject={activeProject}
                detailSession={detailSession}
                setDetailSession={setDetailSession}
                setEditingSession={setEditingSession}
                setRepairError={setRepairError}
                statusLabel={statusLabel}
                statusColor={statusColor}
                onResumeSplit={(s) => { resumeSession(s.agentKind, s.sessionId, s.cwd); closeOverlays() }}
                onResumeNewTab={(s) => { resumeSessionInNewTab(s.agentKind, s.sessionId, s.cwd); closeOverlays() }}
              />
            ) : (
              <DeepPane
                grouped={deepGrouped}
                activeProject={activeProject}
                query={query}
                searching={deepSearching}
                detailSession={detailSession}
                setDetailSession={setDetailSession}
                setEditingSession={setEditingSession}
                setRepairError={setRepairError}
                statusLabel={statusLabel}
                statusColor={statusColor}
                onResumeSplit={(s) => { resumeSession(s.agentKind, s.sessionId, s.cwd); closeOverlays() }}
                onResumeNewTab={(s) => { resumeSessionInNewTab(s.agentKind, s.sessionId, s.cwd); closeOverlays() }}
              />
            )}
          </div>
        </div>
      </div>
      {editingSession && (
        <DirPicker
          title="Repair project directory"
          description="Choose the current folder for this project. All sessions from the old directory will be repaired."
          initial={editingSession.cwd}
          confirmLabel="Repair project"
          skipLabel="Cancel"
          error={repairError}
          onConfirm={(dir) => { void repairProjectDirectory(editingSession, dir) }}
          onSkip={() => {
            setRepairError(null)
            setEditingSession(null)
          }}
        />
      )}
    </div>
  )
}

// ─── Summary mode pane ────────────────────────────────────────────────────────

interface SummaryPaneProps {
  grouped: Map<string, Session[]>
  activeProject: string | null
  detailSession: Session | null
  setDetailSession: React.Dispatch<React.SetStateAction<Session | null>>
  setEditingSession: React.Dispatch<React.SetStateAction<Session | null>>
  setRepairError: React.Dispatch<React.SetStateAction<string | null>>
  statusLabel: (s: Session) => string
  statusColor: (s: Session) => string
  onResumeSplit: (s: Session) => void
  onResumeNewTab: (s: Session) => void
}

function SummaryPane({
  grouped, activeProject, detailSession, setDetailSession, setEditingSession,
  setRepairError, statusLabel, statusColor, onResumeSplit, onResumeNewTab,
}: SummaryPaneProps): JSX.Element {
  return (
    <>
      {Array.from(grouped.entries()).map(([proj, projSessions]) => {
        if (activeProject && proj !== activeProject) return null
        const first = projSessions[0]
        const severedSession = projSessions.find((s) => !s.cwdExists) ?? null
        return (
          <div key={proj} style={{ marginBottom: 20 }}>
            <ProjectHeader
              proj={proj}
              cwd={first.cwd}
              hasSevered={projSessions.some((s) => !s.cwdExists)}
              statusLabel={statusLabel(first)}
              statusColor={statusColor(first)}
              sessionCount={projSessions.length}
              lastActivity={first.lastActivity}
              onRepair={severedSession ? () => { setRepairError(null); setEditingSession(severedSession) } : undefined}
            />
            {projSessions.map((s) => (
              <SessionBrowserRow
                key={`${s.agentKind}:${s.sessionId}`}
                session={s}
                isExpanded={detailSession?.agentKind === s.agentKind && detailSession?.sessionId === s.sessionId}
                onToggle={() =>
                  setDetailSession((prev) =>
                    prev?.agentKind === s.agentKind && prev?.sessionId === s.sessionId ? null : s
                  )
                }
                onResumeSplit={() => onResumeSplit(s)}
                onResumeNewTab={() => onResumeNewTab(s)}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

// ─── Deep search pane ─────────────────────────────────────────────────────────

interface DeepPaneProps {
  grouped: Map<string, SessionSearchResult[]>
  activeProject: string | null
  query: string
  searching: boolean
  detailSession: Session | null
  setDetailSession: React.Dispatch<React.SetStateAction<Session | null>>
  setEditingSession: React.Dispatch<React.SetStateAction<Session | null>>
  setRepairError: React.Dispatch<React.SetStateAction<string | null>>
  statusLabel: (s: Session) => string
  statusColor: (s: Session) => string
  onResumeSplit: (s: Session) => void
  onResumeNewTab: (s: Session) => void
}

function DeepPane({
  grouped, activeProject, query, searching, detailSession, setDetailSession,
  setEditingSession, setRepairError, statusLabel, statusColor, onResumeSplit, onResumeNewTab,
}: DeepPaneProps): JSX.Element {
  if (!query.trim()) {
    return (
      <div style={{ color: '#4a4b4e', fontSize: 12, padding: '20px 0' }}>
        Type to search across all transcript content.
      </div>
    )
  }
  if (searching && grouped.size === 0) {
    return <div style={{ color: '#4a4b4e', fontSize: 12, padding: '20px 0' }}>Searching transcripts…</div>
  }
  if (!searching && grouped.size === 0) {
    return <div style={{ color: '#4a4b4e', fontSize: 12, padding: '20px 0' }}>No matches found.</div>
  }

  return (
    <>
      {Array.from(grouped.entries()).map(([proj, results]) => {
        if (activeProject && proj !== activeProject) return null
        const first = results[0].session
        const severedResult = results.find((r) => !r.session.cwdExists) ?? null
        return (
          <div key={proj} style={{ marginBottom: 20 }}>
            <ProjectHeader
              proj={proj}
              cwd={first.cwd}
              hasSevered={results.some((r) => !r.session.cwdExists)}
              statusLabel={statusLabel(first)}
              statusColor={statusColor(first)}
              sessionCount={results.length}
              lastActivity={first.lastActivity}
              onRepair={severedResult ? () => { setRepairError(null); setEditingSession(severedResult.session) } : undefined}
            />
            {results.map((result) => (
              <DeepResultRow
                key={`${result.session.agentKind}:${result.session.sessionId}`}
                result={result}
                query={query}
                isExpanded={
                  detailSession?.agentKind === result.session.agentKind &&
                  detailSession?.sessionId === result.session.sessionId
                }
                onToggle={() =>
                  setDetailSession((prev) =>
                    prev?.agentKind === result.session.agentKind && prev?.sessionId === result.session.sessionId
                      ? null
                      : result.session
                  )
                }
                onResumeSplit={() => onResumeSplit(result.session)}
                onResumeNewTab={() => onResumeNewTab(result.session)}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

// ─── Shared project header ────────────────────────────────────────────────────

interface ProjectHeaderProps {
  proj: string
  cwd: string
  hasSevered: boolean
  statusLabel: string
  statusColor: string
  sessionCount: number
  lastActivity: string | null
  onRepair?: () => void
}

function ProjectHeader({ proj, cwd, hasSevered, statusLabel, statusColor, sessionCount, lastActivity, onRepair }: ProjectHeaderProps): JSX.Element {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 600, color: '#d4d4d4' }}>
            {hasSevered && <MissingDirectoryMark />}
            <span>{proj.split('/').pop()}</span>
          </span>
          <span style={{ fontSize: 11, color: '#4a4b4e', marginLeft: 8 }}>{cwd}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {onRepair && <ActionButton onClick={onRepair}>Repair directory</ActionButton>}
          <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, letterSpacing: '0.06em' }}>
            {statusLabel}
          </span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#4a4b4e', marginBottom: 8 }}>
        {sessionCount} session{sessionCount !== 1 ? 's' : ''} - last active {formatRelativeTime(lastActivity)} ago
      </div>
    </>
  )
}

// ─── Deep result row ──────────────────────────────────────────────────────────

interface DeepResultRowProps {
  result: SessionSearchResult
  query: string
  isExpanded: boolean
  onToggle: () => void
  onResumeSplit: () => void
  onResumeNewTab: () => void
}

function DeepResultRow({ result, query, isExpanded, onToggle, onResumeSplit, onResumeNewTab }: DeepResultRowProps): JSX.Element {
  const { session, matches, matchCount } = result
  const gitBranch = displayGitBranch(session.gitBranch)

  return (
    <div
      style={{
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        marginBottom: 4,
        overflow: 'hidden',
        backgroundColor: isExpanded ? '#1e2022' : '#141517',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 10px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: session.status === 'live-attached' ? '#4ade80' : 'transparent',
            border: session.status !== 'live-attached' ? '1.5px solid #6b7280' : 'none',
            flexShrink: 0,
          }}
        />
        {!session.cwdExists && <MissingDirectoryMark />}
        <span style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <AgentIcon agentKind={session.agentKind} size={14} />
        </span>
        <span style={{ fontSize: 11, color: '#4a4b4e', flexShrink: 0 }}>
          {formatRelativeTime(session.lastActivity)}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: '#d4d4d4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.firstMessage ?? session.sessionId}
        </span>
        <span style={{ fontSize: 10, color: '#4ade80', flexShrink: 0, marginLeft: 4 }}>
          {matchCount} match{matchCount !== 1 ? 'es' : ''}
        </span>
      </button>

      {/* Snippets — always shown in deep mode */}
      <div style={{ borderTop: '1px solid #2a2b2e' }}>
        {matches.map((match, i) => (
          <SnippetRow key={i} match={match} query={query} />
        ))}
      </div>

      {isExpanded && (
        <div style={{ padding: '8px 12px 10px', borderTop: '1px solid #2a2b2e' }}>
          <Row label="CWD" value={session.cwd} warning={!session.cwdExists ? 'Directory does not exist' : undefined} />
          <Row label="Agent" value={agentLabel(session.agentKind)} />
          {gitBranch && <Row label="Branch" value={gitBranch} />}
          {session.firstMessage && <Row label="First message" value={session.firstMessage} />}
          {session.lastMessage && session.lastMessage !== session.firstMessage && (
            <Row label="Last message" value={session.lastMessage} />
          )}
          <Row label="Messages" value={String(session.messageCount)} />
          <Row label="First activity" value={session.firstActivity ? new Date(session.firstActivity).toLocaleString() : '-'} />
          <Row label="Last activity" value={session.lastActivity ? new Date(session.lastActivity).toLocaleString() : '-'} />
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <ActionButton onClick={onResumeSplit} disabled={!session.cwdExists}>Resume in split</ActionButton>
            <ActionButton onClick={onResumeNewTab} disabled={!session.cwdExists}>Resume in new tab</ActionButton>
          </div>
        </div>
      )}
    </div>
  )
}

function roleBadgeColor(role: string): string {
  if (role === 'user') return '#60a5fa'
  if (role === 'assistant') return '#4ade80'
  if (role === 'tool' || role === 'system') return '#a78bfa'
  return '#4a4b4e'
}

interface SnippetRowProps {
  match: SessionSearchResult['matches'][number]
  query: string
}

function SnippetRow({ match, query }: SnippetRowProps): JSX.Element {
  // Highlight the query within the snippet for readability
  const lower = match.snippet.toLowerCase()
  const queryLower = query.toLowerCase()
  const idx = lower.indexOf(queryLower)

  let content: React.ReactNode
  if (idx !== -1) {
    const before = match.snippet.slice(0, idx)
    const highlight = match.snippet.slice(idx, idx + query.length)
    const after = match.snippet.slice(idx + query.length)
    content = (
      <>
        {before}
        <mark style={{ backgroundColor: 'rgba(250, 204, 21, 0.25)', color: '#facc15', borderRadius: 2 }}>
          {highlight}
        </mark>
        {after}
      </>
    )
  } else {
    content = match.snippet
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '5px 10px',
        borderBottom: '1px solid #1e1f22',
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: roleBadgeColor(match.role),
          letterSpacing: '0.05em',
          flexShrink: 0,
          marginTop: 1,
          textTransform: 'uppercase',
          minWidth: 46,
        }}
      >
        {match.role}
      </span>
      {match.timestamp && (
        <span style={{ fontSize: 10, color: '#3a3b3e', flexShrink: 0, marginTop: 1 }}>
          {new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <span style={{ fontSize: 11, color: '#8a8b8e', lineHeight: 1.5, wordBreak: 'break-word', flex: 1 }}>
        {content}
      </span>
    </div>
  )
}

// ─── Summary session row ──────────────────────────────────────────────────────

interface SessionBrowserRowProps {
  session: Session
  isExpanded: boolean
  onToggle: () => void
  onResumeSplit: () => void
  onResumeNewTab: () => void
}

function SessionBrowserRow({ session, isExpanded, onToggle, onResumeSplit, onResumeNewTab }: SessionBrowserRowProps): JSX.Element {
  const statusDotColor = session.status === 'live-attached' ? '#4ade80' : '#6b7280'
  const gitBranch = displayGitBranch(session.gitBranch)

  return (
    <div
      style={{
        border: '1px solid #2a2b2e',
        borderRadius: 6,
        marginBottom: 4,
        overflow: 'hidden',
        backgroundColor: isExpanded ? '#1e2022' : '#141517',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 10px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: session.status === 'live-attached' ? statusDotColor : 'transparent',
            border: session.status !== 'live-attached' ? `1.5px solid ${statusDotColor}` : 'none',
            flexShrink: 0,
            display: 'inline-block',
          }}
        />
        {!session.cwdExists && <MissingDirectoryMark />}
        <span style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <AgentIcon agentKind={session.agentKind} size={14} />
        </span>
        <span style={{ fontSize: 11, color: '#4a4b4e', flexShrink: 0 }}>
          {formatRelativeTime(session.lastActivity)}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 12,
            color: '#d4d4d4',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.firstMessage ?? session.sessionId}
        </span>
      </button>

      {isExpanded && (
        <div style={{ padding: '8px 12px 10px', borderTop: '1px solid #2a2b2e' }}>
          <Row label="CWD" value={session.cwd} warning={!session.cwdExists ? 'Directory does not exist' : undefined} />
          <Row label="Agent" value={agentLabel(session.agentKind)} />
          {gitBranch && <Row label="Branch" value={gitBranch} />}
          {session.firstMessage && <Row label="First message" value={session.firstMessage} />}
          {session.lastMessage && session.lastMessage !== session.firstMessage && (
            <Row label="Last message" value={session.lastMessage} />
          )}
          <Row label="Messages" value={String(session.messageCount)} />
          <Row label="First activity" value={session.firstActivity ? new Date(session.firstActivity).toLocaleString() : '-'} />
          <Row label="Last activity" value={session.lastActivity ? new Date(session.lastActivity).toLocaleString() : '-'} />
          <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
            <ActionButton onClick={onResumeSplit} disabled={!session.cwdExists}>Resume in split</ActionButton>
            <ActionButton onClick={onResumeNewTab} disabled={!session.cwdExists}>Resume in new tab</ActionButton>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function Row({ label, value, warning }: { label: string; value: string; warning?: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11 }}>
      <span style={{ color: '#4a4b4e', flexShrink: 0, minWidth: 90 }}>{label}</span>
      <span style={{ color: warning ? '#f87171' : '#a0a0a0', wordBreak: 'break-all' }}>
        {warning && <MissingDirectoryMark />}
        <span style={{ marginLeft: warning ? 5 : 0 }}>{value}</span>
        {warning && <span style={{ marginLeft: 8, color: '#f87171' }}>{warning}</span>}
      </span>
    </div>
  )
}

function MissingDirectoryMark(): JSX.Element {
  return (
    <span
      title="Directory does not exist"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 13,
        height: 13,
        borderRadius: '50%',
        border: '1px solid #f87171',
        color: '#f87171',
        fontSize: 10,
        fontWeight: 800,
        lineHeight: '13px',
        flexShrink: 0,
      }}
    >
      !
    </span>
  )
}

function ActionButton({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        backgroundColor: '#242528',
        border: '1px solid #2a2b2e',
        borderRadius: 4,
        color: disabled ? '#4a4b4e' : '#c9cdd1',
        fontSize: 11,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2e2f33'
      }}
      onMouseLeave={(e) => {
        if (disabled) return
        ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = '#242528'
      }}
    >
      {children}
    </button>
  )
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '3px 0',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.04em',
        background: active ? '#242528' : 'none',
        border: '1px solid',
        borderColor: active ? '#4ade80' : '#2a2b2e',
        borderRadius: 4,
        color: active ? '#4ade80' : '#4a4b4e',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
