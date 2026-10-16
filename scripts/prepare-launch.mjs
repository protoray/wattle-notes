import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseEnvironment } from './build-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = [
  'src',
  'src-tauri/src',
  'src-tauri/examples',
  'src-tauri/icons',
  'src-tauri/capabilities',
  'scripts',
  'tests',
  'docs',
  'assets',
  '.github/workflows',
  'website',
  'updates',
];
const sourceFiles = [
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'eslint.config.js',
  'playwright.config.ts',
  'playwright.capture.config.ts',
  'playwright.site.config.ts',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
];

export function publicSourcePath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  return (
    !parts.some(
      (part) =>
        [
          '..',
          '.',
          '',
          '.git',
          'node_modules',
          'target',
          'dist',
          'release',
          'test-results',
          'playwright-report',
          '__pycache__',
          '.notes',
          '.DS_Store',
        ].includes(part) ||
        part.startsWith('.env') ||
        /\.(pem|key|p12|pfx|log|db|db-shm|db-wal|pyc|pyo|local\.json)$/i.test(part),
    ) && path !== 'docs/HANDOFF.md'
  );
}
export function publicLink(value, name) {
  if (value === null || value === undefined || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL or null`);
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error(`${name} must be an HTTPS URL without embedded credentials`);
  return url.href;
}
async function filesUnder(path) {
  if (!publicSourcePath(path)) return [];
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw new Error(`Refusing a symbolic link in public source: ${path}`);
  if (info.isDirectory()) {
    const result = [];
    for (const name of (await readdir(join(root, path))).sort())
      result.push(...(await filesUnder(`${path}/${name}`)));
    return result;
  }
  if (!info.isFile()) throw new Error(`Unsupported public source entry: ${path}`);
  return [path];
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0)
    throw new Error(`Launch preparation stopped: ${command} failed`);
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function googleBuildConfigured(binary, environment = process.env) {
  if (!environment.GOOGLE_CLIENT_ID?.trim()) {
    if (/[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com/.test(binary.toString('latin1')))
      throw new Error(
        'This bundle contains a Google client. Package it with the same GOOGLE_CLIENT_ID used to build it.',
      );
    return false;
  }
  const checked = releaseEnvironment(environment);
  if (!binary.includes(Buffer.from(checked.GOOGLE_CLIENT_ID)))
    throw new Error(
      'The Mac bundle does not contain the configured Google client. Rebuild it with the same client before packaging.',
    );
  return true;
}

export async function prepareLaunch(environment = process.env) {
  if (process.platform !== 'darwin')
    throw new Error(
      'This launch kit currently packages the verified Apple Silicon macOS build. Run on macOS with a matching native build.',
    );
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  if (pkg.version !== tauri.version || !cargo.includes(`version = "${pkg.version}"`))
    throw new Error('Align the npm, Tauri and Cargo application versions before packaging.');
  const config = JSON.parse(await readFile(join(root, 'website/launch.json'), 'utf8'));
  const links = Object.fromEntries(
    ['homepage', 'repositoryUrl', 'releasesUrl', 'feedbackUrl', 'supportUrl'].map((key) => [
      key,
      publicLink(config[key], key),
    ]),
  );
  const app = join(root, 'src-tauri/target/release/bundle/macos/Wattle Notes.app');
  const binary = join(app, 'Contents/MacOS/wattle-notes');
  const binaryInfo = await stat(binary).catch(() => {
    throw new Error('Build the macOS app first: npm run desktop:build -- --bundles app');
  });
  const header = await readFile(binary);
  const googlePreconfigured = googleBuildConfigured(header, environment);
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c)
    throw new Error(
      'The current website download is labelled Apple Silicon; provide a matching ARM64 macOS build.',
    );
  const appInputs = [
    'src',
    'src-tauri/src',
    'src-tauri/icons',
    'src-tauri/capabilities',
    'src-tauri/build.rs',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'package-lock.json',
    'vite.config.ts',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ];
  for (const input of appInputs) {
    for (const path of await filesUnder(input)) {
      if ((await stat(join(root, path))).mtimeMs > binaryInfo.mtimeMs)
        throw new Error(`Rebuild the app before packaging; it is older than ${path}`);
    }
  }
  for (const id of ['light', 'dark', 'midnight', 'sepia', 'forest'])
    await stat(join(root, `website/assets/app-${id}.png`)).catch(() => {
      throw new Error('Capture the product screenshots first: npm run screenshots:site');
    });

  const destination = join(root, 'website/dist');
  const releaseDirectory = join(root, 'release');
  const githubAssets = join(releaseDirectory, 'github');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await mkdir(githubAssets, { recursive: true });
  for (const name of ['wattle-notes-source.zip', 'wattle-notes-macos-arm64.zip'])
    await rm(join(githubAssets, name), { force: true });
  for (const item of [
    'index.html',
    'styles.css',
    'site.js',
    'icon.svg',
    'assets',
    'privacy',
    'terms-of-service',
    'getting-started',
  ])
    await cp(join(root, 'website', item), join(destination, item), { recursive: true });
  // The public launch kit deliberately excludes the interactive app preview.
  // Host-agnostic static output, with no note data, local handoff, credentials or build caches.
  const snapshot = await mkdtemp(join(tmpdir(), 'wattle-launch-source-'));
  try {
    const folder = `wattle-notes-${pkg.version}-source`;
    const sources = [...sourceFiles];
    for (const path of sourceRoots) sources.push(...(await filesUnder(path)));
    const manifest = [];
    for (const path of [...new Set(sources)].sort()) {
      if (!publicSourcePath(path)) continue;
      const target = join(snapshot, folder, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, path), target, { dereference: false });
      manifest.push(`${await sha256(target)}  ${path}`);
    }
    await writeFile(join(snapshot, folder, 'SOURCE-SHA256SUMS.txt'), `${manifest.join('\n')}\n`);
    run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      '--norsrc',
      join(snapshot, folder),
      join(githubAssets, 'wattle-notes-source.zip'),
    ]);
    run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      '--norsrc',
      app,
      join(githubAssets, 'wattle-notes-macos-arm64.zip'),
    ]);
    const downloads = [];
    for (const name of ['wattle-notes-macos-arm64.zip', 'wattle-notes-source.zip']) {
      const path = join(githubAssets, name);
      downloads.push({ name, size: (await stat(path)).size, sha256: await sha256(path) });
    }
    await writeFile(
      join(githubAssets, 'SHA256SUMS.txt'),
      `${downloads.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n')}\n`,
    );
    const release = {
      version: pkg.version,
      channel: 'developer-alpha',
      platform: 'macos-arm64',
      signed: false,
      googlePreconfigured,
      preparedAt: new Date().toISOString(),
      ...links,
      mac: downloads[0],
      source: downloads[1],
    };
    await writeFile(join(destination, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    await writeFile(
      join(githubAssets, 'ALPHA-README.txt'),
      `Wattle Notes ${pkg.version} — developer alpha\n\nMostly vibe coded with AI assistance.\nmacOS Apple Silicon only. Unsigned by Apple; not notarized.\nLocal notes work without an account. ${googlePreconfigured ? 'Google sign-in is configured; users do not need to create an OAuth client.' : 'Google sign-in is not preconfigured.'}\nCloud conflict recovery and optional Nextcloud backup still require live service acceptance testing.\nKeep independent backups and start with a test notebook.\n\nMatching source is in wattle-notes-source.zip, licensed GPL-3.0-or-later.\nSOURCE-SHA256SUMS.txt records its public source snapshot.\nSHA256SUMS.txt records both download archives.\n\nRepository: ${links.repositoryUrl}\nPublish these files as assets of a GitHub pre-release. Preparing them does not upload, tag or publish anything.\nDo not imply this is an Apple-signed or notarized release.\n\nSee the getting-started, privacy and terms pages at ${links.homepage}\n`,
    );
    const kit = join(releaseDirectory, 'wattle-notes-launch-kit.zip');
    await rm(kit, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--norsrc', destination, kit]);
    await writeFile(
      join(releaseDirectory, 'SHA256SUMS.txt'),
      `${await sha256(kit)}  wattle-notes-launch-kit.zip\n`,
    );
    console.log(
      `Static website: ${relative(root, destination)}\nWebsite upload archive: release/wattle-notes-launch-kit.zip\nGitHub release assets: release/github/\nVersion ${pkg.version}; ${manifest.length} public source files; app and source checksums verified separately from the website.`,
    );
    return release;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareLaunch();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
