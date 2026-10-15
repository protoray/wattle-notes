import { useEffect, useMemo, useRef } from 'react';
import { call, native } from './api';
import { renderMarkdown } from './markdown';
import { hydrateLocalImages } from './localImages';
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
    if (root.current) return hydrateLocalImages(root.current, note.id);
  }, [html, note.id, note.path]);

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
