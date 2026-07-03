/** Every whitespace token in the query must prefix-match a keyword token. */
export function matchesSettingQuery(query: string, keywords: string): boolean {
  const queryTokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (queryTokens.length === 0) return true
  const keywordTokens = keywords.toLowerCase().split(/\s+/).filter(Boolean)
  return queryTokens.every((queryToken) => keywordTokens.some((keyword) => keyword.startsWith(queryToken)))
}
