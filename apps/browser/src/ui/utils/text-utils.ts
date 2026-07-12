/** Strip common markdown syntax to produce plain text.
 * Heading lines are removed entirely so callers get the first real paragraph. */
export function stripMarkdown(text: string): string {
  return (
    text
      // remove entire heading lines
      .replace(/^#{1,6}\s+.*$/gm, '')
      // bold/italic
      .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, '$2')
      // strikethrough
      .replace(/~~(.+?)~~/g, '$1')
      // inline code
      .replace(/`([^`]+)`/g, '$1')
      // links [text](url)
      .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
      // images ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // blockquotes
      .replace(/^>\s+/gm, '')
      // unordered list markers
      .replace(/^[\s]*[-*+]\s+/gm, '')
      // ordered list markers
      .replace(/^[\s]*\d+\.\s+/gm, '')
  );
}

/** Extract the first N words from a string, appending "\u2026" if truncated.
 * Markdown formatting is stripped by default; pass `stripMd: false` for plain text. */
export function firstWords(
  text: string,
  count: number,
  stripMd = true,
): string {
  const trimmed = (stripMd ? stripMarkdown(text) : text).trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/, count + 1);
  if (words.length <= count) return words.join(' ');
  return `${words.slice(0, count).join(' ')}\u2026`;
}

/** Extract plain text from a TipTap JSON document string. */
export function extractTipTapText(json: string): string {
  try {
    const doc = JSON.parse(json);
    const parts: string[] = [];
    const walk = (node: any) => {
      if (node.type === 'text' && typeof node.text === 'string')
        parts.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(doc);
    return parts.join(' ');
  } catch {
    return '';
  }
}
