export function findComposerMentionQuery(
  value: string,
  cursor: number | null,
  labels: readonly string[],
): { query: string; start: number; end: number } | null {
  if (cursor === null) return null;
  const end = Math.max(0, Math.min(cursor, value.length));
  const prefix = value.slice(0, end);
  const start = prefix.lastIndexOf("@");
  if (start < 0 || (start > 0 && /[a-zA-Z0-9]/.test(prefix[start - 1]))) return null;
  const query = prefix.slice(start + 1);
  if (/^\s|[\r\n]/.test(query)) return null;
  // A selected name followed by whitespace is a completed mention, not a
  // search query containing the rest of the message. Still allow multiword
  // names to be searched before their full name has been entered.
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedLabels = labels.map(label => label.toLocaleLowerCase());
  const hasLongerMatch = normalizedLabels.some(label => label.startsWith(normalizedQuery));
  if (!hasLongerMatch && normalizedLabels.some(label =>
    normalizedQuery.startsWith(label) && /^\s/.test(query.slice(label.length)),
  )) return null;
  return { query, start, end };
}
