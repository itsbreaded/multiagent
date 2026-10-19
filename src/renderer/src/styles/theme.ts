import type React from 'react'

export const defaultTheme = {
  color: {
    appBg: '#0e1011',
    panel: '#1a1b1e',
    panelSubtle: '#18191c',
    panelRaised: '#1e2022',
    input: '#141517',
    badge: '#191a1d',
    control: '#242528',
    controlHover: '#2e2f33',
    border: '#2a2b2e',
    borderSubtle: '#222326',
    text: '#c9cdd1',
    textStrong: '#e2e4e6',
    textMuted: '#6b7280',
    textDim: '#4a4b4e',
    textFaint: '#3a3b3e',
    accent: '#4ade80',
    accentBg: '#1a3a1a',
    jiraStatusNew: '#b9c1ca',
    jiraStatusNewBackground: '#252a30',
    jiraStatusNewBorder: '#3b424b',
    jiraStatusProgress: '#a5cbfa',
    jiraStatusProgressBackground: '#1b2b40',
    jiraStatusProgressBorder: '#344960',
    jiraStatusDone: '#a1d8b1',
    jiraStatusDoneBackground: '#1b3024',
    jiraStatusDoneBorder: '#355540',
    jiraIssueType: '#c9cdd1',
    jiraIssueTypeBackground: '#25282b',
    jiraIssueTypeBorder: '#363b40',
    jiraPriority: '#e5c88c',
    danger: '#f87171',
    statusWorking: '#60a5fa',   // spec 032: turn in progress (incl. thinking)
    statusWaiting: '#fbbf24',  // spec 032: permission prompt -- needs you
    scrollbarThumb: '#3a3b3e',
    scrollbarThumbHover: '#5a5c61',
    textSubtle: '#d4d4d4',
    textSecondary: '#a0a4a8',
    textMutedStrong: '#9ca3af',
    textMutedSoft: '#9aa0a6',
    textNeutral: '#a0a0a0',
    textUnavailable: '#8a8b8e',
    textDisabled: '#8b9097',
    textChromeSecondary: '#888',
    statusDisconnected: '#7b8188',
    borderDisabled: '#555',
    borderStrong: '#5a5f66',
    borderMuted: '#4b5563',
    surfaceDeep: '#0e0f11',
    surfaceInset: '#1e1f22',
    surfaceRaisedAlt: '#1c1d20',
    surfaceChromeLow: '#161819',
    paneActiveSurface: '#111815',
    paneFocusOutline: '#4ade8033',
    paneFocusSurface: 'rgba(74, 222, 128, 0.12)',
    dropSurface: 'rgba(74, 222, 128, 0.25)',
    dropSurfaceStrong: 'rgba(74, 222, 128, 0.45)',
    dropDanger: '#ef4444',
    dropDangerSurface: 'rgba(239, 68, 68, 0.10)',
    dangerSurface: '#2a1a1a',
    dangerBorder: '#5a2020',
    dangerSurfaceStrong: '#3a1a1a',
    dangerBorderStrong: '#6b3030',
    dangerStrong: '#ef4444',
    warningSurface: '#2a2410',
    warningBorder: '#5a4810',
    warningStrong: '#facc15',
    warningSelectionSurface: 'rgba(250, 204, 21, 0.25)',
    successSurface: '#1a2a1a',
    successBorder: '#205a20',
    providerCardSurface: '#141e14',
    providerCardBorder: '#2a4a2a',
    providerErrorSurface: '#3a1a1a',
    providerAccent: '#a0c4e8',
    providerClaudeAccent: '#4ade80',
    providerCodexAccent: '#60a5fa',
    providerOpenCodeAccent: '#c084fc',
    sessionOpenCodeAccent: '#a78bfa',
    mcpEnabledSurface: '#0f2a15',
    mcpEnabledBorder: '#1a4a25',
    mcpSuccessBorder: '#2a5a2a',
    mcpDisabledSurface: '#0a1f0a',
    transportBlueSurface: '#0d1f2d',
    transportBlueBorder: '#1a3a5a',
    transportBlueText: '#60a0d0',
    transportOrangeSurface: '#1f1a0d',
    transportOrangeBorder: '#5a3a1a',
    transportOrangeText: '#d09060',
    transportPurpleSurface: '#1a0d1f',
    transportPurpleBorder: '#3a1a5a',
    transportPurpleText: '#a060d0',
    chromeCloseHover: '#c42b1c',
    chromeCloseGlyph: '#ffffff',
    textOnAccent: '#ffffff',
    updateBannerBorder: '#3a3a3a',
    updateBannerText: '#888',
    imageViewerBackdrop: 'rgba(0, 0, 0, 0.86)',
    backdropSoft: 'rgba(0,0,0,0.4)',
    backdropMedium: 'rgba(0,0,0,0.45)',
    backdropStrong: 'rgba(0,0,0,0.5)',
    terminalMenuSurface: '#24272a',
    terminalMenuSurfaceHover: '#3a3f44',
    terminalMenuSurfaceDeep: '#17191b',
    terminalMenuBorder: '#2a2d30',
    terminalMenuText: '#b8bec5',
    terminalMenuMuted: '#6f7780',
    terminalMenuWarningSurface: '#211a08',
    terminalMenuWarningBorder: '#49360b',
    terminalMenuErrorSurface: '#1e1010',
    terminalMenuErrorBorder: '#3a1010',
    terminalMenuAction: '#2d6cdf',
    terminalMenuActionHover: '#3979ee',
    terminalMenuShadow: 'rgba(0,0,0,0.45)',
    terminalMenuBackdrop: 'rgba(0,0,0,0.4)',
    terminalMenuBackdropSoft: 'rgba(14, 16, 17, 0.72)',
    terminalMenuBackdropStrong: 'rgba(14, 16, 17, 0.82)',
    chromeBackdrop: 'rgba(0,0,0,0.7)',
    menuBackdrop: 'rgba(0,0,0,0.8)',
    softBackdrop: 'rgba(0,0,0,0.55)',
    mediaPlaceholder: '#9da3aa',
  },
  radius: {
    xs: 2,
    sm: 3,
    md: 5,
    lg: 6,
    modal: 10,
  },
  shadow: {
    menu: '0 8px 24px rgba(0,0,0,0.55)',
    dropdown: '0 8px 24px rgba(0,0,0,0.5)',
    overlay: '0 24px 64px rgba(0,0,0,0.6)',
    terminalMenu: '0 4px 16px rgba(0,0,0,0.4)',
  },
  z: {
    resizeHandle: 10,
    menuBackdrop: 200,
    menu: 201,
    sessionOverlay: 50,
    overlay: 60,
  },
  chrome: {
    height: 42,
    detachedHeight: 34,
    background: '#111315',
    backgroundDetached: '#121416',
    tabActive: '#1e2022',
    tabInactiveHover: '#1a1b1e',
    controlSize: 32,
    windowControlWidth: 46,
  },
  nativeColorScheme: 'dark',
} as const

