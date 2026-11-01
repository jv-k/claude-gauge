#!/usr/bin/env node
'use strict';

// Runs the built claude-gauge from this checkout against a config folder of
// its own, .try/claude, so setup, configure and uninstall never touch
// ~/.claude. Each run sets CLAUDE_CONFIG_DIR to that folder. The package
// scripts build first:
//
//   pnpm try setup                    the setup questions
//   pnpm try configure                the configure questions
//   pnpm try uninstall                take it out of .try/claude again
//   pnpm try:statusline [switches]    the status line for a sample session
//   pnpm try:tokenline [switches]     the token line for a sample turn
//   pnpm try:reset                    delete .try/
//
// The status line saves the sample session in .try/claude, so the setup
// preview shows it once try:statusline has run.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const folder = path.join(root, '.try');
const config = path.join(folder, 'claude');
const [what = 'cli', ...args] = process.argv.slice(2);
const env = { ...process.env, CLAUDE_CONFIG_DIR: config };

// Runs a built script with `args`, `input` on its stdin when given, and
// exits with its status.
function run(script, input) {
  fs.mkdirSync(config, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(root, 'dist', script), ...args], {
    cwd: root,
    env,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (result.error) console.error(`scripts/try.js: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

if (what === 'reset') {
  fs.rmSync(folder, { recursive: true, force: true });
  console.log(`Deleted ${path.relative(root, folder)}/.`);
} else if (what === 'statusline') {
  const { samplePayload } = require('../dist/wizard.js');
  run('statusline.js', JSON.stringify({ ...samplePayload(Date.now()), workspace: { current_dir: root } }));
} else if (what === 'tokenline') {
  const { SAMPLE_RUN } = require('../dist/wizard.js');
  const transcript = path.join(folder, 'sample-transcript.jsonl');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(transcript, SAMPLE_RUN.map((record) => JSON.stringify(record)).join('\n') + '\n');
  run('tokenline.js', JSON.stringify({ session_id: 'try', transcript_path: transcript }));
} else if (what === 'cli') {
  run('cli.js');
} else {
  console.error(`scripts/try.js: unknown run "${what}". Use cli, statusline, tokenline or reset.`);
  process.exit(1);
}
