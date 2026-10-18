// Separate preview using a local Jira snapshot. Reply posting is simulated; no API writes.
const variant = document.body.dataset.variant
const live = window.jiraPreviewData
if(!live?.tickets?.length){document.getElementById('root').textContent='Local Jira snapshot is unavailable.';throw new Error('Missing local Jira snapshot')}
const realTickets=new Map(live.tickets.map(ticket=>[ticket.key,ticket]))
const descriptionHeights=new Map()
function dateLabel(value){return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function bodyText(node){
  if(!node)return ''
  if(typeof node==='string')return node
  if(node.type==='text')return node.text||''
  if(node.type==='mention')return node.attrs?.text||'@User'
  if(node.type==='hardBreak')return '\n'
  const text=(node.content||[]).map(bodyText).join('')
  return ['paragraph','heading','listItem','codeBlock'].includes(node.type)?text+'\n':text
}
const actualMentions=live.tickets.flatMap(ticket=>ticket.comments.filter(comment=>ticket.unansweredIds.includes(comment.id)).map(comment=>({ticket,comment})))
const focusComments=actualMentions.length?actualMentions:live.tickets.flatMap(ticket=>ticket.comments.filter(comment=>comment.author?.accountId!==live.currentUser.accountId).slice(-1).map(comment=>({ticket,comment})))
const items=focusComments.map(({ticket,comment})=>({key:ticket.key,title:escapeHtml(ticket.fields.summary||ticket.key),from:escapeHtml(comment.author?.displayName||'Unavailable user'),authorId:comment.author?.accountId,age:dateLabel(comment.created),date:dateLabel(comment.created),text:escapeHtml(bodyText(comment.body)),project:escapeHtml(ticket.fields.project?.name||''),initials:escapeHtml((comment.author?.displayName||'?').split(' ').slice(0,2).map(part=>part[0]).join('')),commentId:comment.id,createdAt:Date.parse(comment.created)||0,body:comment.body}))
const localActions=new Map()
const replyDrafts=new Map()
const userSets=new Map()
for(const ticket of live.tickets){
  const users=new Map()
  function scan(node,source){
    if(!node||typeof node!=='object')return
    if(typeof node.accountId==='string'&&typeof node.displayName==='string'){
      const previous=users.get(node.accountId)
      if(!previous)users.set(node.accountId,{accountId:node.accountId,name:node.displayName,source})
    }
    if(node.type==='mention'&&typeof node.attrs?.id==='string'&&!users.has(node.attrs.id))users.set(node.attrs.id,{accountId:node.attrs.id,name:(node.attrs.text||'User').replace(/^@/,''),source:'Mentioned'})
    for(const value of Array.isArray(node)?node:Object.values(node))scan(value,source)
  }
  scan(ticket.fields.assignee,'Assignee');scan(ticket.fields.reporter,'Reporter');scan(ticket.fields.creator,'Creator');scan(ticket.comments,'Comment author');scan(ticket.fields,'Ticket user')
  userSets.set(ticket.key,[...users.values()])
}
function issueUsers(issue){return [...(userSets.get(issue)||[])]}
function escapeHtml(value){return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

let inboxFilter = 'active'
function activeCount(){return items.filter((_,i)=>!localActions.has(i)).length}
function visibleItems(){
  const entries=items.map((item,index)=>({item,index})).filter(({index})=>(localActions.get(index)?.kind || 'active')===inboxFilter)
  const newestByIssue=new Map()
  for(const {item} of entries)newestByIssue.set(item.key,Math.max(newestByIssue.get(item.key)||0,item.createdAt))
  return entries.sort((a,b)=>a.item.key===b.item.key?a.item.createdAt-b.item.createdAt||a.index-b.index:newestByIssue.get(b.item.key)-newestByIssue.get(a.item.key)||a.item.key.localeCompare(b.item.key))
}
let selected = null
let activeView = variant === 'tab' ? 'jira' : 'project'
let featureOpen = variant === 'tab'
let sidebarOrder = ['jira', 'storefront', 'platform']
let activeProject = 'storefront'
const icon = name => `../../../src/renderer/src/assets/${name}.png`
const settings = `
  <div class="settings-backdrop" id="settings" role="dialog" aria-modal="true" aria-label="Jira settings">
    <div class="settings-modal"><div class="settings-nav"><div class="eyebrow">Settings</div><div>Appearance</div><div>Hotkeys</div><div>Terminal</div><div>MCP</div><div>Providers</div><div class="active">Jira</div><div>Updates</div></div>
      <div class="settings-content"><div class="settings-title"><span>Settings</span><button class="control" data-close-settings>Close</button></div><div class="settings-body">
        <div class="eyebrow">Jira</div><h3 style="margin-top:6px">Unanswered mentions</h3>
        <div class="settings-card"><label class="check"><input type="checkbox" checked> Enable unanswered mentions</label>
          <label class="check"><input id="poll-enabled" type="checkbox"> Refresh in the background</label>
          <div class="field"><label for="poll-minutes">Interval (5-240 minutes)</label><input id="poll-minutes" type="number" min="5" max="240" step="1" value="15" disabled></div>
        </div>
      </div></div>
    </div>
  </div>`
function chrome(){return `<header class="chrome"><div class="chrome-left"><button title="Toggle sidebar"><img class="icon" src="${icon('leftpanelclosed')}" alt=""></button><button title="Session browser"><img class="icon" src="${icon('book')}" alt=""></button><button title="Command palette"><img class="icon" src="${icon('search')}" alt=""></button><button data-settings title="Settings" aria-label="Open settings"><img class="icon" src="${icon('settings')}" alt=""></button>${variant==='tab'?`<button class="feature-button ${featureOpen?'active':''}" data-feature-toggle title="Jira mentions: ${activeCount()} unanswered" aria-label="Show Jira mentions in sidebar"><span class="feature-symbol">@</span><span class="feature-count">${activeCount()}</span></button>`:''}</div></header>`}
function sidebarEntry(id) {
  if (id === 'jira') {
    if (variant !== 'tab' || !featureOpen) return ''
    return `<section class="sidebar-entry" data-sidebar-entry="jira" draggable="true"><button class="section-head feature-entry ${activeView === 'jira' ? 'active' : ''}" data-jira-view><span class="feature-symbol">@</span><span>Jira mentions</span><span class="spacer"></span><span class="count">${activeCount()}</span></button></section>`
  }
  const name = id === 'storefront' ? 'Storefront' : 'Platform'
  const expanded = id === 'storefront' || (activeView === 'project' && activeProject === id)
  return `<section class="sidebar-entry" data-sidebar-entry="${id}" draggable="true"><button class="section-head project-switch" data-project="${id}"><img class="icon" src="${icon(expanded ? 'chevrondown' : 'chevronright')}" alt=""> ${name}<span class="right">${id === 'storefront' ? '4' : '1'}</span></button>${expanded ? `<div class="project"><div class="pane">Claude Code &middot; home</div>${id === 'storefront' ? '<div class="pane">OpenCode &middot; home</div>' : ''}<div class="pane ${activeView === 'project' && activeProject === id ? 'active' : ''}" data-project="${id}">Codex &middot; home</div>${id === 'storefront' ? '<div class="pane">Shell &middot; home</div>' : ''}</div>` : ''}</section>`
}
function sidebar() {
  return `<aside class="sidebar"><div class="side-actions"><button class="grow"><img class="icon" src="${icon('newfolder')}" alt=""> New Project Folder</button><button aria-label="Expand all"><img class="icon" src="${icon('collapse_all')}" alt=""></button><button aria-label="Refresh Jira statuses"><img class="icon" src="${icon('refresh')}" alt=""></button></div><div class="side-scroll" id="sidebarEntries">${sidebarOrder.map(sidebarEntry).join('')}</div><div class="side-bottom"><div class="section-head">Recent <span class="right">4</span></div><div class="recent">demo-workspace <small>Review checkout flow&hellip;</small></div><div class="recent">demo-workspace <small>Audit test plan&hellip;</small></div></div></aside>`
}
function terminal(){return `<div class="workspace"><div class="terminal-head"><span>⌘ Codex · home</span><span>▣ &nbsp; ⤢ &nbsp; ×</span></div><div class="terminal"><span class="hint">MultiAgent</span><br><br>Ready to work in <span class="prompt">${activeProject === 'platform' ? 'Platform' : 'Storefront'}</span>.<br><br><span class="prompt">›</span> <span class="cursor"></span></div></div>`}
function list(){
  const groups=new Map()
  for(const entry of visibleItems()){
    if(!groups.has(entry.item.key))groups.set(entry.item.key,[])
    groups.get(entry.item.key).push(entry)
  }
  return `<div class="list-pane"><div class="board-head"><div class="inbox-heading"><div class="title">${actualMentions.length?'Needs your reply':'Ticket context'} <span class="count">${activeCount()}</span></div><span class="sub" id="checked">${escapeHtml(dateLabel(live.fetchedAt))}</span></div><div class="inbox-controls"><input class="search" id="search" placeholder="Search" aria-label="Find in inbox"><select class="control" id="inbox-filter" aria-label="Comment view">${['active','snoozed','dismissed'].map(value=>`<option value="${value}" ${inboxFilter===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select><button class="control inbox-refresh" data-refresh title="Refresh mentions" aria-label="Refresh mentions"><img class="icon" src="${icon('refresh')}" alt=""></button></div></div><div class="items" id="items">${[...groups.entries()].map(([key,entries])=>`<div class="issue-group"><div class="issue-group-head"><span class="key">${key}</span><span class="sub">${entries.length} comment${entries.length===1?'':'s'}</span><div>${entries[0].item.title}</div></div>${entries.map(({item,index})=>card(item,index)).join('')}</div>`).join('') || '<div class="sub" style="padding:22px">No comments in this view.</div>'}</div></div>`
}
function card(x,i){return `<button class="item ${i===selected?'selected':''}" data-item="${i}"><div class="item-top"><strong>${x.from}</strong><span class="item-time">${x.age}</span></div><div class="item-snippet" style="margin-top:7px">${x.text}</div>${localActions.get(i)?.until?`<div class="item-from">Snoozed until ${new Date(localActions.get(i).until).toLocaleString()}</div>`:''}</button>`}
function replyComposer(x){
  return `<div class="reply-composer"><label id="reply-label" class="eyebrow">Reply</label><div class="reply-editor-wrap"><div id="reply-text" class="reply-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="reply-label" data-placeholder="Reply..."></div><div id="mention-menu" class="mention-menu" role="listbox" hidden></div></div><div class="row"><span class="spacer"></span><button class="control primary" data-post-reply disabled>Post reply</button></div></div>`
}
function commentActions(action){
  return `<div class="comment-actions">${action?'<button class="control" data-restore>Return to active</button>':'<select class="control" id="snooze" aria-label="Snooze comment"><option value="">Snooze...</option><option value="2h">2 hours</option><option value="1d">1 day</option><option value="monday">Monday at 9 AM</option></select><button class="control" data-dismiss>Dismiss</button>'}</div>`
}
function bindReplyEditor(){
  const editor=document.getElementById('reply-text')
  if(!editor)return
  const issue=items[selected].key
  const candidates=issueUsers(issue).sort((a,b)=>Number(b.accountId===items[selected].authorId)-Number(a.accountId===items[selected].authorId))
  const post=document.querySelector('[data-post-reply]')
  const menu=document.getElementById('mention-menu')
  editor.innerHTML=replyDrafts.get(issue)||''
  let insertionRange=null
  let matches=[]
  let active=0
  function save(){replyDrafts.set(issue,editor.innerHTML);post.disabled=!editor.textContent.trim()}
  function closeMenu(){menu.hidden=true;insertionRange=null;editor.removeAttribute('aria-activedescendant')}
  function drawMenu(){
    menu.hidden=false
    menu.innerHTML=matches.map((user,index)=>`<button type="button" role="option" id="mention-option-${index}" aria-selected="${index===active}" data-mention-index="${index}" class="mention-option ${index===active?'active':''}"><span class="mention-avatar">${escapeHtml(user.name.split(' ').map(part=>part[0]).join(''))}</span><span>${escapeHtml(user.name)}</span><span class="mention-source">${escapeHtml(user.source)}</span></button>`).join('')
    editor.setAttribute('aria-activedescendant','mention-option-'+active)
    menu.querySelectorAll('[data-mention-index]').forEach(button=>{
      button.addEventListener('mousedown',event=>event.preventDefault())
      button.addEventListener('click',()=>insertMention(matches[Number(button.dataset.mentionIndex)]))
    })
  }
  function updateMenu(){
    const selection=window.getSelection()
    if(!selection.rangeCount||!selection.isCollapsed||!editor.contains(selection.anchorNode)||selection.anchorNode.nodeType!==Node.TEXT_NODE){closeMenu();return}
    const node=selection.anchorNode
    const before=node.textContent.slice(0,selection.anchorOffset)
    const found=before.match(/@([^\s@]*)$/)
    if(!found){closeMenu();return}
    const start=before.length-found[0].length
    if(start>0&&!/\s/.test(before[start-1])){closeMenu();return}
    matches=candidates.filter(user=>user.name.toLowerCase().includes(found[1].toLowerCase()))
    if(!matches.length){closeMenu();return}
    insertionRange=selection.getRangeAt(0).cloneRange()
    insertionRange.setStart(node,start)
    active=0
    drawMenu()
  }
  function mentionNode(user){
    const span=document.createElement('span')
    span.className='inline-mention'
    span.contentEditable='false'
    span.dataset.accountId=user.accountId
    span.textContent='@'+user.name
    return span
  }
  function insertMention(user){
    if(!insertionRange)return
    const range=insertionRange
    range.deleteContents()
    const token=mentionNode(user)
    range.insertNode(token)
    const space=document.createTextNode(' ')
    token.after(space)
    const caret=document.createRange()
    caret.setStart(space,1)
    caret.collapse(true)
    const selection=window.getSelection()
    selection.removeAllRanges()
    selection.addRange(caret)
    editor.focus()
    closeMenu()
    save()
  }
  editor.addEventListener('input',()=>{save();updateMenu()})
  editor.addEventListener('keyup',event=>{if(!['ArrowDown','ArrowUp','Enter','Escape'].includes(event.key))updateMenu()})
  editor.addEventListener('keydown',event=>{
    if(menu.hidden)return
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault()
      active=(active+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length
      drawMenu()
    }else if(event.key==='Enter'||event.key==='Tab'){
      event.preventDefault()
      insertMention(matches[active])
    }else if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();closeMenu()
    }
  })
  editor.addEventListener('blur',()=>setTimeout(closeMenu,150))
  editor.addEventListener('paste',event=>{
    event.preventDefault()
    const source=document.createElement('div')
    const html=event.clipboardData.getData('text/html')
    if(html)source.innerHTML=html
    else source.textContent=event.clipboardData.getData('text/plain')
    const fragment=document.createDocumentFragment()
    function copy(node){
      if(node.nodeType===Node.TEXT_NODE){fragment.append(document.createTextNode(node.textContent));return}
      const user=candidates.find(candidate=>candidate.accountId===node.dataset?.accountId)
      if(user){fragment.append(mentionNode(user));return}
      if(node.nodeName==='BR'){fragment.append(document.createElement('br'));return}
      if(['DIV','P'].includes(node.nodeName)&&fragment.childNodes.length)fragment.append(document.createElement('br'))
      node.childNodes.forEach(copy)
    }
    source.childNodes.forEach(copy)
    const selection=window.getSelection()
    if(selection.rangeCount&&editor.contains(selection.anchorNode)){
      const range=selection.getRangeAt(0)
      range.deleteContents()
      const last=fragment.lastChild
      range.insertNode(fragment)
      if(last){range.setStartAfter(last);range.collapse(true);selection.removeAllRanges();selection.addRange(range)}
    }
    save();updateMenu()
  })
  post.addEventListener('click',()=>{
    if(!editor.textContent.trim())return
    const content=[]
    function serialize(node){
      if(node.nodeType===Node.TEXT_NODE){if(node.textContent)content.push({type:'text',text:node.textContent});return}
      const user=candidates.find(candidate=>candidate.accountId===node.dataset?.accountId)
      if(user){content.push({type:'mention',attrs:{id:user.accountId,text:'@'+user.name}});return}
      if(node.nodeName==='BR'){content.push({type:'hardBreak'});return}
      if(['DIV','P'].includes(node.nodeName)&&content.length)content.push({type:'hardBreak'})
      node.childNodes.forEach(serialize)
    }
    editor.childNodes.forEach(serialize)
    window.lastMockReply={issueKey:issue,body:{type:'doc',version:1,content:[{type:'paragraph',content}]}}
    const recipients=new Set(content.filter(node=>node.type==='mention').map(node=>node.attrs.id))
    items.forEach((item,index)=>{if(item.key===issue&&recipients.has(item.authorId))localActions.set(index,{kind:'answered'})})
    replyDrafts.delete(issue)
    render()
  })
  save()
}
function safeUrl(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:''}catch{return ''}
}
function adf(node){
  if(!node)return ''
  if(typeof node==='string')return escapeHtml(node)
  const children=()=> (node.content||[]).map(adf).join('')
  if(node.type==='text'){
    let text=escapeHtml(node.text||'')
    for(const mark of node.marks||[]){
      if(mark.type==='strong')text='<strong>'+text+'</strong>'
      if(mark.type==='em')text='<em>'+text+'</em>'
      if(mark.type==='code')text='<code>'+text+'</code>'
      if(mark.type==='strike')text='<s>'+text+'</s>'
      if(mark.type==='link'){const href=safeUrl(mark.attrs?.href);if(href)text='<a href="'+escapeHtml(href)+'" target="_blank" rel="noopener noreferrer">'+text+'</a>'}
    }
    return text
  }
  if(node.type==='mention'){
    const known=[...userSets.values()].flat().find(user=>user.accountId===node.attrs?.id)
    return '<span class="inline-mention">'+escapeHtml(node.attrs?.text||(known?'@'+known.name:'@User'))+'</span>'
  }
  if(node.type==='hardBreak')return '<br>'
  if(node.type==='rule')return '<hr>'
  if(node.type==='inlineCard'||node.type==='blockCard'){
    const href=safeUrl(node.attrs?.url)
    return href?'<a href="'+escapeHtml(href)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(href)+'</a>':''
  }
  if(node.type==='media'||node.type==='mediaInline')return '<span class="media-placeholder">Attachment</span>'
  const tags={paragraph:'p',bulletList:'ul',orderedList:'ol',listItem:'li',blockquote:'blockquote',codeBlock:'pre',table:'table',tableRow:'tr',tableCell:'td',tableHeader:'th',heading:'h4'}
  const tag=tags[node.type]
  return tag?'<'+tag+'>'+children()+'</'+tag+'>':children()
}
function historyComment(comment){
  const name=comment.author?.displayName||'Unavailable user'
  return `<article class="history-comment"><div class="history-comment-head"><strong>${escapeHtml(name)}</strong><time>${escapeHtml(dateLabel(comment.created))}</time></div><div class="adf-content">${adf(comment.body)}</div></article>`
}
function preview(){
  const available=visibleItems()
  if(!available.length)return '<div class="preview"><h2>No comments</h2></div>'
  if(!available.some(({index})=>index===selected))selected=available[0].index
  const x=items[selected]
  const ticket=realTickets.get(x.key)
  const f=ticket.fields
  const action=localActions.get(selected)
  const at=ticket.comments.findIndex(comment=>comment.id===x.commentId)
  const earlier=ticket.comments.slice(0,at)
  const later=ticket.comments.slice(at+1)
  const attachments=f.attachment||[]
  const created=escapeHtml(dateLabel(f.created))
  const updated=escapeHtml(dateLabel(f.updated))
  return `<div class="preview live-preview" id="preview"><div class="preview-header"><div><div class="eyebrow">${x.project} / ${x.key}</div><h2>${x.title}</h2></div><a class="control open-issue" href="${escapeHtml(live.baseUrl+'/browse/'+encodeURIComponent(x.key))}" target="_blank" rel="noopener noreferrer">Open issue &#8599;</a></div>
    <div class="ticket-badges"><span class="ticket-status" data-category="${escapeHtml(f.status?.statusCategory?.key||'')}">${escapeHtml(f.status?.name||'Unknown')}</span>${f.issuetype?`<span class="ticket-type">${escapeHtml(f.issuetype.name)}</span>`:''}${f.priority?`<span class="ticket-priority">${escapeHtml(f.priority.name)}</span>`:''}<span class="ticket-person"><span class="sub">Assignee</span> ${escapeHtml(f.assignee?.displayName||'Unassigned')}</span></div>
    <div class="ticket-facts"><span>Reporter <strong>${escapeHtml(f.reporter?.displayName||'Unavailable')}</strong></span>${f.parent?`<span>Parent <strong>${escapeHtml(f.parent.key)}</strong></span>`:''}${f.duedate?`<span>Due <strong>${escapeHtml(f.duedate)}</strong></span>`:''}<span>Updated <strong>${updated}</strong></span></div>
    ${f.description?`<details class="ticket-description" open><summary>Description</summary><div class="adf-content description-content dark-scrollbar" style="height:${descriptionHeights.get(x.key)||160}px">${adf(f.description)}</div><div class="description-resize" data-description-resize role="separator" aria-label="Resize description" aria-orientation="horizontal" aria-valuemin="80" aria-valuenow="${descriptionHeights.get(x.key)||160}" tabindex="0"></div></details>`:''}
    ${attachments.length?`<details class="ticket-attachments"><summary>Attachments <span>${attachments.length}</span></summary><div class="ticket-extras">${attachments.map(attachment=>{const href=safeUrl(attachment.content);return href?`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="attachment-link">${escapeHtml(attachment.filename)} <span class="sub">${Math.ceil((attachment.size||0)/1024)} KB</span></a>`:''}).join('')}</div></details>`:''}
    <section class="conversation-card" aria-label="Comment and reply">${earlier.length?`<details class="thread-context"><summary>Earlier comments <span>${earlier.length}</span></summary><div class="thread-history dark-scrollbar">${earlier.map(historyComment).join('')}</div></details>`:''}<div class="quote"><div class="author"><span class="avatar">${x.initials}</span><strong>${x.from}</strong><span class="preview-meta">${x.date}</span><span class="spacer"></span>${commentActions(action)}</div><div class="adf-content selected-comment">${adf(x.body)}</div></div>${later.length?`<details class="thread-context later"><summary>Later comments <span>${later.length}</span></summary><div class="thread-history dark-scrollbar">${later.map(historyComment).join('')}</div></details>`:''}${replyComposer(x)}</section><div class="ticket-created">Created ${created}</div></div>`
}
function render(){
  const available=visibleItems()
  if(available.length&&!available.some(({index})=>index===selected))selected=available[0].index
  const root=document.getElementById('root')
  let main
  if(variant==='tab') main=`<div class="main">${sidebar()}${activeView==='jira'?`<div class="board">${list()}${preview()}</div>`:terminal()}</div>`
  root.innerHTML=`<div class="app">${chrome()}${main}</div>${settings}`
  bind()
}
function bind(){
  bindReplyEditor()
  const resizeHandle=document.querySelector('[data-description-resize]')
  if(resizeHandle){
    const description=document.querySelector('.description-content')
    const issue=items[selected].key
    let drag=null
    function setHeight(height){
      const next=Math.max(80,Math.round(height))
      description.style.height=next+'px'
      descriptionHeights.set(issue,next)
      resizeHandle.setAttribute('aria-valuenow',String(next))
    }
    resizeHandle.addEventListener('pointerdown',event=>{
      if(event.button!==0)return
      event.preventDefault()
      drag={y:event.clientY,height:description.getBoundingClientRect().height,userSelect:document.body.style.userSelect}
      document.body.style.userSelect='none'
      resizeHandle.setPointerCapture(event.pointerId)
      resizeHandle.classList.add('dragging')
    })
    resizeHandle.addEventListener('pointermove',event=>{if(drag)setHeight(drag.height+event.clientY-drag.y)})
    function finish(){
      if(!drag)return
      document.body.style.userSelect=drag.userSelect
      drag=null
      resizeHandle.classList.remove('dragging')
    }
    resizeHandle.addEventListener('pointerup',finish)
    resizeHandle.addEventListener('pointercancel',finish)
    resizeHandle.addEventListener('lostpointercapture',finish)
    resizeHandle.addEventListener('keydown',event=>{
      if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return
      event.preventDefault()
      setHeight(description.getBoundingClientRect().height+(event.key==='ArrowDown'?1:-1)*(event.shiftKey?48:16))
    })
  }
  document.getElementById('poll-enabled')?.addEventListener('change',event=>{document.getElementById('poll-minutes').disabled=!event.target.checked})
  document.getElementById('inbox-filter')?.addEventListener('change',event=>{inboxFilter=event.target.value;render()})
  document.querySelector('[data-dismiss]')?.addEventListener('click',()=>{localActions.set(selected,{kind:'dismissed'});render()})
  document.querySelector('[data-restore]')?.addEventListener('click',()=>{localActions.delete(selected);render()})
  document.getElementById('snooze')?.addEventListener('change',event=>{
    if(!event.target.value)return
    let until=new Date()
    if(event.target.value==='monday'){
      until.setDate(until.getDate()+((8-until.getDay())%7 || 7))
      until.setHours(9,0,0,0)
    }else until=new Date(Date.now()+(event.target.value==='2h'?2:24)*60*60*1000)
    localActions.set(selected,{kind:'snoozed',until:until.toISOString()})
    render()
  })
  document.querySelectorAll('[data-sidebar-entry]').forEach(entry => {
    entry.addEventListener('dragstart', event => {
      event.dataTransfer.setData('text/plain', entry.dataset.sidebarEntry)
      event.dataTransfer.effectAllowed = 'move'
    })
    entry.addEventListener('dragover', event => {
      event.preventDefault()
      const after = event.clientY > entry.getBoundingClientRect().top + entry.offsetHeight / 2
      entry.classList.toggle('drop-before', !after)
      entry.classList.toggle('drop-after', after)
      event.dataTransfer.dropEffect = 'move'
    })
    entry.addEventListener('dragleave', () => entry.classList.remove('drop-before', 'drop-after'))
    entry.addEventListener('drop', event => {
      event.preventDefault()
      const source = event.dataTransfer.getData('text/plain')
      const target = entry.dataset.sidebarEntry
      const after = event.clientY > entry.getBoundingClientRect().top + entry.offsetHeight / 2
      if (source !== target && sidebarOrder.includes(source)) {
        sidebarOrder = sidebarOrder.filter(id => id !== source)
        sidebarOrder.splice(sidebarOrder.indexOf(target) + (after ? 1 : 0), 0, source)
      }
      render()
    })
    entry.addEventListener('dragend', () => document.querySelectorAll('.sidebar-entry').forEach(row => row.classList.remove('drop-before', 'drop-after')))
  })
  document.querySelectorAll('[data-feature-toggle]').forEach(el=>el.addEventListener('click',()=>{featureOpen=!featureOpen;render()}))
  document.querySelectorAll('[data-jira-view]').forEach(el=>el.addEventListener('click',()=>{activeView='jira';render()}))
  document.querySelectorAll('[data-project]').forEach(el=>el.addEventListener('click',()=>{activeView='project';activeProject=el.dataset.project;render()}))
  document.querySelectorAll('[data-item]').forEach(el=>el.addEventListener('click',()=>{selected=Number(el.dataset.item);render()}))
  document.querySelectorAll('[data-settings]').forEach(el=>el.addEventListener('click',()=>document.getElementById('settings').classList.add('open')))
  document.querySelectorAll('[data-close-settings]').forEach(el=>el.addEventListener('click',()=>document.getElementById('settings').classList.remove('open')))
  document.getElementById('settings').addEventListener('click',e=>{if(e.target.id==='settings')e.currentTarget.classList.remove('open')})
  document.querySelectorAll('[data-refresh]').forEach(el=>el.addEventListener('click',()=>{const c=document.getElementById('checked');if(c)c.textContent=dateLabel(live.fetchedAt);el.textContent='✓';setTimeout(()=>{el.textContent='↻'},900)}))
  document.querySelectorAll('[data-open-issue]').forEach(el=>el.addEventListener('click',()=>alert('Prototype only: this would open '+items[selected].key+' in Jira.')))
  const search=document.getElementById('search');if(search)search.addEventListener('input',()=>{const q=search.value.toLowerCase();document.querySelectorAll('#items .item').forEach(el=>{const item=items[Number(el.dataset.item)];el.hidden=!`${item.key} ${item.title} ${item.from} ${item.text}`.toLowerCase().includes(q)})})
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.getElementById('settings')?.classList.remove('open')})
render()
