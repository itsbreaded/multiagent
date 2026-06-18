# Review Browser MCP Tool Guidance

## Status

Done.

## Outcome

Browser MCP guidance now lives in tool-facing metadata and behavior, not only in repository instructions.

Implemented changes:

- `browser_get_content` now accepts optional `selector` and `max_chars` arguments.
- Scoped `browser_get_content({ selector })` reads visible text from the matched element instead of the whole page.
- `max_chars` truncates the returned text only when explicitly requested and reports full-size metadata.
- Unscoped small `browser_get_content({})` responses remain plain text for backward compatibility.
- Unscoped large responses still return the requested text, with appended metadata and a warning to prefer narrower tools when possible.
- Tool descriptions now steer agents toward `browser_get_url`, `browser_wait_for_text`, `browser_get_elements`, `browser_get_links`, and `browser_screenshot` for narrower checks.

## Verification

- Ran `npm run typecheck`.
- Confirmed no schema change removes or renames existing arguments or tools.
- Confirmed `browser_get_content({})` remains available.

## Durable Notes

`browser_get_content` should remain a valid broad-orientation tool. Prefer additive guidance, optional scoping, metadata, and warnings over hard blocking or mandatory truncation.
