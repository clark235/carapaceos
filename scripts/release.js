#!/usr/bin/env node
/**
 * scripts/release.js — CarapaceOS Release Helper
 *
 * Automates the release process:
 *   1. Validates working tree is clean
 *   2. Bumps version in package.json
 *   3. Updates CHANGELOG.md with a new section
 *   4. Commits and tags
 *   5. Optionally pushes (triggers CI)
 *
 * Usage:
 *   node scripts/release.js patch          # 0.2.1 → 0.2.2
 *   node scripts/release.js minor          # 0.2.1 → 0.3.0
 *   node scripts/release.js major          # 0.2.1 → 1.0.0
 *   node scripts/release.js 0.3.0-beta.1  # explicit version
 *   node scripts/release.js patch --dry-run
 *   node scripts/release.js patch --push   # auto push + create GH release
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Colors ──────────────────────────────────────────────────────────────────
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const bumpType = args.find(a => !a.startsWith('--')) || 'patch';
const dryRun   = args.includes('--dry-run') || args.includes('--dry');
const push     = args.includes('--push');
const force    = args.includes('--force'); // skip clean tree check

// ─── Helpers ─────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  if (dryRun && !opts.readOnly) {
    console.log(c.dim(`  [dry-run] ${cmd}`));
    return '';
  }
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit' }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    console.error(c.red(`\n❌ Command failed: ${cmd}`));
    console.error(e.stderr || e.message);
    process.exit(1);
  }
}

function runRead(cmd) {
  return run(cmd, { readOnly: true, silent: true });
}

// ─── Version Logic ────────────────────────────────────────────────────────────
function bumpVersion(current, type) {
  // If type looks like a version number, use it directly
  if (/^\d/.test(type)) return type;

  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default:
      console.error(c.red(`Unknown bump type: ${type}`));
      console.error('Use: patch | minor | major | <version>');
      process.exit(1);
  }
}

// ─── Changelog ───────────────────────────────────────────────────────────────
function updateChangelog(version, date) {
  const changelogPath = resolve(ROOT, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');

  const newSection = [
    `## [${version}] — ${date}`,
    '',
    '### Added',
    '',
    '- <!-- describe changes here -->',
    '',
    '### Changed',
    '',
    '- <!-- describe changes here -->',
    '',
  ].join('\n');

  // Insert after the first '---' separator
  const insertAfter = '---\n\n';
  const idx = changelog.indexOf(insertAfter);
  if (idx === -1) {
    console.warn(c.yellow('⚠ Could not find CHANGELOG.md insertion point. Prepending.'));
    return `${newSection}\n${changelog}`;
  }

  return changelog.slice(0, idx + insertAfter.length) + newSection + changelog.slice(idx + insertAfter.length);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c.bold('🦞 CarapaceOS Release Script'));
  console.log(c.dim(`   cwd: ${ROOT}`));
  if (dryRun) console.log(c.yellow('   DRY RUN — no files will be modified'));
  console.log('');

  // 1. Check git clean
  const gitStatus = runRead('git status --porcelain');
  if (gitStatus && !force) {
    console.error(c.red('❌ Working tree is not clean. Commit or stash changes first.'));
    console.error(c.dim('   Use --force to skip this check.'));
    console.error(c.dim('\nUncommitted changes:'));
    console.error(gitStatus);
    process.exit(1);
  }
  console.log(c.green('✓') + ' Working tree clean');

  // 2. Current version
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, bumpType);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const tag = `v${newVersion}`;

  console.log(`  Current version : ${c.dim(currentVersion)}`);
  console.log(`  New version     : ${c.green(newVersion)}`);
  console.log(`  Git tag         : ${c.cyan(tag)}`);
  console.log('');

  // Check tag doesn't already exist
  const existingTag = runRead(`git tag -l "${tag}"`);
  if (existingTag && !force) {
    console.error(c.red(`❌ Tag ${tag} already exists. Use --force to override.`));
    process.exit(1);
  }

  // 3. Bump package.json
  console.log('📝 Updating package.json...');
  if (!dryRun) {
    pkg.version = newVersion;
    writeFileSync(resolve(ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }
  console.log(c.green('✓') + ` package.json → ${newVersion}`);

  // 4. Update CHANGELOG
  console.log('📝 Updating CHANGELOG.md...');
  if (!dryRun) {
    const newChangelog = updateChangelog(newVersion, today);
    writeFileSync(resolve(ROOT, 'CHANGELOG.md'), newChangelog);
  }
  console.log(c.green('✓') + ' CHANGELOG.md — new section added (fill in the details)');
  console.log('');

  // 5. Git commit + tag
  console.log('🔖 Creating git commit + tag...');
  run(`git add package.json CHANGELOG.md`);
  run(`git commit -m "chore: release ${tag}"`);
  run(`git tag -a "${tag}" -m "Release ${tag}"`);
  console.log(c.green('✓') + ` Committed and tagged ${tag}`);

  // 6. Push (optional)
  if (push) {
    console.log('');
    console.log('📤 Pushing to origin...');
    run(`git push origin HEAD`);
    run(`git push origin "${tag}"`);
    console.log(c.green('✓') + ' Pushed branch + tag');
    console.log('');
    console.log(c.cyan('ℹ  GitHub Actions will now:'));
    console.log('   • Build + push VM image to GHCR (publish-image.yml)');
    console.log('   • Once you create a GitHub Release, npm will be published (publish-npm.yml)');
    console.log('');
    console.log('Next step — create a GitHub Release:');
    console.log(c.dim(`  gh release create ${tag} --title "${tag}" --generate-notes`));
  } else {
    console.log('');
    console.log(c.yellow('📌 Tag created locally. Push when ready:'));
    console.log(c.dim(`  git push origin HEAD && git push origin ${tag}`));
    console.log('');
    console.log('Then create a GitHub Release to trigger npm publish:');
    console.log(c.dim(`  gh release create ${tag} --title "${tag}" --generate-notes`));
  }

  if (dryRun) {
    console.log('');
    console.log(c.yellow('🧪 Dry run complete — no changes were made.'));
  }
}

main().catch(e => { console.error(c.red(`\n❌ ${e.message}`)); process.exit(1); });
