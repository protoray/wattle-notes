import { call, native } from './api';

type LocalImage = { bytes: number[]; mime_type: string };

// The Markdown renderer deliberately leaves local images without a src. Load
// bytes through the bounded native reader, never through a file or remote URL.
export function hydrateLocalImages(root: HTMLElement, sourceNote: string): () => void {
  let cancelled = false;
  const urls: string[] = [];
  if (native)
    root.querySelectorAll<HTMLImageElement>('img[data-local-image]').forEach((image) => {
      const target = image.dataset.localImage!;
      const originalAlt = image.alt;
      void call<LocalImage>('attachment_bytes', { sourceNote, target })
        .then(({ bytes, mime_type }) => {
          if (cancelled) return;
          const blob = new Blob([new Uint8Array(bytes)], { type: mime_type });
          const url = URL.createObjectURL(blob);
          urls.push(url);
          image.src = url;
        })
        .catch(() => {
          if (!cancelled) image.alt = `Image unavailable: ${originalAlt}`;
        });
    });
  return () => {
    cancelled = true;
    urls.forEach((url) => URL.revokeObjectURL(url));
  };
}
