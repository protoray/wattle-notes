import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const meta = JSON.parse(
  execFileSync(
    'cargo',
    ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--format-version', '1'],
    { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
  ),
);
const records = [];
function add(ecosystem, name, version, license, folder, development = false) {
  const texts = [];
  for (const file of fs.readdirSync(folder)) {
    if (!/^(license|licence|copying|notice)(?:$|[._-])/i.test(file)) continue;
    const full = path.join(folder, file);
    if (!fs.statSync(full).isFile()) continue;
    texts.push(`===== ${file} =====\n${fs.readFileSync(full, 'utf8')}`);
  }
  const filename = `${ecosystem}-${name.replaceAll('/', '-').replaceAll('@', '')}-${version}.txt`;
  if (texts.length)
    fs.writeFileSync(path.join(root, 'docs', 'dependency-licenses', filename), texts.join('\n\n'));
  records.push({
    ecosystem,
    name,
    version,
    license: typeof license === 'string' ? license : JSON.stringify(license),
    development,
    notice: texts.length ? `docs/dependency-licenses/${filename}` : null,
  });
}
fs.mkdirSync(path.join(root, 'docs', 'dependency-licenses'), { recursive: true });
for (const [location, item] of Object.entries(lock.packages)) {
  if (
    !location ||
    !location.includes('node_modules/') ||
    !fs.existsSync(path.join(root, location, 'package.json'))
  )
    continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, location, 'package.json'), 'utf8'));
  add(
    'npm',
    manifest.name,
    manifest.version,
    manifest.license ?? 'See package source',
    path.join(root, location),
    Boolean(item.dev),
  );
}
for (const item of meta.packages.filter((p) => p.name !== 'wattle-notes'))
  add(
    'cargo',
    item.name,
    item.version,
    item.license ?? 'See package source',
    path.dirname(item.manifest_path),
  );
records.sort((a, b) =>
  `${a.ecosystem}:${a.name}:${a.version}`.localeCompare(`${b.ecosystem}:${b.name}:${b.version}`),
);
fs.writeFileSync(
  path.join(root, 'docs', 'dependencies.json'),
  JSON.stringify(records, null, 2) + '\n',
);
const rows = records.map(
  (r) =>
    `| ${r.ecosystem} | ${r.name} ${r.version} | ${r.license.replaceAll('|', '\\|')} | ${r.notice ? `[License text](${r.notice})` : 'Package source'} |`,
);
fs.writeFileSync(
  path.join(root, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\nWattle Notes is GPL-3.0-or-later. Dependencies retain their own licenses. This inventory includes build/test tools and optional platform packages as well as runtime libraries; inclusion does not imply every package is shipped on every platform.\n\nGenerated from package-lock.json, Cargo.lock, and installed package license files using \`npm run notices\`. Preserved upstream notice texts are linked below. Packages without a standalone license file retain their upstream source license declaration; inspect their source when assembling a public distribution.\n\nBundled SQLite is public domain; libsqlite3-sys and rusqlite have their own wrapper licenses. System webviews and operating-system libraries are provided by the platform.\n\n| Ecosystem | Dependency | License | Notice |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`,
);
console.log(`Recorded ${records.length} dependency licenses.`);
