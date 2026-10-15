import { describe, it, expect } from 'vitest';
import { relativePath, replaceBody, resolveTarget, splitContent } from '../src/content';
describe('Markdown file portability', () => {
  it('preserves frontmatter when editing the body', () => {
    const original = '---\nnew_notes_id: abc\ntags: [work]\ncustom: yes\n---\nHello';
    expect(replaceBody(original, 'Changed')).toBe(
      '---\nnew_notes_id: abc\ntags: [work]\ncustom: yes\n---\nChanged',
    );
  });
  it('does not hide horizontal rules in the middle of a note', () =>
    expect(splitContent('# Hello\n---\nworld').body).toContain('world'));
  it('creates portable links between nested folders', () =>
    expect(relativePath('Work/Meetings/Today.md', 'Ideas/Next step.md')).toBe(
      '../../Ideas/Next step.md',
    ));
  it('reports duplicate titles instead of selecting an arbitrary note', () =>
    expect(
      resolveTarget('Today.md', 'Idea', [
        { id: 'a', title: 'Idea', path: 'A/Idea.md' },
        { id: 'b', title: 'Idea', path: 'B/Idea.md' },
      ]),
    ).toEqual({ id: null, status: 'ambiguous' }));
  it('resolves a specific folder path', () =>
    expect(
      resolveTarget('Today.md', 'B/Idea', [
        { id: 'a', title: 'Idea', path: 'A/Idea.md' },
        { id: 'b', title: 'Idea', path: 'B/Idea.md' },
      ]).id,
    ).toBe('b'));
  it('handles encoded relative Markdown paths', () =>
    expect(
      resolveTarget(
        'Work/Today.md',
        '../Ideas/Next%20step.md',
        [{ id: 'a', title: 'Next step', path: 'Ideas/Next step.md' }],
        false,
      ).id,
    ).toBe('a'));
  it('rejects malformed percent escapes', () =>
    expect(resolveTarget('Today.md', '%zz', []).status).toBe('broken'));
});
