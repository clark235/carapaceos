#!/usr/bin/env node
/**
 * image-fetch.js — Download pre-built CarapaceOS image from GHCR
 *
 * Usage:
 *   node lib/image-fetch.js [--tag v0.2.0] [--out ./vm-image/carapaceos.qcow2]
 *
 * Downloads the latest (or tagged) CarapaceOS VM image from GHCR via ORAS.
 * Falls back to GitHub Releases if ORAS is not available.
 */

import { execSync, spawnSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { get as httpsGet } from 'https';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const REGISTRY = 'ghcr.io';
const IMAGE_NAME = 'clark235/carapaceos';
const RELEASES_API = 'https://api.github.com/repos/clark235/carapaceos/releases';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { tag: 'latest', out: resolve(ROOT, 'vm-image', 'carapaceos.qcow2'), force: false, check: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) opts.tag = args[++i];
    else if (args[i].startsWith('--tag=')) opts.tag = args[i].slice(6);
    else if (args[i] === '--out' && args[i + 1]) opts.out = resolve(args[++i]);
    else if (args[i].startsWith('--out=')) opts.out = resolve(args[i].slice(6));
    else if (args[i] === '--force') opts.force = true;
    else if (args[i] === '--check') opts.check = true;
  }
  return opts;
}

function hasCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, opts = {}) {
  const result = spawnSync('bash', ['-c', cmd], {
    stdio: opts.silent ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...opts,
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`Command failed (${result.status}): ${cmd}\n${result.stderr || ''}`);
  }
  return result;
}

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'carapaceos-image-fetch/1.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    let downloaded = 0;
    let total = 0;
    let lastPct = -1;

    function doRequest(url) {
      httpsGet(url, { headers: { 'User-Agent': 'carapaceos-image-fetch/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doRequest(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
              lastPct = pct;
            }
          }
        });
        res.on('end', () => { file.close(); process.stdout.write('\n'); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    }
    doRequest(url);
  });
}

async function verifyChecksum(filePath, expectedSha256) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('fs');
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex') === expectedSha256));
    stream.on('error', reject);
  });
}

async function fetchViaOras(tag, outPath) {
  const image = `${REGISTRY}/${IMAGE_NAME}:${tag}`;
  const tmpDir = `/tmp/carapace-fetch-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });

  console.log(`📥 Pulling via ORAS: ${image}`);
  run(`oras pull "${image}" --output "${tmpDir}"`);

  const qcow2 = resolve(tmpDir, 'carapaceos-dist.qcow2');
  const manifestPath = resolve(tmpDir, 'manifest.json');

  if (!existsSync(qcow2)) throw new Error(`ORAS pull succeeded but no qcow2 found in ${tmpDir}`);

  // Verify checksum if manifest present
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await import('fs').then(fs => fs.promises.readFile(manifestPath, 'utf8')));
    if (manifest.sha256) {
      process.stdout.write('  Verifying checksum... ');
      const ok = await verifyChecksum(qcow2, manifest.sha256);
      console.log(ok ? '✅ OK' : '⚠️  MISMATCH');
      if (!ok) throw new Error('SHA256 checksum mismatch — download may be corrupted');
    }
  }

  // Move to destination
  mkdirSync(dirname(outPath), { recursive: true });
  run(`mv "${qcow2}" "${outPath}"`);
  run(`rm -rf "${tmpDir}"`, { allowFail: true });
  return true;
}

async function fetchViaGitHubReleases(tag, outPath) {
  console.log('📥 Falling back to GitHub Releases download...');

  // Get release info
  const releasesUrl = tag === 'latest'
    ? `${RELEASES_API}/latest`
    : `${RELEASES_API}/tags/${tag}`;

  let release;
  try {
    release = await fetchJSON(releasesUrl);
  } catch (e) {
    throw new Error(`Could not fetch release info from GitHub: ${e.message}`);
  }

  if (!release || !release.assets) {
    throw new Error(`No release found for tag "${tag}". Check https://github.com/clark235/carapaceos/releases`);
  }

  const qcow2Asset = release.assets.find(a => a.name === 'carapaceos-dist.qcow2');
  const manifestAsset = release.assets.find(a => a.name === 'manifest.json');

  if (!qcow2Asset) {
    throw new Error(`Release "${release.tag_name}" has no qcow2 asset. Available: ${release.assets.map(a => a.name).join(', ')}`);
  }

  console.log(`  Release: ${release.tag_name} (${release.name})`);
  console.log(`  Size: ${(qcow2Asset.size / 1024 / 1024).toFixed(1)} MB`);

  // Download manifest first for checksum
  let expectedSha256 = null;
  if (manifestAsset) {
    const manifest = await fetchJSON(manifestAsset.browser_download_url);
    expectedSha256 = manifest.sha256;
  }

  // Download image
  mkdirSync(dirname(outPath), { recursive: true });
  console.log(`  Downloading to: ${outPath}`);
  await downloadFile(qcow2Asset.browser_download_url, outPath);

  // Verify
  if (expectedSha256) {
    process.stdout.write('  Verifying checksum... ');
    const ok = await verifyChecksum(outPath, expectedSha256);
    console.log(ok ? '✅ OK' : '⚠️  MISMATCH');
    if (!ok) {
      throw new Error('SHA256 checksum mismatch — download may be corrupted');
    }
  }

  return true;
}

