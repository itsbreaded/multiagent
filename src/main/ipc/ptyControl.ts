export interface PtyKillDeps {
  getOwner(ptyId: string): number | undefined
  unroute(ptyId: string): void
  release(ptyId: string): void | Promise<void>
  kill(ptyId: string): boolean | void
}

export function senderMayControlPty(owner: number | undefined, senderId: number): boolean {
  return owner === undefined || owner === senderId
}

export async function killPtyIfAllowed(deps: PtyKillDeps, ptyId: string, _senderId: number): Promise<boolean | void> {
  deps.unroute(ptyId)
  await deps.release(ptyId)
  return deps.kill(ptyId)
}
