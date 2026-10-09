#!/usr/bin/env node
'use strict';

// Runs every test/*.test.js file with Node's test runner, named one by one,
// so the same command works on Node 18, 20 and 22 and on every system.
// Node 22 reads `node --test test/` as a module to load, not a folder, and a
// glob is expanded neither by Node 18 and 20 nor by cmd.exe on Windows.
// Switches pass through to node --test:
//
//   node scripts/test.js [--experimental-test-coverage ...]

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = fs
  .readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name));

if (files.length === 0) {
  console.error('scripts/test.js: no test/*.test.js files to run');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(`scripts/test.js: ${result.error.message}`);
process.exit(result.status ?? 1);
