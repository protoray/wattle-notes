import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import Preview from '../src/Preview';
import type { Note } from '../src/types';

const fixture = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../src/api', () => ({ native: true, call: fixture.call }));
const note: Note = {
  id: 'note-id',
  path: 'Ideas/Note.md',
  title: 'Note',
  content: '',
  hash: 'hash',
  tags: [],
  modified: 0,
};
const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:local-image');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  fixture.call.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Native local images in the rendered note', () => {
  it('hydrates encoded local Markdown images with their raster MIME type and revokes on unmount', async () => {
    fixture.call.mockResolvedValue({ bytes: [137, 80, 78, 71], mime_type: 'image/png' });
    const view = render(
      <Preview
        note={note}
        content="![Screenshot](../attachments/screen%20shot.png)"
        onLink={vi.fn()}
      />,
    );
    const image = screen.getByAltText('Screenshot');
    await waitFor(() => expect(image.getAttribute('src')).toBe('blob:local-image'));
    expect(fixture.call).toHaveBeenCalledWith('attachment_bytes', {
      sourceNote: note.id,
      target: '../attachments/screen%20shot.png',
    });
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-image');
  });

  it('does not load remote Markdown or raw HTML images', async () => {
    render(
      <Preview
        note={note}
        content={
          '![Remote](https://example.com/tracker.png)\n<img src="file:///private/secret.png">'
        }
        onLink={vi.fn()}
      />,
    );
    expect(document.querySelector('img[src]')).toBeNull();
    expect(fixture.call).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('retains useful alternative text when the native reader rejects an image', async () => {
    fixture.call.mockRejectedValue(new Error('Inline images are limited to 10 MiB'));
    render(<Preview note={note} content="![Large photo](photo.jpg)" onLink={vi.fn()} />);
    await waitFor(() => expect(screen.getByAltText('Image unavailable: Large photo')).toBeTruthy());
    expect(screen.getByRole('img').hasAttribute('src')).toBe(false);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('ignores a late native response after changing notes and releases existing URLs', async () => {
    let finish!: (value: { bytes: number[]; mime_type: string }) => void;
    fixture.call.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<Preview note={note} content="![Old image](old.png)" onLink={vi.fn()} />);
    view.rerender(
      <Preview note={{ ...note, id: 'other-note' }} content="# Other note" onLink={vi.fn()} />,
    );
    await act(async () => finish({ bytes: [1], mime_type: 'image/png' }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('reloads relative images when a note moves without changing its ID', async () => {
    fixture.call.mockResolvedValue({ bytes: [1], mime_type: 'image/jpeg' });
    const view = render(<Preview note={note} content="![Photo](photo.jpg)" onLink={vi.fn()} />);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    view.rerender(
      <Preview
        note={{ ...note, path: 'Other/Note.md' }}
        content="![Photo](photo.jpg)"
        onLink={vi.fn()}
      />,
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
