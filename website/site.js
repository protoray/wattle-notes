const preview = document.getElementById('app-preview');
for (const button of document.querySelectorAll('[data-preview]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.preview;
    if (!['light', 'dark', 'midnight', 'sepia', 'forest'].includes(id)) return;
    for (const other of document.querySelectorAll('[data-preview]'))
      other.setAttribute('aria-pressed', String(other === button));
    preview.src = `./assets/app-${id}.png`;
    preview.alt = `Wattle Notes in the ${button.textContent} theme, showing a Markdown notebook with folders, search and a reading view`;
  });
}

// A missing optional link stays absent. The page and default downloads still work without JavaScript.
fetch(new URL('./release.json', document.currentScript.src))
  .then((response) => {
    if (!response.ok) throw new Error('Release metadata unavailable');
    return response.json();
  })
  .then((release) => {
    for (const node of document.querySelectorAll('[data-version]'))
      node.textContent = release.version;
    for (const node of document.querySelectorAll('[data-download-size]'))
      node.textContent = `${(release.mac.size / 1048576).toFixed(1)} MiB ·`;
    for (const [key, selector] of [
      ['repositoryUrl', '.repository-link'],
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
    /* Default download links and copy remain usable without metadata. */
  });
