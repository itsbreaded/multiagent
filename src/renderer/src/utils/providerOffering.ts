import type { AgentKind, AgentProviderSettings, ProviderAvailability } from '../../../shared/types'

/**
 * spec 055: the single shared "which providers may a new-session entry point
 * offer?" set. A provider is offered when it is BOTH enabled by the user AND
 * detected on the app's PATH at startup. Every new-session entry point — the
 * command palette, spawn/split menus, sidebar spawn, empty-workspace quick-start,
 * and directory-picker — derives its agent choices from this selector so the
 * rule is applied consistently and no provider is silently offered where it
 * cannot launch or silently omitted where it can (Req 5/6).
 *
 * Stable order `claude, codex, opencode` so menus don't reshuffle across renders.
 */
const ORDER: readonly AgentKind[] = ['claude', 'codex', 'opencode']

export function offeredAgentKinds(
  agentProviders: AgentProviderSettings,
  availability: ProviderAvailability,
): AgentKind[] {
  return ORDER.filter((kind) => agentProviders[kind].enabled && availability[kind])
}

/** True when a kind is both enabled and detected — the per-kind gate for a single entry point. */
export function isProviderOffered(
  agentProviders: AgentProviderSettings,
  availability: ProviderAvailability,
  kind: AgentKind,
): boolean {
  return agentProviders[kind].enabled && availability[kind]
}