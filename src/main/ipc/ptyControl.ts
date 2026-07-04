export interface PtyKillDeps {
  getOwner(ptyId: string): number | undefined
  unroute(ptyId: string): void
  release(ptyId: string): void
  kill(ptyId: string): boolean | void
}

export function senderMayControlPty(owner: number | undefined, senderId: number): boolean {
  return owner === undefined || owner === senderId
}

export function killPtyIfAllowed(deps: PtyKillDeps, ptyId: string, _senderId: number): boolean | void {
  deps.unroute(ptyId)
  deps.release(ptyId)
  return deps.kill(ptyId)
}
