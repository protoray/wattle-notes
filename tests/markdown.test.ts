import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown';
describe('Preview isolation', () => {
  it('renders formatting and links without leaking frontmatter', () => {
    const html = renderMarkdown('---\nnew_notes_id: secret\n---\n# Hello\n\n[[Work/Idea|An idea]]');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('data-note-target="Work/Idea"');
    expect(html).not.toContain('secret');
  });
  it('escapes wiki-link attributes and labels', () => {
    const html = renderMarkdown('[[x" onclick="alert(1)|<img src=x onerror=alert(1)>]]');
    const template = document.createElement('template');
    template.innerHTML = html;
    expect(template.content.querySelector('[onclick],[onerror]')).toBeNull();
    expect(template.content.querySelector('img')).toBeNull();
  });
  it('removes scripts, executable links, and event handlers', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n<a href="javascript:alert(1)" onclick="alert(1)">bad</a>\n<iframe src="https://example.com"></iframe>',
    );
    expect(html).not.toMatch(/<script|javascript:|onclick=|<iframe/);
  });
  it('blocks remote Markdown images, including protocol-relative and data URLs', () => {
    const html = renderMarkdown(
      '![a](https://example.com/a.png)\n![b](//example.com/b.png)\n![c](data:image/svg+xml,test)',
    );
    const template = document.createElement('template');
    template.innerHTML = html;
    expect(template.content.querySelector('img[src]')).toBeNull();
    expect(html).toContain('Remote image not loaded');
  });
  it('prevents raw HTML tracking images from fetching before mounting', () =>
    expect(
      renderMarkdown(
        '<img src="https://example.com/pixel" srcset="https://example.com/2x 2x" onerror="alert(1)">',
      ),
    ).not.toMatch(/<img|onerror|srcset/));
  it('marks local images for bounded native loading without assigning a source', () => {
    const html = renderMarkdown('![Diagram](attachments/chart.png)');
    expect(html).toContain('data-local-image="attachments/chart.png"');
    expect(html).not.toContain('src=');
  });
  it('leaves wiki syntax in code blocks as code', () =>
    expect(renderMarkdown('```\n[[not a link]]\n```')).not.toContain('data-note-target'));
});
