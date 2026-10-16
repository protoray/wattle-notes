const preview = document.getElementById('app-preview');
for (const button of document.querySelectorAll('[data-preview]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.preview;
    if (!['light', 'dark', 'midnight', 'sepia', 'forest'].includes(id)) return;
    for (const other of document.querySelectorAll('[data-preview]'))
      other.setAttribute('aria-pressed', String(other === button));
    preview.src = `./assets/app-${id}.png`;
    preview.alt = `Wattle Notes in the ${button.textContent} theme, showing expandable notebooks, pages, search and a reading view`;
  });
}

// A missing optional link stays absent. Default GitHub links work without JavaScript.
fetch(new URL('./release.json', document.currentScript.src))
  .then((response) => {
    if (!response.ok) throw new Error('Release metadata unavailable');
    return response.json();
  })
  .then((release) => {
    for (const node of document.querySelectorAll('[data-version]'))
      node.textContent = release.version;
    for (const [key, selector] of [
      ['repositoryUrl', '.repository-link'],
      ['repositoryUrl', '.source-link'],
      ['releasesUrl', '.releases-link'],
      ['feedbackUrl', '.feedback-link'],
      ['supportUrl', '.support-link'],
    ]) {
      if (!release[key]) continue;
      const url = new URL(release[key]);
      if (url.protocol !== 'https:') continue;
      for (const node of document.querySelectorAll(selector)) {
        node.href = url.href;
        node.hidden = false;
        node.rel = 'noreferrer';
      }
    }
  })
  .catch(() => {
    /* Default GitHub links and copy remain usable without metadata. */
  });
