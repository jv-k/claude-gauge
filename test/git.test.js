'use strict';

// The git parts: branch with its dirty marker and ahead/behind counts, the
// change counts, and the changed files. The first tests inject what
// `git status --porcelain=v2 --branch` prints; the last run the real git
// against a temporary repository, which CI does on Windows too.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { render, parseArgs } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const OID = 'a'.repeat(40);
const entry = (xy, file) => `1 ${xy} N... 100644 100644 100644 ${OID} ${OID} ${file}`;

// Porcelain v2 status output: the branch headers, then one line per entry.
const status = ({ head = 'main', ab, entries = [] } = {}) =>
  [`# branch.oid ${OID}`, `# branch.head ${head}`, ...(ab ? ['# branch.upstream origin/main', `# branch.ab ${ab}`] : []), ...entries, ''].join('\n');

const data = { workspace: { current_dir: '/home/me/project' } };
// A file's path as render resolves it against the folder, on this platform.
const inFolder = (file) => path.resolve('/home/me/project', file);

// Renders the given parts with the injected git readers, colours stripped.
const show = (parts, { statusOf, branchOf = () => 'fallback', mtimeOf = () => undefined, payload = data } = {}) =>
  plain(render(payload, { config: parseArgs(['--show', parts]), statusOf, branchOf, mtimeOf }));

test('branch shows * when the work tree is dirty, and ↑n ↓n against its upstream', () => {
  assert.equal(show('branch', { statusOf: () => status() }), '⎇ main');
  assert.equal(show('branch', { statusOf: () => status({ entries: ['? notes.txt'] }) }), '⎇ main*');
  assert.equal(show('branch', { statusOf: () => status({ ab: '+2 -1' }) }), '⎇ main ↑2 ↓1');
  assert.equal(show('branch', { statusOf: () => status({ ab: '+0 -3' }) }), '⎇ main ↓3');
  assert.equal(show('branch', { statusOf: () => status({ ab: '+0 -0' }) }), '⎇ main');
  const wt = { workspace: { current_dir: '/home/me/project', git_worktree: 'my-feature' } };
  assert.equal(
    show('branch', { statusOf: () => status({ ab: '+1 -0', entries: [entry('.M', 'a.ts')] }), payload: wt }),
    '⎇ main* ↑1 (wt my-feature)',
  );
});

test('git counts staged, modified, deleted and untracked files, and hides when clean', () => {
  const entries = [
    entry('M.', 'staged.ts'),
    entry('A.', 'added.ts'),
    entry('.M', 'modified.ts'),
    entry('MM', 'both.ts'),
    entry('D.', 'gone.ts'),
    entry('.D', 'missing.ts'),
    `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new name.ts\told name.ts`,
    `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} conflict.ts`,
    '? notes.txt',
    '? scratch/',
  ];
  assert.equal(show('git', { statusOf: () => status({ entries }) }), '!3 +4 ✘2 ?2');
  assert.equal(show('git', { statusOf: () => status({ entries: ['? notes.txt'] }) }), '?1');
  assert.equal(show('git,branch', { statusOf: () => status() }), '⎇ main');
});

test('files lists up to 3 changed files, the most recently changed first', () => {
  const entries = [
    entry('.M', 'src/old.ts'),
    entry('.D', 'src/gone.ts'),
    entry('.M', 'src/newest.ts'),
    `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 docs/new name.md\tdocs/old name.md`,
    '? "tab\\there.txt"',
    '? scratch/',
  ];
  // Each file's time, by the absolute path render asks for.
  const times = { 'src/old.ts': 1, 'src/newest.ts': 9, 'docs/new name.md': 5, 'tab\there.txt': 3, scratch: 7 };
  const seen = [];
  const mtimeOf = (file) => (seen.push(file), times[Object.keys(times).find((k) => file === inFolder(k))]);
  assert.equal(show('files', { statusOf: () => status({ entries }), mtimeOf }), 'newest.ts scratch/ new name.md');
  assert.ok(seen.includes(inFolder('tab\there.txt')), 'a quoted path is read unquoted');
  // A deleted file has no time, so it comes after the files that have one,
  // and files with the same time keep git's order.
  const two = status({ entries: [entry('.D', 'gone.ts'), entry('.M', 'kept.ts')] });
  assert.equal(show('files', { statusOf: () => two, mtimeOf: (f) => (f.endsWith('kept.ts') ? 1 : undefined) }), 'kept.ts gone.ts');
  assert.equal(show('files', { statusOf: () => two, mtimeOf: () => 1 }), 'gone.ts kept.ts');
  assert.equal(show('files', { statusOf: () => status() }), '');
});

