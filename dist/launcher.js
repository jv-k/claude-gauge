"use strict";
// The plugin route's launcher: runs a script from the newest installed
// version of the claude-gauge plugin.
//
// Claude Code keeps each installed plugin version in its own folder,
// <plugins>/cache/<marketplace>/<plugin>/<version>/, and deletes an old one
// some days after an update. Settings that named a version folder would run
// an old version after an update, and nothing once it is deleted. So setup,
// run from the plugin, copies this file into the state folder as
// launcher/launch.js, beside a statusline.js and a tokenline.js that each
// call launch() with the folder that holds the versions, and points the
// settings at those two. A plugin update then needs no setup.
//
// The launcher never changes, so it reads nothing of the plugin but the
// script it runs, and it prints nothing when no version is installed: a
// status line that has lost its plugin goes blank rather than showing an
// error on every refresh.
Object.defineProperty(exports, "__esModule", { value: true });
exports.newest = newest;
exports.launch = launch;
const node_child_process_1 = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;
// Newest first: a version with a version number, by that number, then the
// most recently installed folder.
function compare(a, b) {
    if (!a.version !== !b.version)
        return a.version ? -1 : 1;
    if (a.version && b.version) {
        for (let i = 0; i < a.version.length; i++) {
            if (a.version[i] !== b.version[i])
                return b.version[i] - a.version[i];
        }
    }
    return b.time - a.time;
}
// The path of `script` in the newest version under `versions`, or undefined
// when no installed version holds it. Claude Code writes .orphaned_at into
// the folder of a version that an update or an uninstall replaced, and
// deletes the folder some days later, so a marked folder is not installed.
function newest(versions, script) {
    let names;
    try {
        names = fs.readdirSync(versions);
    }
    catch {
        return undefined;
    }
    const found = [];
    for (const name of names) {
        const folder = path.join(versions, name);
        const file = path.join(folder, 'dist', script);
        try {
            if (!fs.statSync(file).isFile() || fs.existsSync(path.join(folder, '.orphaned_at')))
                continue;
            const m = VERSION.exec(name);
            found.push({
                file,
                version: m ? m.slice(1).map(Number) : undefined,
                time: fs.statSync(folder).mtimeMs,
            });
        }
        catch {
            // A version folder that cannot be read is skipped.
        }
    }
    return found.sort(compare)[0]?.file;
}
// Runs `script` from the newest version with this process's switches, input
// and output, and exits as it does.
function launch(versions, script) {
    const file = newest(versions, script);
    if (!file)
        return;
    const r = (0, node_child_process_1.spawnSync)(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
}