type StringValues<T> = { [K in keyof T]: string }
type NumberValues<T> = { [K in keyof T]: number }

export type ThemeDefinition = {
  color: StringValues<typeof defaultTheme.color>
  radius: NumberValues<typeof defaultTheme.radius>
  shadow: StringValues<typeof defaultTheme.shadow>
  chrome: {
    height: number
    detachedHeight: number
    background: string
    backgroundDetached: string
    tabActive: string
    tabInactiveHover: string
    controlSize: number
    windowControlWidth: number
  }
  nativeColorScheme: 'dark' | 'light'
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

export function themeToCssVariables(theme: ThemeDefinition): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [name, value] of Object.entries(theme.color)) {
    variables[`--ui-color-${toKebabCase(name)}`] = value
  }
  for (const [name, value] of Object.entries(theme.radius)) {
    variables[`--ui-radius-${toKebabCase(name)}`] = `${value}px`
  }
  for (const [name, value] of Object.entries(theme.shadow)) {
    variables[`--ui-shadow-${toKebabCase(name)}`] = value
  }
  for (const [name, value] of Object.entries(theme.chrome)) {
    variables[`--ui-chrome-${toKebabCase(name)}`] = typeof value === 'number' ? `${value}px` : value
  }
  variables['--ui-native-color-scheme'] = theme.nativeColorScheme
  return variables
}

export function installTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeToCssVariables(theme))) {
    root.style.setProperty(name, value)
  }
  root.dispatchEvent(new Event('ui-theme-change'))
}

export function readThemeColor<K extends keyof ThemeDefinition['color']>(
  name: K,
  root: HTMLElement = document.documentElement,
): string {
  return root.style.getPropertyValue(`--ui-color-${toKebabCase(String(name))}`).trim() || defaultTheme.color[name]
}

function tokenColor<K extends keyof ThemeDefinition['color']>(name: K): string {
  return `var(--ui-color-${toKebabCase(String(name))})`
}

