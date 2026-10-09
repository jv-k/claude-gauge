'use strict';

// The files that make the repository its own plugin marketplace:
// `/plugin marketplace add jv-k/claude-gauge` reads .claude-plugin/
// marketplace.json, `/plugin install claude-gauge` installs the repository
// root as the plugin, and its commands/ become /claude-gauge:setup,
// /claude-gauge:configure and /claude-gauge:uninstall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const marketplace = json('.claude-plugin/marketplace.json');
const plugin = json('.claude-plugin/plugin.json');
const commands = path.join(root, 'commands');

test('the marketplace lists the repository root as the claude-gauge plugin', () => {
  assert.equal(marketplace.name, 'claude-gauge');
  assert.ok(marketplace.owner?.name, 'a marketplace needs an owner name');
  assert.deepEqual(
    marketplace.plugins.map((p) => [p.name, p.source]),
    [['claude-gauge', './']],
  );
});

test('the plugin is named claude-gauge, and pins no version, so every commit on main reaches users', () => {
  assert.equal(plugin.name, 'claude-gauge');
  assert.equal(plugin.version, undefined, 'a pinned version holds users on it until someone changes the string');
  assert.equal(marketplace.plugins[0].version, undefined);
  // Plugins cannot set the main statusLine, so the setup command writes the
  // user's settings instead.
  assert.equal(plugin.settings, undefined);
});

// The command's frontmatter and body.
function command(name) {
  const text = fs.readFileSync(path.join(commands, `${name}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}.md has no frontmatter`);
  const front = Object.fromEntries(
    m[1].split('\n').map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  return { front, body: m[2] };
}

test('the plugin ships the setup, configure and uninstall commands only', () => {
  assert.deepEqual(fs.readdirSync(commands).sort(), ['configure.md', 'setup.md', 'uninstall.md']);
});

test('each command runs its CLI command from the installed plugin, and may run nothing else unasked', () => {
  for (const name of ['setup', 'configure', 'uninstall']) {
    const { front, body } = command(name);
    assert.ok(front.description, `${name}.md has no description`);
    assert.ok(body.includes(`node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.js" ${name}`), `${name}.md does not run the CLI's ${name}`);
    const runs = [...body.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" (\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(runs)], [name], `${name}.md runs another command: ${runs}`);
    assert.match(front['allowed-tools'] || '', /Bash\(node:\*\)/, `${name}.md cannot run node without a prompt`);
  }
});

test('setup and configure ask their questions with AskUserQuestion, then pass the answers as switches', () => {
  for (const name of ['setup', 'configure']) {
    const { front, body } = command(name);
    assert.match(front['allowed-tools'], /AskUserQuestion/);
    assert.match(body, /AskUserQuestion/);
    for (const flag of ['--status-line', '--token-line', '--no-status-line', '--no-token-line', '--replace']) {
      assert.ok(body.includes(flag), `${name}.md never mentions ${flag}`);
    }
  }
});

test('the commands name only switches the CLI and the two bars take', () => {
  const usage = fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const name of ['setup', 'configure', 'uninstall']) {
    const { body } = command(name);
    for (const [flag] of body.matchAll(/--[a-z0-9][a-z0-9-]*/g)) {
      assert.ok(usage.includes(`'${flag}'`) || readme.includes(`| \`${flag}`), `${name}.md names ${flag}, which neither the CLI nor the README documents`);
    }
  }
});
