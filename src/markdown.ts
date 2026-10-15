import DOMPurify from 'dompurify';
import { marked, type Tokens } from 'marked';
import { splitContent } from './content';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
marked.use({
  gfm: true,
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src) => src.indexOf('[['),
      tokenizer(src) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
        if (match) return { type: 'wikilink', raw: match[0], text: match[1] };
      },
      renderer(token) {
        const text = String(token.text);
        const [target, label] = text.split('|');
        return `<a href="#" data-note-target="${escapeHtml(target)}" data-wiki="true">${escapeHtml(label ?? target)}</a>`;
      },
    },
  ],
  renderer: {
    link({ href, text, tokens }: Tokens.Link) {
      const label = tokens ? this.parser.parseInline(tokens) : escapeHtml(text);
      if (/^(https?:|mailto:)/i.test(href))
        return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${label}</a>`;
      if (href.startsWith('#')) return `<a href="${escapeHtml(href)}">${label}</a>`;
      return `<a href="#" data-note-target="${escapeHtml(href)}">${label}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))
        return `<span class="blocked-image">Remote image not loaded: ${escapeHtml(text || 'image')}</span>`;
      return `<img data-local-image="${escapeHtml(href)}" alt="${escapeHtml(text)}" />`;
    },
  },
});

export function renderMarkdown(content: string): string {
  const html = marked.parse(splitContent(content).body, { async: false });
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'video',
      'audio',
      'source',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['style', 'srcset', 'poster', 'formaction', 'autofocus'],
    ALLOW_DATA_ATTR: true,
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  // Raw HTML cannot fetch images, tracking pixels, or other remote resources either.
  template.content.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src');
    image.removeAttribute('src');
    if (source) {
      const replacement = document.createElement('span');
      replacement.className = 'blocked-image';
      replacement.textContent = 'Embedded HTML image not loaded';
      image.replaceWith(replacement);
    }
  });
  template.content.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (href && !/^(https?:|mailto:|#)/i.test(href)) anchor.removeAttribute('href');
  });
  return template.innerHTML;
}
