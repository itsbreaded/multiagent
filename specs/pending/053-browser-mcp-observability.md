# 053 - Browser MCP Observability Tools

Status: ready
Completed:

## Problem

The browser MCP can inspect rendered DOM content, but it cannot show an agent
what the page is doing: browser console output, completed network activity, or
the cookies that determine authenticated state. Agents therefore diagnose
client-side failures from screenshots and DOM guesses, often missing the most
direct evidence.

## Intended Behavior

Add an observability-focused tool batch after spec `051`:

- Read a bounded, chronological browser-console buffer.
- Read bounded metadata for recent completed and failed main-frame, fetch, XHR,
  script, and stylesheet requests.
- Read and delete cookies for the active browser session.

These tools are diagnostic. They do not modify response bodies, intercept
traffic, alter cookies except through an explicit delete call, or introduce
Playwright as a dependency.

## Requirements

- Buffers are owned by the active browser window/session, have explicit size
  limits, clear on window close, and report truncation.
- Network results include method, URL, resource type, status/failure, and
  timing. They never include request or response bodies.
- Console results include level, message, source URL, line, and timestamp.
- Cookie reads return values because authenticated-state debugging requires the
  actual credential material. Treat values as sensitive: return them only in
  the MCP tool result, never application logs, status responses, or renderer
  UI; describe that exposure in the tool description.
- Cookie deletion requires an explicit cookie identity and reports whether the
  matching cookie was removed.
- Every new MCP tool is registered in both `BrowserMcpServer` and the
  `McpManager` built-in status list, with handler and manager tests.

## Non-Goals

- No request interception, route mocking, tracing, video, PDF generation,
  multi-tab control, storage-state import/export, or browser snapshot/ref
  model.
- No automatic retry or agent decision-making based on observed data.

## Resolved Decisions

None outstanding.

- Cookie reads include values. A redacted list would not support the primary
  debugging and authenticated-session use cases; the tool's limited output
  channel and explicit sensitive-data warning contain the exposure.

## Acceptance Scenarios

- Given the page writes to `console.error`, when the agent calls the console
  tool, then it receives the error in chronological order with source context.
- Given the page completes a fetch and one request fails, when the agent calls
  the network tool, then it receives bounded metadata for both without bodies.
- Given a cookie exists in the active browser session, when the agent lists it
  and then deletes its explicit identity, then the list includes its value,
  does not write that value to application logs/UI, and subsequent listing
  confirms the deletion.
- Given more events arrive than a buffer retains, when the agent reads it,
  then the response marks the result as truncated.
