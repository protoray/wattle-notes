export function splitContent(content: string): { header: string; body: string } {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match
    ? { header: match[0], body: content.slice(match[0].length) }
    : { header: '', body: content };
}
export function replaceBody(content: string, body: string): string {
  return splitContent(content).header + body;
}
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...Array(a.length - common).fill('..'), ...b.slice(common)].join('/');
}
export function resolveTarget(
  source: string,
  target: string,
  notes: { id: string; path: string; title: string }[],
  wiki = true,
): { id: string | null; status: 'resolved' | 'broken' | 'ambiguous' } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#')[0]);
  } catch {
    return { id: null, status: 'broken' };
  }
  const parts = source.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (!parts.length) return { id: null, status: 'broken' };
      parts.pop();
    } else if (part !== '.' && part) parts.push(part);
  }
  const relative = parts.join('/');
  const found = notes.filter(
    (n) =>
      n.path === relative ||
      (wiki &&
        (n.path.replace(/\.md$/, '') === relative ||
          n.path.replace(/\.md$/, '') === decoded ||
          (!decoded.includes('/') && n.title === decoded))),
  );
  return {
    id: found.length === 1 ? found[0].id : null,
    status: found.length === 1 ? 'resolved' : found.length ? 'ambiguous' : 'broken',
  };
}
