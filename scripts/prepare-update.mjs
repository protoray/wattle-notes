import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
export const repository = 'https://github.com/protoray/wattle-notes';

export function updateManifest({
  version,
  tag,
  signature,
  notes = '',
  date = new Date().toISOString(),
}) {
  if (
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !new RegExp(`^v${version.replaceAll('.', '\\.')}-alpha\\.[1-9]\\d*$`).test(tag)
  )
    throw new Error('Use the app version and its matching vVERSION-alpha.N release tag.');
  const decoded = Buffer.from(signature.trim(), 'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:') || decoded.split('\n').length < 4)
    throw new Error('A Tauri .sig file is required, not a checksum or signature URL.');
  if (!decoded.split('\n')[2]?.split('\t').includes(`version:${version}`))
    throw new Error('The signature must bind the same app version as the manifest.');
  if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Invalid publication date.');
  return {
    version,
    notes,
    pub_date: date,
    platforms: {
      'darwin-aarch64': {
        signature: signature.trim(),
        url: `${repository}/releases/download/${tag}/wattle-notes-macos-arm64.app.tar.gz`,
      },
    },
  };
}

export async function prepareUpdate(tag, environment = process.env, spawn = spawnSync) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This update packager currently supports macOS Apple Silicon only.');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  // Fail before building if the release identity is invalid.
  const validateTag = `v${pkg.version}-alpha.`;
  if (!tag?.startsWith(validateTag) || !/^[1-9]\d*$/.test(tag.slice(validateTag.length)))
    throw new Error(`Pass a matching release tag, for example ${validateTag}1.`);
  const privateKey =
    environment.TAURI_SIGNING_PRIVATE_KEY || join(homedir(), '.tauri/wattle-notes-updater.key');
  const env = {
    ...environment,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  };
  const result = spawn(
    process.execPath,
    [
      require.resolve('@tauri-apps/cli/tauri.js'),
      'build',
      '--bundles',
      'app',
      '--config',
      JSON.stringify({ bundle: { createUpdaterArtifacts: true } }),
    ],
    {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Signed update build failed. Check the toolchain and private signing key.');
  const bundle = join(root, 'src-tauri/target/release/bundle/macos');
  const archive = join(bundle, `${config.productName}.app.tar.gz`);
  const sig = `${archive}.sig`;
  const signature = await readFile(sig, 'utf8');
  // Verify against the embedded public key before staging an update feed.
  const signed = spawn(
    'cargo',
    [
      'run',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--locked',
      '--example',
      'verify_update',
      '--',
      'src-tauri/tauri.conf.json',
      archive,
      sig,
    ],
    { cwd: root, env: environment, stdio: 'inherit', shell: false },
  );
  if (signed.error || signed.status !== 0)
    throw new Error('Updater signature does not match the app public key. Nothing staged.');
  const verification = spawn('/usr/bin/tar', ['-tzf', archive], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (verification.error || verification.status !== 0) throw new Error('Invalid updater archive.');
  const entries = verification.stdout.trim().split('\n');
  if (
    !entries.length ||
    entries.some(
      (name) => !name.startsWith(`${config.productName}.app/`) || name.split('/').includes('..'),
    )
  )
    throw new Error('Unexpected updater archive entries.');
  const notes = `Wattle Notes ${pkg.version} developer alpha. Adds signed in-app update checks, download progress and save-before-restart. Mostly vibe coded with AI assistance. Mac build remains unsigned by Apple and not notarized. Google sign-in is not preconfigured.`;
  const manifest = updateManifest({ version: pkg.version, tag, signature, notes });
  const destination = join(root, 'release/updater', tag);
  await mkdir(destination, { recursive: true });
  const name = 'wattle-notes-macos-arm64.app.tar.gz';
  await copyFile(archive, join(destination, name));
  await copyFile(sig, join(destination, `${name}.sig`));
  await writeFile(join(destination, 'alpha.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = await readFile(archive);
  await writeFile(
    join(destination, 'SHA256SUMS.txt'),
    `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`,
  );
  console.log(
    `Signed updater assets staged in release/updater/${tag}/. Nothing was uploaded.\nPublish the matching release assets, verify public downloads, then copy alpha.json to updates/alpha.json and push the feed.`,
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await prepareUpdate(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
