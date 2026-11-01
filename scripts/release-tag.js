#!/usr/bin/env node
'use strict';

// Says whether a release tag is a pre-release, for the release workflow. A
// full tag such as v1.2.3 publishes to npm as latest. A pre-release tag such
// as v1.2.3-rc.1 publishes under the dist-tag next, as a GitHub pre-release
// (docs/adr/0001). Prints `prerelease=true` or `prerelease=false` for
// $GITHUB_OUTPUT. Exits 1 for a tag that is not a version, so the workflow
// stops before it creates a release or publishes to npm.
//
//   node scripts/release-tag.js v1.2.3-rc.1 >> "$GITHUB_OUTPUT"

// `v`, a SemVer core and an optional SemVer pre-release part. Build metadata
// is refused: npm drops it, so two tags would publish one version.
const numeric = '(?:0|[1-9]\\d*)';
const identifier = `(?:${numeric}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const tagPattern = new RegExp(`^v(?:${numeric}\\.${numeric}\\.${numeric}(?:-(${identifier}(?:\\.${identifier})*))?)$`);

// Whether a tag is a pre-release, or null when the tag is not `v` and a
// version.
function releaseTag(tag) {
  const match = tagPattern.exec(String(tag));
  return match ? { prerelease: match[1] !== undefined } : null;
}

function main(argv) {
  const [tag] = argv;
  if (!tag) {
    process.stderr.write('usage: release-tag.js <tag>\n');
    return 1;
  }
  const release = releaseTag(tag);
  if (!release) {
    process.stderr.write(`The tag ${tag} is not vX.Y.Z or vX.Y.Z-<pre-release>, so the workflow does not release it.\n`);
    return 1;
  }
  process.stdout.write(`prerelease=${release.prerelease}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { releaseTag };
