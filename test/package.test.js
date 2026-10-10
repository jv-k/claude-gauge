'use strict';

// The release workflow publishes the package to npm from a version tag, so
// package.json must be publishable and must ship the built lines. VerBump
// only bumps, tags and pushes: the workflow creates the GitHub release.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package.json is publishable', () => {
  assert.notEqual(pkg.private, true);
  assert.ok(pkg.name);
  assert.ok(pkg.version);
});

test('package.json names the repository by URL, as npm provenance needs', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/jv-k/claude-gauge.git');
});

test('every bin entry is a built line that Node runs', () => {
  const bins = Object.entries(pkg.bin || {});
  assert.ok(bins.length > 0, 'package.json has no bin');
  for (const [name, file] of bins) {
    assert.match(file, /^dist\/[^/]+\.js$/, `${name} points outside dist/`);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${file} has no node shebang`);
  }
});

test('bump-release leaves the GitHub release to the release workflow', () => {
  assert.doesNotMatch(pkg.scripts['bump-release'], /--release\b/);
  assert.match(pkg.scripts['bump-release'], /--push origin/);
});

// npm runs as npm.cmd on Windows, which runs only through a shell (#3 plans
// CI there).
const shell = process.platform === 'win32';

// What npm publish would upload, from npm's own report. dist/ is in
// .gitignore on integration/1.0, so this proves the files field wins.
function packed() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  });
  return JSON.parse(out)[0];
}

const packedFiles = () => packed().files.map((f) => f.path).sort();

test('the package ships the built lines, and no sources or tests', () => {
  const files = packedFiles();
  for (const file of ['dist/statusline.js', 'dist/tokenline.js', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(file), `the package lacks ${file}`);
  }
  const extra = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(f));
  assert.deepEqual(extra, []);
});

// npm refuses the unscoped name claude-gauge with a 403, so the package is
// published under the owner's scope (#92). Only the npm name changes.
const NAME = '@jv-k/claude-gauge';

test('the package is published as @jv-k/claude-gauge, with public access', () => {
  assert.equal(pkg.name, NAME);
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.equal(packed().name, NAME);
});

test('the bin names stay claude-gauge, claude-gauge-statusline and claude-gauge-tokenline', () => {
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['claude-gauge', 'claude-gauge-statusline', 'claude-gauge-tokenline']);
});

// With several bins, npm exec runs the one named as the package without its
// scope. This packs the package and runs it as a user would, with npx and no
// command name, offline and with a cache of its own.
test('npx of the packed package runs the claude-gauge command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-pack-'));
  try {
    const out = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
    const tarball = JSON.parse(out)[0].filename;
    const help = execFileSync('npx', ['--yes', '--offline', '--cache', path.join(dir, 'cache'), `./${tarball}`, '--help'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
    });
    assert.match(help, /^Usage: claude-gauge <setup \| configure \| uninstall \| update>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An npm or npx command that names the package without its scope. The plugin
// name claude-gauge@claude-gauge and the bin name claude-gauge are not npm
// package names, so they do not count. An npm command stops at the end of its
// code span, so a bin command later on the same line does not count either.
const UNSCOPED = [
  /\bnpx\s+(?:--?[\w-]+\s+)*claude-gauge\b/,
  /\bnpm\s+(?:install|i|add|uninstall|un|remove|rm|update|up|exec|view|info|deprecate|dist-tag|access)\b[^`\n]*(?<![\w/@-])claude-gauge\b/,
  /(?<![\w/@-])claude-gauge@(?:\d|latest|next\b)/,
  /npmjs\.com\/package\/claude-gauge\b/,
];

const unscoped = (text) => text.split('\n').filter((line) => UNSCOPED.some((re) => re.test(line)));

test('the unscoped check finds npm commands without the scope, and passes scoped ones, the plugin and the bin', () => {
  for (const line of [
    'npx claude-gauge setup',
    'npx --yes claude-gauge setup',
    'npx claude-gauge@latest update',
    'run `npm install -g claude-gauge`.',
    'npm install -g claude-gauge@latest',
    'npm uninstall -g claude-gauge',
    'publish a placeholder version, `claude-gauge@0.0.1`, so',
    'npm deprecate @jv-k/claude-gauge@0.0.1 "Install claude-gauge 1.0.0 or later."',
    'on [npm](https://www.npmjs.com/package/claude-gauge).',
  ]) {
    assert.deepEqual(unscoped(line), [line]);
  }
  for (const line of [
    'npx @jv-k/claude-gauge setup',
    'npx @jv-k/claude-gauge@latest update',
    'npm install -g @jv-k/claude-gauge@latest',
    'npm deprecate @jv-k/claude-gauge@0.0.1 "Install @jv-k/claude-gauge 1.0.0 or later."',
    '/plugin install claude-gauge@claude-gauge',
    'claude plugin update claude-gauge@claude-gauge',
    'then `claude-gauge update`.',
    'run `npm install -g @jv-k/claude-gauge@latest`, then `claude-gauge update`.',
    'https://www.npmjs.com/package/@jv-k/claude-gauge',
  ]) {
    assert.deepEqual(unscoped(line), []);
  }
});

// Every tracked doc, and the CLI source whose text the CLI prints. The
// changelog keeps the history as it was, and dist/ is built from src/.
test('no doc tells a user to run npm or npx with the unscoped name', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.md', 'src/*.ts'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && f !== 'CHANGELOG.md' && !f.startsWith('dist/'));
  assert.ok(files.includes('README.md'), 'git ls-files found no README.md');
  const found = files.flatMap((f) => unscoped(fs.readFileSync(path.join(root, f), 'utf8')).map((line) => `${f}: ${line.trim()}`));
  assert.deepEqual(found, []);
});
