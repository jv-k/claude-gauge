# Pre-release tags publish to npm under `next`, as GitHub pre-releases

The owner decided on 2026-10-11 (#41) that the release workflow also releases a tag with a pre-release part, such as `v1.0.0-rc.1`. npm gets the version under the dist-tag `next`, and GitHub marks its release as a pre-release. A full tag such as `v1.0.0` publishes as before: under npm's default dist-tag `latest`, as a normal GitHub release. So `latest`, which `npm install @jv-k/claude-gauge` installs, moves only on a full release, and a tester installs a candidate with `npm install @jv-k/claude-gauge@next`.

`next` is the one dist-tag for every pre-release, whether the part is `rc`, `beta` or `alpha`. A dist-tag per pre-release name, such as `rc` or `beta`, was out of scope: one channel is enough while the project cuts one pre-release line at a time.

`scripts/release-tag.js` decides from the tag whether it is a pre-release, and the publish and release steps branch on its output. GitHub's tag filters cannot check a SemVer pre-release part exactly, so the filter starts the workflow on any `vX.Y.Z-*` tag and the script fails a tag that only looks like a version, before anything is public.
