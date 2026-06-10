export function displayGitBranch(branch: string | null | undefined): string | null {
  const value = branch?.trim()
  if (!value || value === 'HEAD') return null
  return value
}
