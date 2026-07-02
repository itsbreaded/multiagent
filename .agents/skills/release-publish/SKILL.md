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
5. Require `GH_TOKEN` to be present without printing its value.
6. Increment only the patch version with `npm version patch --no-git-tag-version`. Confirm both `package.json` and `package-lock.json` changed to the same version.
7. Run `git diff --check` and review the final diff. Commit all intended release changes, including the version files, with a concise descriptive message.
8. Push the commit with `git push origin master`. Stop if the push fails.
9. Run `publish.bat` normally from the repository root. It creates and pushes `v<version>`, builds the NSIS installer, and publishes the GitHub release.
10. If `dist\win-unpacked` is locked by a running packaged MultiAgent instance, do not kill the application and do not substitute another output directory. Ask the user to close that instance, then rerun `publish.bat` normally.
11. Treat a pushed tag without a successful `publish.bat` completion as an incomplete release. Rerunning the batch is safe when it reports that the tag already exists.
12. Report the version, commit hash, master push, tag, test results, and publish result. Clearly identify any incomplete step.

Never expose credentials, force-push, bypass failed validation, or claim a release was published based only on a pushed tag.