test('git runs once per render, and only when a git part is shown', () => {
  const calls = [];
  const statusOf = (cwd) => (calls.push(cwd), status({ ab: '+1 -0', entries: [entry('.M', 'a.ts')] }));
  assert.equal(show('branch,git,files', { statusOf, mtimeOf: () => 1 }), '⎇ main* ↑1 │ !1 │ a.ts');
  assert.deepEqual(calls, ['/home/me/project']);
  calls.length = 0;
  show('dir,model', { statusOf, branchOf: () => (calls.push('branch'), 'main') });
  assert.deepEqual(calls, []);
});

test('a status that gives no answer in time falls back to the branch alone', () => {
  const calls = [];
  const branchOf = (cwd) => (calls.push(cwd), 'main');
  assert.equal(show('branch,git,files', { statusOf: () => undefined, branchOf }), '⎇ main');
  assert.deepEqual(calls, ['/home/me/project']);
});

test('outside a repository, or in a detached HEAD, the git parts show nothing and the branch is not read again', () => {
  const branchOf = () => assert.fail('the branch is read only when the status takes too long');
  assert.equal(show('branch,git,files,model', { statusOf: () => '', branchOf, payload: { ...data, model: { display_name: 'Opus' } } }), 'Opus');
  assert.equal(show('branch', { statusOf: () => status({ head: '(detached)' }), branchOf }), '');
});

test('a hostile branch and hostile file names from git print without their control codes', () => {
  const HOSTILE = '\x1b[31m\x1b]0;title\x07‮';
  const statusOf = () => status({ head: `feat/${HOSTILE}x`, entries: [entry('.M', `src/a${HOSTILE}.ts`), `? "b\\033[2J.ts"`] });
  const raw = render(data, { config: parseArgs(['--show', 'branch,files']), statusOf, mtimeOf: () => 1 });
  assert.equal(plain(raw), '⎇ feat/x* │ a.ts b.ts');
  assert.doesNotMatch(raw.replace(/\x1b\[(?:0|0;3\d|0;90)m/g, ''), /[\x00-\x1f\x7f-\x9f‮]/);
});

test('the default second row shows the branch markers', () => {
  const statusOf = () => status({ ab: '+2 -1', entries: [entry('.M', 'a.ts')] });
  const rows = plain(render({ ...data, model: { display_name: 'Opus' } }, { nowMs: new Date(2026, 9, 7, 12).getTime(), statusOf }));
  assert.equal(rows.split('\n')[1], '12:00 │ project │ ⎇ main* ↑2 ↓1 │ Opus');
});

test('--right counts the git marks as one column each', () => {
  const statusOf = () => status({ entries: [entry('.D', 'gone.ts'), '? new.ts'] });
  const out = plain(render(data, { config: parseArgs(['--show', 'branch,git', '--right', 'git']), statusOf, columns: 24 }));
  assert.equal(out, '⎇ main*            ✘1 ?1');
});

// The real git, run by render itself, in a temporary repository cloned from
// another so that it has an upstream.
test('render reads the branch, counts and files from the real git', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-git-'));
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    const origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    for (const file of ['modified.txt', 'deleted.txt', 'sub/kept.txt']) write(path.join(origin, file), 'one\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'first');
    git(tmp, 'clone', '-q', 'origin', 'work');

    const work = path.join(tmp, 'work');
    write(path.join(work, 'ahead.txt'), 'one\n');
    git(work, 'add', 'ahead.txt');
    git(work, 'commit', '-q', '-m', 'ahead');
    write(path.join(work, 'modified.txt'), 'two\n');
    fs.rmSync(path.join(work, 'deleted.txt'));
    write(path.join(work, 'staged.txt'), 'one\n');
    git(work, 'add', 'staged.txt');
    write(path.join(work, 'untracked file.txt'), 'one\n');
    // Fixed times, a minute apart, so the newest file is known.
    const times = { 'staged.txt': 1, 'untracked file.txt': 2, 'modified.txt': 3 };
    for (const [file, minutes] of Object.entries(times)) {
      const when = new Date(Date.UTC(2026, 0, 1, 12, minutes));
      fs.utimesSync(path.join(work, file), when, when);
    }

    const expected = '⎇ main* ↑1 │ !1 +1 ✘1 ?1 │ modified.txt untracked file.txt staged.txt';
    const shown = (dir) => plain(render({ workspace: { current_dir: dir } }, { config: parseArgs(['--show', 'branch,git,files']) }));
    assert.equal(shown(work), expected);
    // From a subfolder git prints paths from there, and render reads the
    // files' times from the same place.
    assert.equal(shown(path.join(work, 'sub')), expected);
    // Outside any repository nothing shows.
    assert.equal(shown(tmp), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
