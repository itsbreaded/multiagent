import type { AgentLifecycleEvent, CwdRepairMapping, FocusTarget, PaneLeaf, Tab } from '../../../shared/types'
import { collectLeaves, findLeafByPtyId } from '../../../shared/paneTree'
import { eventToState } from '../../../shared/agentStatus'
import { PANE_DRAG_MIME } from '../utils/paneDrag'
import { focusArming, LOCAL_REARM_MS } from './focusArming'
import { clearPendingRemoteFocus, isSpawnInTabPayload, reportCurrentFocusTarget, usePanesStore } from './panes'

// Imported as a side effect by panes.ts only after the store is initialized; keep
// store access inside wirePanesIpc/listener callbacks to preserve that ordering.
let wired = false

/** Wire renderer listeners once. Store access is deferred to avoid the panes↔panesIpc import cycle. */
export function wirePanesIpc(): void {
  if (wired || typeof window === 'undefined' || !window.ipc) return
  wired = true
  window.ipc.on('git:branch-updated', (cwdKeys: unknown, branch: unknown) => {
    if (!Array.isArray(cwdKeys) || !cwdKeys.every((key) => typeof key === 'string')) return
    const value = typeof branch === 'string' && branch.trim() ? branch : null
    usePanesStore.setState((s) => ({
      cwdGitBranches: cwdKeys.reduce((entries, key) => {
        entries[key] = { status: 'ready', branch: value }
        return entries
      }, { ...s.cwdGitBranches }),
    }))
  })

  window.ipc.on('pty:cwd', (ptyId: unknown, cwd: unknown) => {
    if (typeof ptyId === 'string' && typeof cwd === 'string') {
      usePanesStore.getState().setPaneCwd(ptyId, cwd)
    }
  })

  window.ipc.on('pty:exit', (ptyId: unknown, exitCode: unknown, signal: unknown) => {
    if (typeof ptyId !== 'string') return
    const code = typeof exitCode === 'number' ? exitCode : null
    usePanesStore.getState().markPtyExited(ptyId, code, typeof signal === 'number' ? signal : undefined)
  })

  window.ipc.on('session:detected', (ptyId: unknown, agentKind: unknown, sessionId: unknown) => {
    if (typeof ptyId !== 'string' || (agentKind !== 'claude' && agentKind !== 'codex') || typeof sessionId !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const pane = findLeafByPtyId(tab.rootNode, ptyId)
      if (pane) {
        // spec 047 phase 3: the managed Claude hook fires at session start, which can
        // race ahead of the sweeper's promotion. If the report arrives for a still-shell
        // pane, promote it first so the session id attaches to an agent pane. (For phase
        // 2 and native panes the pane is already an agent, so this is a no-op.)
        if (pane.paneType === 'shell') store.promoteShellPaneToAgent(pane.id, agentKind)
        store.setSessionId(pane.id, sessionId)
        break
      }
    }
  })

  // spec 047: a CLI-launched agent was detected in (or has exited from) a shell pane's
  // process tree. Promote the shell pane to an agent pane, or demote a previously-
  // promoted pane back to a shell. The store actions guard the transitions (only a shell
  // promotes; only a promotedFromShell pane demotes), so native agent panes are unaffected.
  window.ipc.on('pane:agent-detected', (ptyId: unknown, agentKind: unknown) => {
    if (typeof ptyId !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const pane = findLeafByPtyId(tab.rootNode, ptyId)
      if (pane) {
        if (agentKind === 'claude' || agentKind === 'codex') {
          store.promoteShellPaneToAgent(pane.id, agentKind)
        } else {
          store.demoteAgentPaneToShell(pane.id)
        }
        break
      }
    }
  })

  // spec 032: a lifecycle hook event from an agent pane. Main forwards it raw (it does NOT
  // reduce); the renderer owns per-pane prev state and runs the pure eventToState reducer.
  // Pane not yet hydrated is not a concern: the tab tree (incl. rootNode) exists for every
  // tab regardless of runtime hydration (spec 001), so findLeafByPtyId resolves and the
  // badge renders when PaneHeader mounts on first focus.
  const safeStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  window.ipc.on('pane:agent-event', (ptyId: unknown, event: unknown, detail: unknown, turnId: unknown) => {
    if (typeof ptyId !== 'string' || typeof event !== 'string') return
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const pane = findLeafByPtyId(tab.rootNode, ptyId)
      if (pane) {
        const next = eventToState(pane.agentStatus, { event: event as AgentLifecycleEvent, detail: safeStr(detail), turnId: safeStr(turnId) }, Date.now())
        store.setPaneAgentStatus(pane.id, next)
        break
      }
    }
  })

  window.ipc.on('session:detection-failed', (ptyId: unknown, agentKind: unknown, reason: unknown, mode: unknown) => {
    if (typeof ptyId !== 'string' || (agentKind !== 'claude' && agentKind !== 'codex')) return
    const message = mode === 'resume'
      ? 'Session resumed, but the live session id could not be confirmed'
      : 'Session detection timed out'
    const store = usePanesStore.getState()
    for (const tab of store.tabs) {
      if (!tab.rootNode) continue
      const pane = findLeafByPtyId(tab.rootNode, ptyId)
      if (!pane || pane.agentKind !== agentKind) continue
      store.updatePane(pane.id, {
        sessionDetectionState: 'failed',
        sessionDetectionError: typeof reason === 'string' ? `${message}: ${reason}` : message,
        ...(mode === 'resume' ? {} : { resumeError: message }),
      })
      break
    }
  })

  window.ipc.on('layout:cwd-repaired', (mapping: unknown) => {
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      typeof (mapping as CwdRepairMapping).oldCwd !== 'string' ||
      typeof (mapping as CwdRepairMapping).newCwd !== 'string'
    ) return
    usePanesStore.getState().applyCwdRepair(mapping as CwdRepairMapping)
  })

  // Main tells this window to release a tab (it moved to another window).
  // In a detached window: just remove it locally (PTYs stay alive in the destination).
  // In the primary window: mark it as detached so the sidebar still shows it.
  //
  // Two-phase (absorb) vs one-phase (bring-home / reattach-home):
  // - With a releaseId, this is the absorb handshake. We only ACK here and DEFER the actual
  //   removal/detach to tab:absorb-committed. Acting now would permanently lose the tab (and
  //   orphan its PTYs) if the absorb later timed out — the source dropped its copy and the
  //   absorber rolled back its optimistic copy. See specs/atomic-state-audit-followup #1.
  // - Without a releaseId (bring-home / reattach-home), there is no commit step, so apply
  //   immediately as before.
  window.ipc.on('tab:release', (tabId: unknown, ownerWindowId: unknown, releaseId: unknown) => {
    if (typeof tabId !== 'string') return
    if (typeof releaseId === 'string') {
      window.ipc.send('tab:release-applied', releaseId)
      return
    }
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) {
      store.removeTabLocally(tabId)
    } else {
      store.detachTab(tabId, typeof ownerWindowId === 'number' ? ownerWindowId : undefined)
    }
  })

  // Absorb committed: the PTYs have been transferred to the absorbing window, so it is now
  // safe to finalize releasing our copy of the tab (deferred from tab:release above).
  window.ipc.on('tab:absorb-committed', (tabId: unknown, ownerWindowId: unknown) => {
    if (typeof tabId !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) {
      store.removeTabLocally(tabId)
    } else {
      store.detachTab(tabId, typeof ownerWindowId === 'number' ? ownerWindowId : undefined)
    }
  })

  // Main tells the primary window to un-mark a tab and move it to the end of the tab bar.
  window.ipc.on('tab:return', (tabId: unknown) => {
    if (typeof tabId !== 'string') return
    usePanesStore.getState().returnTab(tabId)
    // Re-adopt the PTYs for this tab so main routes PTY output to this window again.
    // (PTY routing was deleted by unregister() when the detached window closed.)
    const tab = usePanesStore.getState().tabs.find((t) => t.id === tabId)
    if (tab?.rootNode) {
      const ptyIds = collectLeaves(tab.rootNode)
        .map((l) => l.ptyId)
        .filter((id): id is string => typeof id === 'string')
      if (ptyIds.length > 0) {
        void window.ipc.invoke('tab:adopt', ptyIds)
      }
    }
  })

  // Cross-window pane click: activate the correct tab and pane in this window's renderer.
  window.ipc.on('pane:focus-remote', (tabId: unknown, paneId: unknown, requestId: unknown) => {
    if (typeof tabId !== 'string' || typeof paneId !== 'string') return
    const store = usePanesStore.getState()
    store.focusPaneInTab(tabId, paneId)
    if (typeof requestId === 'string') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.ipc.send('pane:focus-remote-applied', requestId)
        })
      })
    }
  })

  window.ipc.on('tab:spawn-in-project-remote', (tabId: unknown, payload: unknown, requestId: unknown) => {
    if (typeof tabId !== 'string' || typeof requestId !== 'string' || !isSpawnInTabPayload(payload)) return
    usePanesStore.getState().spawnInTab(tabId, payload)
      .then(() => {
        window.ipc.send('tab:spawn-in-project-applied', requestId, true)
      })
      .catch((err) => {
        console.error('tab:spawn-in-project-remote failed', err)
        window.ipc.send('tab:spawn-in-project-applied', requestId, false)
      })
  })

  // Immediate focus update from a detached window — updates the synced tab's
  // focusedPaneId without waiting for the debounced tab:state-sync.
  window.ipc.on('pane:focus-changed', (windowId: unknown, tabId: unknown, paneId: unknown) => {
    if (typeof windowId !== 'number' || typeof tabId !== 'string' || typeof paneId !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) return
    usePanesStore.setState((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, focusedPaneId: paneId } : t),
      detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [String(windowId)]: tabId },
    }))
  })

  // Track which OS window currently has focus — used to show exactly one focused pane.
  window.ipc.on('window:became-active', (winId: unknown) => {
    if (typeof winId !== 'number') return
    const { windowId, activeWindowId: prevActive } = usePanesStore.getState()

    // Disarm the local sidebar highlight only when focus genuinely moves into THIS
    // window from a different window. Plain re-focus of an already-active window and
    // first focus at startup (prevActive === null) keep the highlight armed, so the
    // single-window case is never affected. A click on a local sidebar pane sets
    // focusArming.skipNextActivationDisarm so the activation it triggers does not disarm.
    const movedHereFromOtherWindow =
      winId === windowId && prevActive !== null && prevActive !== windowId
    const disarm = movedHereFromOtherWindow && !focusArming.skipNextActivationDisarm
    if (winId === windowId) focusArming.skipNextActivationDisarm = false

    if (disarm) {
      // Re-arm shortly after, so plain window activation still restores the last
      // focused pane. An intervening explicit focus arms it immediately and the
      // guard below leaves that alone. The content focus ring stays visible
      // throughout, so this only briefly defers the sidebar row highlight.
      if (focusArming.localRearmTimer !== null) clearTimeout(focusArming.localRearmTimer)
      focusArming.localRearmTimer = setTimeout(() => {
        focusArming.localRearmTimer = null
        const s = usePanesStore.getState()
        if (s.activeWindowId === s.windowId && !s.localFocusArmed) {
          usePanesStore.setState({ localFocusArmed: true })
        }
      }, LOCAL_REARM_MS)
    }

    if (focusArming.pendingRemoteFocusWindowId !== null) {
      if (winId === focusArming.pendingRemoteFocusWindowId) {
        // The correct remote window received OS focus. Clear the guard but keep
        // pendingFocusTarget visible — focus:target-changed will replace it with
        // the confirmed target once the detached window acks the focused pane.
        clearPendingRemoteFocus()
        usePanesStore.setState({ activeWindowId: winId })
        return
      } else if (winId === windowId) {
        if (disarm) usePanesStore.setState({ localFocusArmed: false })
        return
      } else {
        // A third window got focus; the pending focus request is stale.
        clearPendingRemoteFocus()
        usePanesStore.setState({ activeWindowId: winId, pendingFocusTarget: null })
        return
      }
    }
    usePanesStore.setState({
      activeWindowId: winId,
      pendingFocusTarget: null,
      ...(disarm ? { localFocusArmed: false } : {}),
    })
    if (winId === windowId) reportCurrentFocusTarget()
  })

  window.ipc.on('window:focus-state-request', () => {
    reportCurrentFocusTarget()
  })

  window.ipc.on('focus:target-changed', (target: unknown) => {
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof (target as FocusTarget).windowId !== 'number' ||
      typeof (target as FocusTarget).tabId !== 'string' ||
      typeof (target as FocusTarget).paneId !== 'string' ||
      typeof (target as FocusTarget).version !== 'number'
    ) return
    const next = target as FocusTarget
    const currentVersion = usePanesStore.getState().confirmedFocusTarget?.version ?? 0
    if (next.version <= currentVersion) return
    usePanesStore.setState((s) => ({
      activeWindowId: next.windowId,
      confirmedFocusTarget: next,
      // Only clear pendingFocusTarget when the confirmed target is for the same window
      // we were targeting. If a stale self-focus report from the main window arrives
      // after the user has already clicked a detached pane (pendingFocusTarget set),
      // leave pendingFocusTarget intact so the sidebar doesn't flash the wrong pane.
      pendingFocusTarget: s.pendingFocusTarget?.windowId === next.windowId ? null : s.pendingFocusTarget,
      // Only sync focusedPaneId for tabs owned by a different window.
      // For the local window, focusPaneInTab is the ground truth — overwriting here
      // with a stale self-focus report would revert a pane click that already fired.
      tabs: next.paneId && next.windowId !== s.windowId
        ? s.tabs.map((t) => t.id === next.tabId ? { ...t, focusedPaneId: next.paneId } : t)
        : s.tabs,
      detachedWindowActiveTabIds: { ...s.detachedWindowActiveTabIds, [String(next.windowId)]: next.tabId },
    }))
  })

  // Live sync from a detached window — only the primary window processes this.
  window.ipc.on('tab:state-sync', (windowId: unknown, tabsJson: unknown, activeTabId: unknown) => {
    if (typeof windowId !== 'number' || typeof tabsJson !== 'string') return
    const store = usePanesStore.getState()
    if (store.isDetachedWindow) return  // only primary merges syncs
    try {
      const tabs = JSON.parse(tabsJson) as Tab[]
      store.syncDetachedTabs(windowId, tabs, typeof activeTabId === 'string' ? activeTabId : undefined)
    } catch { /* ignore malformed */ }
  })

  // A pane has been transferred to this window from another window.
  window.ipc.on('pane:received', (paneJson: unknown, targetTabId: unknown, transferId: unknown) => {
    if (typeof paneJson !== 'string' || typeof targetTabId !== 'string') return
    try {
      const pane = JSON.parse(paneJson) as PaneLeaf
      const ok = usePanesStore.getState().addPaneToTab(pane, targetTabId)
      // Ack only if the target tab existed and the pane was added. If it no-ops (tab vanished
      // mid-drag), staying silent makes main time out and discard instead of removing the source.
      if (ok && typeof transferId === 'string') {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.ipc.send('pane:received-applied', transferId)
          })
        })
      }
    } catch { /* ignore */ }
  })

  window.ipc.on('pane:remove-remote', (paneId: unknown) => {
    if (typeof paneId !== 'string') return
    usePanesStore.getState().removePaneKeepTab(paneId)
  })

  // The transfer that delivered this pane (via pane:received) never committed; discard the
  // optimistically-added pane so it does not linger without PTY output.
  window.ipc.on('pane:transfer-rolledback', (paneId: unknown) => {
    if (typeof paneId !== 'string') return
    usePanesStore.getState().removePaneKeepTab(paneId)
  })

  window.ipc.on('pane:move-remote', (paneId: unknown, targetTabId: unknown) => {
    if (typeof paneId !== 'string' || typeof targetTabId !== 'string') return
    usePanesStore.getState().movePaneToTab(paneId, targetTabId)
  })

  // Track whether a pane drag is currently over this window. Document-level listeners fire
  // regardless of any element's pointer-events, so this works for cross-window drags (where
  // draggedPaneId is null in this renderer). The always-mounted sidebar split overlay reads
  // this to enable pointer events; without it, an overlay with pointerEvents:none can never
  // receive onDragEnter and the cross-window split silently no-ops.
  const setPaneDragActive = (active: boolean): void => {
    if (usePanesStore.getState().paneDragActive !== active) usePanesStore.setState({ paneDragActive: active })
  }
  window.addEventListener('dragover', (e: DragEvent) => {
    if (e.dataTransfer?.types?.includes(PANE_DRAG_MIME)) setPaneDragActive(true)
  }, true)
  window.addEventListener('drop', () => setPaneDragActive(false), true)
  window.addEventListener('dragend', () => setPaneDragActive(false), true)

  window.ipc.on('renderer:remove-pane', (paneId: unknown) => {
    if (typeof paneId !== 'string') return
    usePanesStore.getState().removePaneById(paneId)
  })

  window.ipc.on('renderer:insert-at-split', (paneJson: unknown, targetPaneId: unknown, direction: unknown, sourceBefore: unknown, transferId: unknown) => {
    if (
      typeof paneJson !== 'string' ||
      typeof targetPaneId !== 'string' ||
      (direction !== 'horizontal' && direction !== 'vertical') ||
      typeof sourceBefore !== 'boolean'
    ) return
    let ok = false
    try {
      const pane = JSON.parse(paneJson) as PaneLeaf
      ok = usePanesStore.getState().insertPaneAtSplit(pane, targetPaneId, direction, sourceBefore)
    } catch { return }
    // Ack only on a real insert. A no-op insert (self-drop, or target vanished mid-drag) must not
    // ack — otherwise main proceeds to remove the source pane and it is lost.
    if (ok && typeof transferId === 'string') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.ipc.send('renderer:insert-at-split-applied', transferId)
        })
      })
    }
  })

  window.ipc.on('renderer:replace-pane', (paneId: unknown, replacementJson: unknown, transferId: unknown) => {
    if (typeof paneId !== 'string' || typeof replacementJson !== 'string') return
    let ok = false
    try {
      const replacement = JSON.parse(replacementJson) as PaneLeaf
      ok = usePanesStore.getState().replacePaneById(paneId, replacement)
    } catch { return }
    // Ack only on a real replace, so a swap where one side's pane vanished does not half-apply:
    // the unacked side triggers the main-side rollback of the side that did apply.
    if (ok && typeof transferId === 'string') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.ipc.send('renderer:replace-pane-applied', transferId)
        })
      })
    }
  })
}

