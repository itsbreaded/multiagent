---
name: release-publish
description: Publish a new MultiAgent patch release by validating the repository, incrementing the npm patch version, committing and pushing master, and running publish.bat. Use when the user asks to release, publish, bump the patch version and push, or explicitly requests the standard MultiAgent release workflow.
---

# Release and Publish

Publish from the repository root using this exact order.

1. Inspect `git status --short`, the current branch, remotes, `package.json`, and `publish.bat`.
2. Require the current branch to be `master`. Review every uncommitted file and include only changes belonging to the requested release. Stop for user direction if unrelated or ambiguous changes exist.
3. Run the repository's tests, typecheck, and production build. Stop on any failure; do not bump, commit, tag, or publish a failing tree.
4. Run `git fetch origin`, then require `origin/master...master` to report no remote commits ahead. Do not merge, rebase, force-push, or overwrite remote history automatically.
5. No local token is required for the publish step — CI publishes with the auto `GITHUB_TOKEN`. (If `npm run release` is invoked locally instead, `GH_TOKEN` is still required, but the standard flow below uses the tag→CI path.)
6. Increment only the patch version with `npm version patch --no-git-tag-version`. Confirm both `package.json` and `package-lock.json` changed to the same version.
7. Run `git diff --check` and review the final diff. Commit all intended release changes, including the version files, with a concise descriptive message.
8. Push the commit with `git push origin master`. Stop if the push fails.
9. Run `publish.bat` from the repository root. It is a thin wrapper over `scripts/publish.mjs`, which creates and pushes the `v<version>` tag only — it does NOT build locally. The pushed tag triggers `.github/workflows/release.yml`, which builds + publishes the **win + mac + linux** artifacts to the same GitHub release in parallel.
10. Treat a pushed tag without a green CI release run as an incomplete release. Monitor the release workflow at `https://github.com/itsbreaded/multiagent/actions`. Rerunning `publish.bat` is safe when it reports that the tag already exists (it will just re-push it).
11. Report the version, commit hash, master push, tag, and the CI release run status. Clearly identify any incomplete step. A tag is not a published release until the CI release workflow uploads artifacts.

Never expose credentials, force-push, bypass failed validation, or claim a release was published based only on a pushed tag.
