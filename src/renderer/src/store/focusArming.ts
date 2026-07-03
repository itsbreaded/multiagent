export const focusArming = {
  pendingRemoteFocusWindowId: null as number | null,
  pendingRemoteFocusTimer: null as ReturnType<typeof setTimeout> | null,
  localRearmTimer: null as ReturnType<typeof setTimeout> | null,
  skipNextActivationDisarm: false,
  skipDisarmClearTimer: null as ReturnType<typeof setTimeout> | null,
}

export const LOCAL_REARM_MS = 150
export const SKIP_DISARM_TTL_MS = 400
