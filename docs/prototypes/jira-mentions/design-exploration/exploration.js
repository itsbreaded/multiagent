(function () {
  'use strict';

  // Synthetic demo values use only fields represented by the Jira Mentions data model.
  const NOW = Date.parse('2026-10-18T15:00:00-05:00');
  const stamp = function (value) { return Date.parse(value); };
  const user = function (accountId, displayName, sources) {
    return { accountId: accountId, displayName: displayName, sources: sources };
  };
  const users = {
    mina: user('demo-mina', 'Mina Patel', ['comment_author', 'reporter']),
    priya: user('demo-priya', 'Priya Shah', ['assignee', 'comment_author']),
    alex: user('demo-alex', 'Alex Kim', ['comment_author']),
    sam: user('demo-sam', 'Sam Rivera', ['comment_author']),
    jo: user('demo-jo', 'Jo Laurent', ['comment_author']),
    lee: user('demo-lee', 'Lee Morgan', ['comment_author']),
  };
  const paragraph = function (text) {
    return { type: 'paragraph', content: [{ type: 'text', text: text }] };
  };
  const mentionParagraph = function (before, after) {
    return { type: 'paragraph', content: [
      { type: 'text', text: before },
      { type: 'mention', attrs: { id: 'demo-current-user', text: '@you' } },
      { type: 'text', text: after },
    ] };
  };
  const doc = function (content) { return { type: 'doc', version: 1, content: content }; };
  const makeIssue = function (data) {
    return {
      issueId: data.issueId,
      issueKey: data.issueKey,
      summary: data.summary,
      projectId: data.projectId,
      projectKey: data.projectKey,
      projectName: data.projectName,
      statusId: data.statusId,
      statusName: data.statusName,
      statusCategory: data.statusCategory,
      issueType: data.issueType,
      priority: data.priority,
      assignee: data.assignee,
      reporter: data.reporter,
      creator: data.creator,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      dueDate: data.dueDate,
      resolution: data.resolution,
      description: data.description,
      attachments: data.attachments,
      parent: data.parent,
      subtasks: data.subtasks,
      issueLinks: data.issueLinks,
    };
  };
  const imageAttachment = function (id, name, author, createdAt, size) {
    return {
      id: id,
      name: name,
      contentUrl: null,
      mimeType: 'image/png',
      size: size,
      author: author,
      createdAt: createdAt,
    };
  };
  const attachmentOne = imageAttachment('demo-attach-1', 'timeout-dialog.png', users.mina, stamp('2026-10-18T12:37:00-05:00'), 184320);
  const attachmentTwo = imageAttachment('demo-attach-2', 'service-log.png', users.mina, stamp('2026-10-18T12:38:00-05:00'), 248832);

  const webIssue = makeIssue({
    issueId: 'demo-issue-2081', issueKey: 'WEB-2081',
    summary: 'Database timeout appears during account report generation',
    projectId: 'demo-project-web', projectKey: 'WEB', projectName: 'Web Experience',
    statusId: 'demo-status-progress', statusName: 'In Progress', statusCategory: 'In Progress',
    issueType: 'Bug', priority: 'High', assignee: users.priya, reporter: users.mina, creator: users.mina,
    createdAt: stamp('2026-10-17T08:20:00-05:00'), updatedAt: stamp('2026-10-18T14:34:00-05:00'),
    dueDate: null, resolution: null,
    description: doc([
      paragraph('The account report intermittently fails after the query runs for about thirty seconds.'),
      paragraph('The attached screenshots show the timeout message and the corresponding service log. The failure is reproducible for larger customer accounts.'),
    ]),
    attachments: [attachmentOne, attachmentTwo], parent: null, subtasks: [], issueLinks: [],
  });
  const opsIssue = makeIssue({
    issueId: 'demo-issue-914', issueKey: 'OPS-914', summary: 'Rotate the staging database connection pool safely',
    projectId: 'demo-project-ops', projectKey: 'OPS', projectName: 'Operations',
    statusId: 'demo-status-new', statusName: 'To Do', statusCategory: 'To Do',
    issueType: 'Task', priority: 'Medium', assignee: users.alex, reporter: users.sam, creator: users.sam,
    createdAt: stamp('2026-10-16T10:00:00-05:00'), updatedAt: stamp('2026-10-18T11:18:00-05:00'),
    dueDate: null, resolution: null,
    description: doc([paragraph('Confirm the connection pool settings before the staging database maintenance window.')]),
    attachments: [], parent: null, subtasks: [], issueLinks: [],
  });
  const dataIssue = makeIssue({
    issueId: 'demo-issue-336', issueKey: 'DATA-336', summary: 'Document missing fields in the nightly export',
    projectId: 'demo-project-data', projectKey: 'DATA', projectName: 'Data Services',
    statusId: 'demo-status-progress-2', statusName: 'In Progress', statusCategory: 'In Progress',
    issueType: 'Story', priority: 'Low', assignee: users.jo, reporter: users.lee, creator: users.lee,
    createdAt: stamp('2026-10-15T09:30:00-05:00'), updatedAt: stamp('2026-10-18T09:07:00-05:00'),
    dueDate: null, resolution: null,
    description: doc([paragraph('Record which optional fields are omitted from the nightly export and why.')]),
    attachments: [], parent: null, subtasks: [], issueLinks: [],
  });
  const coreIssue = makeIssue({
    issueId: 'demo-issue-52', issueKey: 'CORE-52', summary: 'Clarify the retry behavior for failed webhook deliveries',
    projectId: 'demo-project-core', projectKey: 'CORE', projectName: 'Core Platform',
    statusId: 'demo-status-new-2', statusName: 'To Do', statusCategory: 'To Do',
    issueType: 'Task', priority: 'Medium', assignee: users.sam, reporter: users.alex, creator: users.alex,
    createdAt: stamp('2026-10-14T13:05:00-05:00'), updatedAt: stamp('2026-10-18T08:21:00-05:00'),
    dueDate: null, resolution: null,
    description: doc([paragraph('Describe when delivery retries stop and what information is available to the caller.')]),
    attachments: [], parent: null, subtasks: [], issueLinks: [],
  });

  const makeComment = function (issueId, commentId, author, createdAt, bodyContent, excerpt) {
    const time = stamp(createdAt);
    return {
      commentId: commentId,
      issueId: issueId,
      authorAccountId: author.accountId,
      authorDisplayName: author.displayName,
      createdAt: time,
      updatedAt: time,
      body: doc(bodyContent),
      excerpt: excerpt,
      visibility: null,
      availability: 'visible',
    };
  };
  const sourceA = makeComment(webIssue.issueId, 'demo-comment-web-4', users.mina, '2026-10-18T12:40:00-05:00', [
    mentionParagraph('The larger accounts still hit this timeout. ', ' Could you check whether the report query needs a narrower date range?'),
    { type: 'mediaSingle', content: [
      { type: 'media', attrs: { id: attachmentOne.id, type: 'file', alt: attachmentOne.name } },
      { type: 'media', attrs: { id: attachmentTwo.id, type: 'file', alt: attachmentTwo.name } },
    ] },
  ], 'The larger accounts still hit this timeout. @you Could you check whether the report query needs a narrower date range?');
  const sourceB = makeComment(webIssue.issueId, 'demo-comment-web-2', users.alex, '2026-10-17T16:32:00-05:00', [
    mentionParagraph('I can reproduce this on staging. ', ' Can you review the query plan when you have a moment?'),
  ], 'I can reproduce this on staging. @you Can you review the query plan when you have a moment?');
  const commentsWeb = [
    makeComment(webIssue.issueId, 'demo-comment-web-6', users.priya, '2026-10-18T14:34:00-05:00', [paragraph('I added the query timing from the latest run. The timeout happens only for the largest account range.')], 'I added the query timing from the latest run. The timeout happens only for the largest account range.'),
    makeComment(webIssue.issueId, 'demo-comment-web-5', users.alex, '2026-10-18T13:06:00-05:00', [paragraph('I can reproduce it with the same date range. I will compare the query plan with the smaller account.')], 'I can reproduce it with the same date range. I will compare the query plan with the smaller account.'),
    sourceA,
    makeComment(webIssue.issueId, 'demo-comment-web-3', users.priya, '2026-10-18T09:11:00-05:00', [paragraph('The first pass points to the report query. I am checking whether the connection pool is also contributing.')], 'The first pass points to the report query. I am checking whether the connection pool is also contributing.'),
    sourceB,
    makeComment(webIssue.issueId, 'demo-comment-web-1', users.mina, '2026-10-17T10:05:00-05:00', [paragraph('The report completes for smaller accounts, but the larger ones fail after about thirty seconds.')], 'The report completes for smaller accounts, but the larger ones fail after about thirty seconds.'),
  ].sort(function (a, b) { return b.createdAt - a.createdAt; });
  const sourceOps = makeComment(opsIssue.issueId, 'demo-comment-ops-1', users.sam, '2026-10-18T11:18:00-05:00', [
    mentionParagraph('Before the maintenance window, ', ' can you check if this pool size is safe for the export workers too?'),
  ], 'Before the maintenance window, @you can you check if this pool size is safe for the export workers too?');
  const sourceData = makeComment(dataIssue.issueId, 'demo-comment-data-1', users.lee, '2026-10-18T09:07:00-05:00', [
    mentionParagraph('The export sample is ready. ', ' could you confirm which missing values should be documented as optional?'),
  ], 'The export sample is ready. @you could you confirm which missing values should be documented as optional?');
  const sourceCore = makeComment(coreIssue.issueId, 'demo-comment-core-1', users.alex, '2026-10-18T08:21:00-05:00', [
    mentionParagraph('I found two retry paths in the worker. ', ' can you confirm which one the caller should expect?'),
  ], 'I found two retry paths in the worker. @you can you confirm which one the caller should expect?');
  const snapshots = new Map([
    [webIssue.issueId, { issue: webIssue, comments: commentsWeb, users: Object.values(users), observedCommentCount: commentsWeb.length, commentsComplete: true, updatedMarker: null }],
    [opsIssue.issueId, { issue: opsIssue, comments: [sourceOps], users: Object.values(users), observedCommentCount: 1, commentsComplete: true, updatedMarker: null }],
    [dataIssue.issueId, { issue: dataIssue, comments: [sourceData], users: Object.values(users), observedCommentCount: 1, commentsComplete: true, updatedMarker: null }],
    [coreIssue.issueId, { issue: coreIssue, comments: [sourceCore], users: Object.values(users), observedCommentCount: 1, commentsComplete: true, updatedMarker: null }],
  ]);

  const stateFor = function (issue, comment) {
    return {
      issueId: issue.issueId,
      incomingCommentId: comment.commentId,
      authorAccountId: comment.authorAccountId,
      sourceCreatedAt: comment.createdAt,
      sourceUpdatedAt: comment.updatedAt,
      sourceHash: 'illustrative-hash-' + comment.commentId,
      firstObservedAt: NOW,
      eligibleEditAt: null,
      eligibility: 'new',
      state: 'unanswered',
      resolvingCommentId: null,
      resolvingCreatedAt: null,
      ruleVersion: 1,
      computedAt: NOW,
    };
  };
  const mentionItem = function (issue, comment, authors) {
    return { issue: issue, comment: comment, state: stateFor(issue, comment), action: null, authors: authors };
  };
  const projection = {
    enabled: true,
    identityVerified: true,
    status: 'ready',
    errorCode: null,
    activeCount: 5,
    lastAttemptAt: NOW,
    lastSuccessAt: NOW,
    historyFrom: stamp('2026-10-11T00:00:00-05:00'),
    coverageThrough: NOW,
    cached: false,
    items: [
      mentionItem(webIssue, sourceA, [users.mina, users.priya, users.alex]),
      mentionItem(webIssue, sourceB, [users.mina, users.priya, users.alex]),
      mentionItem(opsIssue, sourceOps, [users.sam, users.alex]),
      mentionItem(dataIssue, sourceData, [users.lee, users.jo]),
      mentionItem(coreIssue, sourceCore, [users.alex, users.sam]),
    ],
  };

  const escapeHtml = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  };
  const formatTime = function (value) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value);
  };
  const formatLongTime = function (value) {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  };
  const initials = function (value) {
    return String(value || '?').split(/\s+/).map(function (part) { return part.charAt(0); }).join('').slice(0, 2).toUpperCase();
  };
  const renderAdf = function (value, attachments) {
    if (Array.isArray(value)) return value.map(function (child) { return renderAdf(child, attachments); }).join('');
    if (!value || typeof value !== 'object') return '';
    if (value.type === 'text') return escapeHtml(value.text || '');
    if (value.type === 'mention') {
      const attrs = value.attrs || {};
      return '<mark>' + escapeHtml(attrs.text || '@user') + '</mark>';
    }
    if (value.type === 'hardBreak') return '<br>';
    if (value.type === 'media' || value.type === 'mediaInline') {
      const attrs = value.attrs || {};
      const attachment = Array.isArray(attachments) ? attachments.find(function (item) { return item.id === String(attrs.id || ''); }) : null;
      if (!attachment || !(attachment.mimeType || '').toLowerCase().startsWith('image/')) return '';
      return '<figure class="comment-inline-image"><span class="comment-inline-image-preview"><span class="preview-shape" aria-hidden="true"></span><small>Inline image preview</small></span><figcaption>' + escapeHtml(attrs.alt || attachment.name) + '</figcaption></figure>';
    }
    const content = Array.isArray(value.content) ? value.content.map(function (child) { return renderAdf(child, attachments); }).join('') : '';
    if (value.type === 'paragraph') return '<p>' + content + '</p>';
    if (value.type === 'heading') return '<p><strong>' + content + '</strong></p>';
    if (value.type === 'bulletList') return '<ul>' + content + '</ul>';
    if (value.type === 'orderedList') return '<ol>' + content + '</ol>';
    if (value.type === 'listItem') return '<li>' + content + '</li>';
    if (value.type === 'blockquote') return '<blockquote>' + content + '</blockquote>';
    return content;
  };
  const issueGroups = function (items) {
    const byId = new Map();
    items.forEach(function (item) {
      const entries = byId.get(item.issue.issueId) || [];
      entries.push(item);
      byId.set(item.issue.issueId, entries);
    });
    return Array.from(byId.values()).map(function (itemsInGroup) { return { issue: itemsInGroup[0].issue, items: itemsInGroup }; });
  };
  const selectedInitially = { issueId: webIssue.issueId, commentId: sourceA.commentId };
  const renderCommentRow = function (item, selected) {
    const source = item.comment.commentId === selected.commentId && item.issue.issueId === selected.issueId;
    const mark = source ? '<span class="source-tag">Mention</span>' : '';
    return '<button type="button" class="mention-row' + (source ? ' selected' : '') + '" data-issue-id="' + escapeHtml(item.issue.issueId) + '" data-comment-id="' + escapeHtml(item.comment.commentId) + '">' +
      '<span class="mention-mark" aria-hidden="true">@</span><span class="mention-copy"><span class="mention-row-head"><strong>' + escapeHtml(item.comment.authorDisplayName || 'Unknown author') + '</strong><time>' + formatTime(item.comment.createdAt) + '</time></span>' +
      '<span class="mention-title">' + escapeHtml(item.issue.summary) + '</span><span class="mention-excerpt">' + escapeHtml(item.comment.excerpt) + '</span></span>' + mark + '</button>';
  };
  const renderInbox = function (selected, filterValue, query) {
    const lowered = query.trim().toLowerCase();
    let items = projection.items.slice();
    if (filterValue !== 'all') {
      items = items.filter(function (item) {
        if (filterValue === 'active') return item.state.state === 'unanswered' && item.action === null;
        if (filterValue === 'snoozed') return item.action && item.action.disposition === 'snoozed';
        if (filterValue === 'dismissed') return item.action && item.action.disposition === 'dismissed';
        if (filterValue === 'answered') return item.state.state === 'answered';
        return true;
      });
    }
    if (lowered) {
      items = items.filter(function (item) {
        return (item.issue.issueKey + ' ' + item.issue.summary + ' ' + item.comment.excerpt + ' ' + (item.comment.authorDisplayName || '')).toLowerCase().includes(lowered);
      });
    }
    const groups = issueGroups(items);
    const rows = groups.map(function (group) {
      return '<section class="mention-group"><div class="group-heading"><div><a href="#" data-mock-link="true">' + escapeHtml(group.issue.issueKey) + '</a><span>' + group.items.length + (group.items.length === 1 ? ' mention' : ' mentions') + '</span></div><p>' + escapeHtml(group.issue.summary) + '</p></div>' +
        group.items.map(function (item) { return renderCommentRow(item, selected); }).join('') + '</section>';
    }).join('');
    return '<aside class="inbox"><div class="inbox-head"><div class="eyebrow">MENTION INBOX</div><h1>Needs your reply <b>' + items.length + '</b></h1><span class="checked"><i></i>Checked ' + formatLongTime(projection.lastSuccessAt) + '</span></div>' +
      '<div class="inbox-controls"><label class="search-field"><span class="search-icon" aria-hidden="true"></span><input id="mention-search" type="search" placeholder="Search mentions" value="' + escapeHtml(query) + '"></label>' +
      '<select id="mention-filter" aria-label="Filter mentions"><option value="all"' + (filterValue === 'all' ? ' selected' : '') + '>All</option><option value="active"' + (filterValue === 'active' ? ' selected' : '') + '>Active</option><option value="snoozed"' + (filterValue === 'snoozed' ? ' selected' : '') + '>Snoozed</option><option value="dismissed"' + (filterValue === 'dismissed' ? ' selected' : '') + '>Dismissed</option><option value="answered"' + (filterValue === 'answered' ? ' selected' : '') + '>Answered</option></select>' +
      '<button class="control-button refresh-button" type="button" aria-label="Refresh mentions" title="Preview control">↻</button></div>' +
      '<div class="inbox-list"><div class="inbox-list-label">MENTIONS <span>' + items.length + ' shown</span></div>' + (rows || '<div class="empty-inbox">No mentions match this filter.</div>') + '</div>' +
      '<div class="inbox-footer">Showing sample coverage from ' + new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(projection.historyFrom) + '</div></aside>';
  };
  const property = function (label, value, kind) {
    if (value == null || value === '') return '';
    const content = kind === 'status' ? '<span class="property-badge status"><i></i>' + escapeHtml(value) + '</span>'
      : kind === 'type' ? '<span class="property-badge type">' + escapeHtml(value) + '</span>'
        : kind === 'priority' ? '<span class="property-badge priority">' + escapeHtml(value) + '</span>'
          : '<strong>' + escapeHtml(value) + '</strong>';
    return '<div class="fact"><span>' + escapeHtml(label) + '</span>' + content + '</div>';
  };
  const renderFacts = function (issue) {
    const assignee = issue.assignee && issue.assignee.displayName
      ? '<span class="fact-person"><i class="avatar tone-' + initials(issue.assignee.displayName).toLowerCase() + '">' + initials(issue.assignee.displayName) + '</i><strong>' + escapeHtml(issue.assignee.displayName) + '</strong></span>' : null;
    const facts = [
      property('Status', issue.statusName, 'status'),
      property('Type', issue.issueType, 'type'),
      property('Priority', issue.priority, 'priority'),
      assignee ? '<div class="fact"><span>Assignee</span>' + assignee + '</div>' : '',
      property('Reporter', issue.reporter && issue.reporter.displayName, null),
      property('Parent', issue.parent && issue.parent.issueKey, null),
      property('Due', issue.dueDate, null),
      issue.updatedAt == null ? '' : property('Updated', formatLongTime(issue.updatedAt), null),
    ].filter(Boolean).join('');
    return '<aside class="ticket-facts"><div class="facts-kicker">TICKET DETAILS</div>' + facts + '</aside>';
  };
  const renderIssueHeader = function (issue) {
    return '<header class="issue-header"><div class="issue-keyline"><span>' + escapeHtml(issue.projectName || issue.projectKey || 'Project') + '</span><span>›</span><a href="#" data-mock-link="true">' + escapeHtml(issue.issueKey) + '</a></div>' +
      '<div class="issue-title-row"><h2>' + escapeHtml(issue.summary) + '</h2></div></header>';
  };
  const renderDescription = function (issue) {
    const body = issue.description ? renderAdf(issue.description) : '<p>No description was provided.</p>';
    return '<section class="content-section description-section"><div class="section-heading"><h3>Description</h3><button class="section-action" type="button" data-toggle-description>Collapse</button></div><div class="description-copy">' + body + '</div></section>';
  };
  const prettySize = function (size) {
    if (size == null) return '';
    return size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + ' MB' : Math.round(size / 1024) + ' KB';
  };
  const formatAttachmentDate = function (value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value);
  };
  const renderAttachment = function (attachment) {
    const image = (attachment.mimeType || '').toLowerCase().startsWith('image/');
    const extension = attachment.name.includes('.') ? attachment.name.split('.').pop().toUpperCase() : 'FILE';
    const thumbnail = image
      ? '<div class="attachment-preview"><span class="preview-shape" aria-hidden="true"></span><small>' + escapeHtml(extension) + '</small></div>'
      : '<div class="attachment-preview file-preview"><b>' + escapeHtml(extension) + '</b></div>';
    const metadata = [formatAttachmentDate(attachment.createdAt), prettySize(attachment.size)].filter(Boolean).join(' · ');
    return '<article class="attachment">' + thumbnail + '<div class="attachment-info"><strong>' + escapeHtml(attachment.name) + '</strong><small>' + escapeHtml(metadata || 'Date unavailable') + '</small></div></article>';
  };
  const renderAttachments = function (issue, expanded) {
    const imageAttachments = issue.attachments.filter(function (attachment) {
      return (attachment.mimeType || '').toLowerCase().startsWith('image/') || Boolean(attachment.contentUrl);
    }).sort(function (a, b) {
      const aCreated = typeof a.createdAt === 'number' ? a.createdAt : Number.NEGATIVE_INFINITY;
      const bCreated = typeof b.createdAt === 'number' ? b.createdAt : Number.NEGATIVE_INFINITY;
      return bCreated - aCreated || a.id.localeCompare(b.id);
    });
    const count = imageAttachments.length;
    const list = expanded ? '<div class="attachment-list">' + imageAttachments.map(renderAttachment).join('') + '</div>' : '';
    const button = count ? '<button class="section-action" type="button" data-toggle-attachments>' + (expanded ? 'Hide attachments' : 'Show attachments') + '</button>' : '';
    return '<section class="content-section attachment-section"><div class="section-heading"><h3>Attachments <span class="section-count">' + count + '</span></h3>' + button + '</div>' + list + '</section>';
  };
  const renderReply = function () {
    return '<section class="reply-section"><div class="reply-heading"><div><span class="reply-mark" aria-hidden="true">↩</span><h3>Reply to mention</h3></div></div>' +
      '<textarea aria-label="Write a reply" placeholder="Write a reply…"></textarea><div class="reply-footer"><button type="button">Post reply</button></div></section>';
  };
  const renderComment = function (comment, issue, selectedCommentId) {
    const isSource = comment.commentId === selectedCommentId;
    const author = comment.authorDisplayName || 'Unknown author';
    const avatarTone = initials(author).toLowerCase();
    const actionButtons = isSource ? '<span class="source-actions"><button type="button">Snooze</button><button type="button">Dismiss</button></span>' : '';
    const body = comment.availability === 'visible' ? renderAdf(comment.body, issue.attachments) : '<p class="unavailable-copy">This comment is no longer available.</p>';
    return '<article class="comment' + (isSource ? ' source-comment' : '') + '"><span class="avatar tone-' + escapeHtml(avatarTone) + '" aria-hidden="true">' + initials(author) + '</span><div class="comment-copy"><div class="comment-head"><strong>' + escapeHtml(author) + '</strong><time>' + formatLongTime(comment.createdAt) + '</time>' + (isSource ? '<span class="source-tag">Mention</span>' : '') + actionButtons + '</div><div class="comment-body">' + body + '</div></div></article>';
  };
  const renderConversation = function (snapshot, selected) {
    const comments = snapshot.comments.slice().sort(function (a, b) { return b.createdAt - a.createdAt || b.updatedAt - a.updatedAt; });
    return '<section class="conversation-section"><div class="conversation-heading"><div><h3>Comments</h3><span class="section-count">' + snapshot.observedCommentCount + '</span></div><span>Newest first</span></div><div class="comment-list">' + comments.map(function (comment) { return renderComment(comment, snapshot.issue, selected.commentId); }).join('') + '</div><div class="history-end">' + (snapshot.commentsComplete ? 'End of available comments' : 'Older comments were not included in the available history') + '</div></section>';
  };
  const renderTicket = function (selected, expanded) {
    const item = projection.items.find(function (candidate) { return candidate.issue.issueId === selected.issueId && candidate.comment.commentId === selected.commentId; }) || projection.items[0];
    const issue = item.issue;
    const snapshot = snapshots.get(issue.issueId) || { issue: issue, comments: [item.comment], observedCommentCount: 1, commentsComplete: true };
    const chosen = { issueId: issue.issueId, commentId: item.comment.commentId };
    return '<main class="ticket-area"><div class="ticket-layout">' + renderIssueHeader(issue) + '<div class="ticket-primary">' + renderDescription(issue) + renderAttachments(issue, expanded) + renderReply() + renderConversation(snapshot, chosen) + '</div>' + renderFacts(issue) + '</div></main>';
  };

  let selected = selectedInitially;
  let filterValue = 'active';
  let query = '';
  let attachmentsExpanded = false;
  let descriptionCollapsed = false;

  const render = function () {
    document.title = 'Jira mentions — ticket details rail';
    document.getElementById('app').innerHTML = '<header class="preview-bar"><a class="back-link" href="index.html" aria-label="Back to mockup index">‹</a><div class="preview-title"><strong>JIRA MENTIONS</strong><span>Ticket details rail</span><small>Focused ticket context with the reply in reach</small></div><span class="preview-label">STATIC MOCKUP</span></header>' +
      '<div class="feature-page">' + renderInbox(selected, filterValue, query) + renderTicket(selected, attachmentsExpanded) + '</div>';
    bindEvents();
  };
  const bindEvents = function () {
    document.querySelectorAll('.mention-row').forEach(function (button) {
      button.addEventListener('click', function () {
        selected = { issueId: button.dataset.issueId, commentId: button.dataset.commentId };
        attachmentsExpanded = false;
        descriptionCollapsed = false;
        render();
        window.scrollTo(0, 0);
      });
    });
    const search = document.getElementById('mention-search');
    search.addEventListener('input', function () {
      const position = search.selectionStart;
      query = search.value;
      render();
      const replacement = document.getElementById('mention-search');
      replacement.focus();
      replacement.setSelectionRange(position, position);
    });
    document.getElementById('mention-filter').addEventListener('change', function (event) {
      filterValue = event.target.value;
      render();
    });
    document.querySelectorAll('[data-mock-link="true"]').forEach(function (link) {
      link.addEventListener('click', function (event) { event.preventDefault(); });
    });
    const attachmentToggle = document.querySelector('[data-toggle-attachments]');
    if (attachmentToggle) attachmentToggle.addEventListener('click', function () {
      attachmentsExpanded = !attachmentsExpanded;
      render();
    });
    const descriptionToggle = document.querySelector('[data-toggle-description]');
    if (descriptionToggle) descriptionToggle.addEventListener('click', function () {
      descriptionCollapsed = !descriptionCollapsed;
      const copy = document.querySelector('.description-copy');
      copy.hidden = descriptionCollapsed;
      descriptionToggle.textContent = descriptionCollapsed ? 'Expand' : 'Collapse';
    });
  };

  render();
})();
