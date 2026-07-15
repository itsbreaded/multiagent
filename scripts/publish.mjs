#!/usr/bin/env node
// Cross-platform release entrypoint. Replaces publish.bat (which now delegates here).
//
// This script only creates + pushes the `v<version>` tag. The tag push triggers the CI
// release workflow (.github/workflows/release.yml), which builds + publishes the win/mac/
// linux artifacts to the same GitHub release in parallel (CI uses the auto GITHUB_TOKEN,
// so no token is required locally). Local building/publishing is intentionally NOT done
// here — CI is the single source of truth for multi-OS artifacts.
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

function run(cmd, { allowFail = false } = {}) {
  try {
    execSync(cmd, { stdio: 'inherit' })
    return true
  } catch (err) {
    if (!allowFail) throw err
    return false
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${pkg.version}`
console.log(`Version: ${pkg.version}`)
console.log(`Tag: ${tag}`)

// Create the tag if it does not already exist (local only — the release commit is already
// on master per the release skill flow).
const tagExists = run(`git rev-parse -q --verify refs/tags/${tag}`, { allowFail: true })
if (!tagExists) {
  run(`git tag ${tag}`)
} else {
  console.log(`Tag ${tag} already exists locally, continuing...`)
}

// Push the tag. This is what triggers CI to build + publish. A failure here usually means
// the tag already exists on the remote (e.g. a prior run), which is fine.
if (!run(`git push origin ${tag}`, { allowFail: true })) {
  console.warn(`WARNING: could not push tag ${tag} (it may already exist on the remote).`)
}

console.log('')
console.log(`Tag ${tag} pushed. CI will build + publish win/mac/linux artifacts to the GitHub release.`)
console.log(`Monitor: https://github.com/itsbreaded/multiagent/actions`)
console.log(`Release: https://github.com/itsbreaded/multiagent/releases/tag/${tag}`)