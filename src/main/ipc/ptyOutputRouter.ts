import type { PtyManager, PtyReadyEvent } from '../pty/PtyManager'
import { parseOsc7, parseShellIntegrationCwd } from '../pty/shellIntegration'
import type { WindowManager } from '../window/WindowManager'

export const PTY_ROUTE_RETRY_MS = 50
export function createPtyOutputRouter(deps: { ptyManager: PtyManager; windowManager: Pick<WindowManager, 'sendToWindowForPty' | 'unroutePty'>; onCommandComplete?: (cwd: string) => void }) {
  const pending = new Map<string, string[]>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), lastCwd = new Map<string, string>(), oscTails = new Map<string, string>()
  function schedule(id: string): void { if (!timers.has(id)) timers.set(id, setTimeout(() => { timers.delete(id); flushDirectOutput(id) }, PTY_ROUTE_RETRY_MS)) }
  function releaseBuffer(id: string): void { const timer=timers.get(id); if(timer) clearTimeout(timer); timers.delete(id); pending.delete(id) }
  function send(id: string, data: string): void { if(!data)return; const buffered=pending.get(id); if(buffered){buffered.push(data);return} if(!deps.windowManager.sendToWindowForPty(id,'pty:data',id,data,0,data.length)){pending.set(id,[data]);schedule(id)} }
  function flushDirectOutput(id: string): void { const buffered=pending.get(id);if(!buffered)return;const joined=buffered.join('');if(deps.windowManager.sendToWindowForPty(id,'pty:data',id,joined,0,joined.length))releaseBuffer(id);else{pending.set(id,[joined]);schedule(id)} }
  function releasePty(id: string): void { releaseBuffer(id);lastCwd.delete(id);oscTails.delete(id) }
  deps.ptyManager.on('data',(id:string,data:string)=>{send(id,data);const scan=(oscTails.get(id)??'')+data;oscTails.set(id,scan.slice(-64));if(scan.includes('\x1b]633;D')){const cwd=lastCwd.get(id);if(cwd)deps.onCommandComplete?.(cwd)}if(scan.includes('\x1b]7;')||scan.includes('\x1b]633;P;Cwd=')){const cwd=parseShellIntegrationCwd(scan)??parseOsc7(scan);if(cwd&&lastCwd.get(id)!==cwd){lastCwd.set(id,cwd);deps.windowManager.sendToWindowForPty(id,'pty:cwd',id,cwd)}}})
  deps.ptyManager.on('ready',(event:PtyReadyEvent)=>{lastCwd.set(event.id,event.cwd);deps.windowManager.sendToWindowForPty(event.id,'pty:ready',event.id,{pid:event.pid,cwd:event.cwd,windowsPty:event.windowsPty});deps.windowManager.sendToWindowForPty(event.id,'pty:cwd',event.id,event.cwd)})
  deps.ptyManager.on('exit',(id:string,code:number,signal?:number)=>{if(code!==0)send(id,`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);deps.windowManager.sendToWindowForPty(id,'pty:exit',id,code,signal);deps.windowManager.unroutePty(id);releasePty(id)})
  deps.ptyManager.on('error',(id:string,error:Error)=>{console.error('[PtyManager] error:',id,error);send(id,`\r\n\x1b[31m[terminal error: ${error.message}]\x1b[0m\r\n`)})
  return { flushDirectOutput, releasePty, getLastCwd:(id:string)=>lastCwd.get(id), dispose:()=>{for(const timer of timers.values())clearTimeout(timer);timers.clear();pending.clear();lastCwd.clear();oscTails.clear()} }
}