export const ui = {
  color: Object.fromEntries(Object.keys(defaultTheme.color).map((name) => [name, tokenColor(name as keyof ThemeDefinition['color'])])) as StringValues<typeof defaultTheme.color>,
  radius: Object.fromEntries(Object.keys(defaultTheme.radius).map((name) => [name, `var(--ui-radius-${toKebabCase(name)})`])) as StringValues<typeof defaultTheme.radius>,
  shadow: Object.fromEntries(Object.keys(defaultTheme.shadow).map((name) => [name, `var(--ui-shadow-${toKebabCase(name)})`])) as StringValues<typeof defaultTheme.shadow>,
  chrome: {
    height: defaultTheme.chrome.height,
    detachedHeight: defaultTheme.chrome.detachedHeight,
    background: 'var(--ui-chrome-background)',
    backgroundDetached: 'var(--ui-chrome-background-detached)',
    tabActive: 'var(--ui-chrome-tab-active)',
    tabInactiveHover: 'var(--ui-chrome-tab-inactive-hover)',
    controlSize: defaultTheme.chrome.controlSize,
    windowControlWidth: defaultTheme.chrome.windowControlWidth,
  },
  z: defaultTheme.z,
  className: {
    darkScrollbar: 'dark-scrollbar',
    control: 'ui-control',
    checkbox: 'ui-control ui-control-checkbox',
  },
} as const

export const overlayStyles = {
  backdrop: { position: 'fixed', inset: 0, backgroundColor: ui.color.menuBackdrop, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  backdropLight: { position: 'fixed', inset: 0, backgroundColor: ui.color.chromeBackdrop, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '15vh' },
  panel: { backgroundColor: ui.color.panel, border: `1px solid ${ui.color.border}`, borderRadius: ui.radius.modal, overflow: 'hidden', boxShadow: ui.shadow.overlay },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${ui.color.border}`, flexShrink: 0 },
  headerTitle: { fontSize: 14, fontWeight: 600, color: ui.color.textStrong },
  headerHint: { fontSize: 11, color: ui.color.textDim },
} satisfies Record<string, React.CSSProperties>

export const border = {
  default: `1px solid ${ui.color.border}`,
  accent: `1px solid ${ui.color.accent}`,
} as const

export const sidebarStyles = {
  root: {
    backgroundColor: ui.color.panel,
    borderRight: border.default,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    flexShrink: 0,
    position: 'relative',
  },
  actionRow: {
    padding: '8px 8px 6px',
    display: 'flex',
    gap: 5,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 12px',
    color: ui.color.textMuted,
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    userSelect: 'none',
    boxSizing: 'border-box',
  },
  sectionTitleButton: {
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: 'inherit',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  sectionToggle: {
    background: 'none',
    border: 'none',
    padding: 0,
    color: 'inherit',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  sectionCount: {
    marginLeft: 'auto',
    fontSize: 11,
    color: ui.color.textDim,
    fontWeight: 400,
    textTransform: 'none',
    letterSpacing: 0,
    flexShrink: 0,
  },
  hoverActionGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
    transition: 'opacity 0.1s',
  },
  hoverIconButton: {
    width: 18,
    height: 18,
    border: 'none',
    borderRadius: ui.radius.sm,
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
    flexShrink: 0,
  },
  hoverIconImage: {
    width: 12,
    height: 12,
    display: 'block',
    opacity: 0.72,
  },
  paneHoverActionGroup: {
    position: 'absolute',
    right: 7,
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    transition: 'opacity 0.1s',
  },
  dock: {
    flexShrink: 0,
    borderTop: border.default,
    backgroundColor: ui.color.panelSubtle,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  resizeHandleVertical: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 4,
    cursor: 'col-resize',
    userSelect: 'none',
    zIndex: ui.z.resizeHandle,
  },
  resizeHandleHorizontal: {
    position: 'absolute',
    top: -3,
    left: 0,
    right: 0,
    height: 6,
    cursor: 'row-resize',
    userSelect: 'none',
    zIndex: ui.z.resizeHandle + 1,
  },
} satisfies Record<string, React.CSSProperties>

export const menuStyles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: ui.z.menuBackdrop,
  },
  panel: {
    position: 'fixed',
    zIndex: ui.z.menu,
    backgroundColor: ui.color.panel,
    border: border.default,
    borderRadius: ui.radius.lg,
    padding: '4px 0',
    minWidth: 200,
    boxShadow: ui.shadow.menu,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '7px 12px',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    fontSize: 12,
    gap: 12,
  },
  label: {
    padding: '5px 12px 3px',
    fontSize: 10,
    color: ui.color.textDim,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  separator: {
    height: 1,
    backgroundColor: ui.color.border,
    margin: '3px 0',
  },
} satisfies Record<string, React.CSSProperties>

export const controlStyles = {
  sidebarButton: {
    padding: '5px 4px',
    backgroundColor: ui.color.control,
    border: border.default,
    borderRadius: ui.radius.md,
    color: ui.color.text,
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: 500,
    textAlign: 'center',
  },
} satisfies Record<string, React.CSSProperties>
