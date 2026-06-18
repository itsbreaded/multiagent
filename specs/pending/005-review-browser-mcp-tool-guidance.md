# Review Browser MCP Tool Guidance

## Status

Pending investigation. Do not implement from this spec until the review is done and the intended changes are confirmed.

## Problem

Agents can overuse broad browser MCP tools, especially `browser_get_content({})`, because it is convenient for orientation and verification. On large pages this can return hundreds of lines of unrelated page text, including navigation menus, filters, footers, recommendations, and test strings. Repeated whole-page dumps waste context, make transcripts harder to scan, and encourage imprecise browser workflows.

The current tool list documents each primitive, but it does not make the relative cost or preferred efficient pattern obvious enough at the point where agents choose tools.

## Current Behavior

- `browser_get_content({})` returns visible text for the whole page with no scoped selector, size metadata, or warning.
- `browser_get_elements(...)`, `browser_get_links(...)`, `browser_wait_for_text(...)`, `browser_get_url()`, and `browser_wait_for(...)` can often answer narrower questions, but agents may not choose them by default.
- Tool descriptions are mostly neutral capability descriptions; they do not strongly encode cost-aware guidance.
- Agents must infer when a full-page text dump is appropriate.

## Intended Behavior

Agents should default to the narrowest browser observation that answers the question:

- Use `browser_get_url()` for URL checks.
- Use `browser_wait_for_text(...)` for simple confirmation after an action.
- Use `browser_get_elements({ selector })` for scoped text, attributes, roles, and bounding boxes.
- Use `browser_get_links({ text_filter })` before navigating links.
- Use `browser_screenshot()` only when visual layout matters.
- Reserve `browser_get_content({})` for initial orientation, broad page audits, or cases where no narrower selector is known.

The MCP tool metadata, schemas, and tool behavior should make that efficient path obvious. Agent guidance for this issue must come from the tools themselves, not from stronger operational instructions in `CLAUDE.md`.

## Investigation Scope

Review `src/main/mcp/tools/` and related MCP registration code for:

- Tool descriptions exposed to Claude and Codex.
- Whether output metadata can be added without breaking callers.
- Whether `browser_get_content` can support optional scoping or limits.
- Whether new targeted helper tools are justified.

Do not assume every improvement needs a new tool. Tool descriptions, schemas, parameter names, return metadata, and runtime warnings may be enough if they reliably steer agents.

## Candidate Improvements

- Update `browser_get_content` description to warn that it returns whole-page visible text and should be used sparingly.
- Add output metadata to `browser_get_content`, such as `characters`, `lines`, and `truncated`.
- Add optional parameters to `browser_get_content`, such as `selector`, `max_chars`, or `viewport_only`.
- Add a targeted `browser_get_text({ selector })` tool if scoped content would be cleaner than overloading `browser_get_content`.
- Update tool descriptions to explicitly prefer `browser_get_elements`, `browser_get_links`, `browser_wait_for_text`, and `browser_get_url` for common narrow tasks.
- Add runtime warning metadata when `browser_get_content({})` returns a large payload, while still returning the requested content.

## Risks

- Changing tool schemas may break existing agent prompts or MCP clients if not handled compatibly.
- Adding too many helper tools can make selection harder rather than easier.
- Overly restrictive guidance could discourage useful full-page orientation calls.
- Metadata or truncation must not hide content when the caller explicitly needs full page text.

## Verification Steps

- Confirm MCP tool descriptions exposed to both Claude and Codex include the updated guidance.
- Exercise a common workflow on a large page and verify the recommended path avoids repeated whole-page text dumps.
- Confirm `browser_get_content({})` still works for existing callers.
- If schema changes are made, run `npm run typecheck` and any MCP tool tests that exist.
- Manually inspect a transcript from an agent using the browser tools to confirm the guidance is visible and actionable.

## Handoff Contract

Non-negotiables:

- Preserve backward compatibility for existing MCP tool calls unless a migration is explicitly approved.
- Keep tool descriptions concise enough to be useful in agent context.
- Guidance for efficient browser use must be embedded in the MCP tools themselves: descriptions, schemas, parameter design, return metadata, warnings, or helper tools.
- Do not rely on stronger `CLAUDE.md` operational guidance to solve this problem.
- Prefer targeted guidance and metadata over hard blocking broad observations.
- Do not remove `browser_get_content({})`; it remains useful for initial orientation.

Definition of done:

- The investigation identifies whether documentation-only, tool-description, schema, or implementation changes are warranted.
- Approved changes are implemented and verified.
- Any durable guidance needed by agents is present in MCP tool-facing descriptions, schemas, outputs, or behavior.
- This spec is moved to `specs/done/` or deleted once it no longer carries useful pending context.
