#!/usr/bin/env node
'use strict';

// Prints the CHANGELOG.md section of a tagged version, without its heading,
// for the body of the GitHub release. Exits 1 when the section is missing or
// empty, so the release workflow stops before it creates a release or
// publishes to npm.
//
//   node scripts/release-notes.js v1.2.3 [CHANGELOG.md]
//
// VerBump writes each version as a level-2 heading: `## 1.2.3 (date)`, or
// `## [1.2.3](compare-url) (date)` in its grouped style.

const fs = require('node:fs');

// The section body of `tag` in `changelog`, trimmed, or null when no heading
// names that version. A tag may carry a leading `v`.
function releaseNotes(changelog, tag) {
  const version = String(tag).replace(/^v/, '');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => headingVersion(line) === version);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

// The version a `## ` heading names, or null for any other line.
function headingVersion(line) {
  const match = /^## (?:\[([^\]\s]+)\]\(|([^\s(]+))/.exec(line);
  return match ? match[1] || match[2] : null;
}

function main(argv) {
  const [tag, file = 'CHANGELOG.md'] = argv;
  if (!tag) {
    process.stderr.write('usage: release-notes.js <tag> [CHANGELOG.md]\n');
    return 1;
  }
  let changelog;
  try {
    changelog = fs.readFileSync(file, 'utf8');
  } catch (error) {
    process.stderr.write(`Cannot read ${file}: ${error.message}\n`);
    return 1;
  }
  const notes = releaseNotes(changelog, tag);
  if (!notes) {
    const version = tag.replace(/^v/, '');
    const problem = notes === null ? 'has no section for' : 'has an empty section for';
    process.stderr.write(`${file} ${problem} ${version}. Add the section, then tag again.\n`);
    return 1;
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { releaseNotes };
