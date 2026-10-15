import { useEffect, useMemo, useRef } from 'react';
import { call, native } from './api';
import { renderMarkdown } from './markdown';
import type { Note } from './types';
export default function Preview({
  note,
  content,
  onLink,
}: {
  note: Note;
  content: string;
  onLink: (target: string, wiki: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    if (native)
      root.current?.querySelectorAll<HTMLImageElement>('img[data-local-image]').forEach((image) => {
        const target = image.dataset.localImage!;
        void call<number[]>('attachment_bytes', { sourceNote: note.id, target })
          .then((bytes) => {
            if (cancelled) return;
            const blob = new Blob([new Uint8Array(bytes)]);
            const url = URL.createObjectURL(blob);
            urls.push(url);
            image.src = url;
          })
          .catch(() => {
            if (!cancelled) image.alt = `Image unavailable: ${image.alt}`;
          });
      });
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [html, note.id]);
  return (
    <div
      className="reading-page"
      ref={root}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest('a');
        if (!anchor) return;
        event.preventDefault();
        if (anchor.dataset.noteTarget) {
          onLink(anchor.dataset.noteTarget, anchor.dataset.wiki === 'true');
          return;
        }
        const href = anchor.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        if (native) void call('open_external', { url: href });
        else window.open(href, '_blank', 'noopener,noreferrer');
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