async function main() {
  const opts = parseArgs();

  console.log('🦞 CarapaceOS Image Fetcher');
  console.log('===========================');

  // --check mode: just print what's available
  if (opts.check) {
    console.log('Checking latest release...');
    try {
      const release = await fetchJSON(`${RELEASES_API}/latest`);
      console.log(`Latest release: ${release.tag_name} (${release.name})`);
      console.log(`Published: ${release.published_at}`);
      const asset = release.assets?.find(a => a.name === 'carapaceos-dist.qcow2');
      if (asset) console.log(`Image size: ${(asset.size / 1024 / 1024).toFixed(1)} MB`);
    } catch (e) {
      console.log('Could not fetch release info (no releases published yet?)');
    }
    return;
  }

  // Check if image already exists
  if (existsSync(opts.out) && !opts.force) {
    const stat = statSync(opts.out);
    console.log(`✅ Image already exists: ${opts.out} (${(stat.size / 1024 / 1024).toFixed(0)}MB)`);
    console.log('   Use --force to re-download.');
    return;
  }

  console.log(`Tag: ${opts.tag}`);
  console.log(`Output: ${opts.out}`);
  console.log('');

  let success = false;

  // Try ORAS first (faster, direct registry pull)
  if (hasCommand('oras')) {
    try {
      await fetchViaOras(opts.tag, opts.out);
      success = true;
    } catch (e) {
      console.log(`  ORAS failed: ${e.message}`);
      console.log('  Falling back to GitHub Releases...');
    }
  } else {
    console.log('ℹ️  ORAS not found (install: https://oras.land/docs/installation)');
    console.log('   Using GitHub Releases download instead...');
  }

  // Fall back to GitHub Releases
  if (!success) {
    try {
      await fetchViaGitHubReleases(opts.tag, opts.out);
      success = true;
    } catch (e) {
      console.error(`\n❌ Download failed: ${e.message}`);
      console.error('\nTo build from source instead:');
      console.error('  npm run build-image');
      process.exit(1);
    }
  }

  if (success) {
    const stat = statSync(opts.out);
    console.log(`\n✅ Image ready: ${opts.out}`);
    console.log(`   Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    console.log('\nRun a task:');
    console.log('  carapace-run "node --version"');
    console.log('  node -e "import(\'carapaceos-runner\').then(m => m.runIsolated(\'echo hello\', { image: \'' + opts.out + '\' })).then(console.log)"');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
