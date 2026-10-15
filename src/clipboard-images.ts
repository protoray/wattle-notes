import { relativePath } from './content';

// Match the native inline-image limit before allocating/serializing image bytes.
export const MAX_CLIPBOARD_IMAGE = 10 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const items = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && imageTypes.has(item.type.toLowerCase()))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return items.length
    ? items
    : Array.from(data.files ?? []).filter((file) => imageTypes.has(file.type.toLowerCase()));
}

export function attachmentMarkdown(notePath: string, path: string, image = true): string {
  const target = relativePath(notePath, path)
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
  const name = path
    .split('/')
    .pop()!
    .replace(/^[a-f\d]{8}-/, '');
  const label = name.replace(/([\\[\]])/g, '\\$1');
  return `${image ? '!' : ''}[${label}](${target})`;
}

type ImageImport = (args: {
  expectedRoot: string;
  noteId: string;
  mime: string;
  bytes: number[];
}) => Promise<string>;

/** The caller's identity check must include notebook, note, and navigation generation. */
export async function importClipboardImages(
  files: File[],
  target: { root: string; id: string; path: string },
  isCurrent: () => boolean,
  importImage: ImageImport,
): Promise<string | null> {
  for (const file of files) {
    if (!imageTypes.has(file.type.toLowerCase()))
      throw new Error('This clipboard image format is not supported.');
    if (!file.size || file.size > MAX_CLIPBOARD_IMAGE)
      throw new Error('Pasted images must be non-empty and no larger than 10 MiB.');
  }
  const links: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return null;
    if (!bytes.length || bytes.length > MAX_CLIPBOARD_IMAGE)
      throw new Error('Pasted images must be non-empty and no larger than 10 MiB.');
    const path = await importImage({
      expectedRoot: target.root,
      noteId: target.id,
      mime: file.type.toLowerCase(),
      bytes: Array.from(bytes),
    });
    if (!isCurrent()) return null;
    links.push(attachmentMarkdown(target.path, path));
  }
  return links.length ? links.join('\n') : null;
}
