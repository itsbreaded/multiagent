---
name: link-claude-skills
description: Configure one project-local skill source for Codex and Claude Code by making `.claude/skills` point to canonical `.agents/skills`. Use when asked to share, link, alias, sync, migrate, or avoid duplicating project skills between `.agents` and `.claude` on Windows, macOS, or Linux.
---

# Link Claude Skills

Maintain project skill contents only in `.agents/skills`. Make
`.claude/skills` a local filesystem alias to that directory so Claude Code and
Codex discover the same skills without copied files.

## Scope and safety

- Work from the Git repository root. If the current directory is inside a
  repository, find the root with `git rev-parse --show-toplevel` and use that
  path for every operation.
- Treat `.agents/skills` as canonical. Never edit skills through
  `.claude/skills`; always edit their `.agents/skills` paths.
- Do not delete, overwrite, or silently move an existing real
  `.claude/skills` directory. Report the conflict and ask before migrating its
  contents or replacing it with an alias.
- Do not commit the alias. A Windows junction is not portable through Git, and
  a Unix symlink can fail on Windows clones. Keep the canonical
  `.agents/skills` files under version control and create the alias locally.

## Setup

1. Confirm `.agents/skills` exists. Create it if this is a new skill setup.
2. Inspect `.claude/skills` before changing it.
   - If it is already an alias resolving to `.agents/skills`, report success
     and validate it.
   - If it is a real directory or an alias to another target, stop and explain
     the conflict. Do not replace it without explicit user approval.
   - If it does not exist, create `.claude` and make the alias for the current
     platform.
3. Validate the alias and show the canonical skill entries found through it.
4. Tell the user to restart a running Claude Code session if this created its
   first `.claude/skills` directory. Start a new Codex session if skill
   discovery has already occurred.

## Platform commands

### Windows PowerShell

Use a directory junction. Resolve absolute paths so the target is correct even
when the command is launched from a nested directory.

```powershell
$root = git rev-parse --show-toplevel
$canonical = Join-Path $root '.agents\skills'
$claudeDir = Join-Path $root '.claude'
$link = Join-Path $claudeDir 'skills'

New-Item -ItemType Directory -Force $canonical, $claudeDir | Out-Null
New-Item -ItemType Junction -Path $link -Target $canonical | Out-Null
Get-Item $link | Select-Object FullName, LinkType, Target
Get-ChildItem $link -Directory | Select-Object -ExpandProperty Name
```

Do not run the `New-Item -ItemType Junction` command until inspection confirms
that `$link` does not already exist.

### macOS and Linux

Use a relative directory symlink. Run these commands from the repository root.

```sh
mkdir -p .agents/skills .claude
ln -s ../.agents/skills .claude/skills
readlink .claude/skills
find -L .claude/skills -mindepth 1 -maxdepth 1 -type d -print
```

Do not run `ln -s` until inspection confirms `.claude/skills` does not already
exist. `../.agents/skills` is intentionally relative to the `.claude` directory
where the symlink lives.

## Validate

- Check that every expected skill has `SKILL.md` under `.agents/skills`.
- Check the same skills are visible through `.claude/skills`.
- Confirm the alias points to the canonical path, not a copied directory.
- Run `git status --short` and make sure skill content changes are under
  `.agents/skills`; the local alias should not appear as a file tree to commit.

## Migration, only with approval

If an existing `.claude/skills` directory contains skills that are not already
under `.agents/skills`, first compare the contents and resolve naming conflicts
with the user. Move the agreed canonical copies to `.agents/skills`, verify
them there, then replace the now-empty `.claude/skills` directory with the
platform alias. Never choose a winner for conflicting `SKILL.md` files without
asking.
