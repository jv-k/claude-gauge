#!/usr/bin/env node
"use strict";
// The claude-gauge command: sets the bars up in Claude Code's settings,
// changes their switches, takes them out again, and updates the copy of the
// scripts that the settings run.
//
//   claude-gauge setup
//   claude-gauge setup --yes
//   claude-gauge setup --status-line "--show ctx,5h,7d --segments 10" --token-line "--window 1m"
//   claude-gauge configure --no-token-line
//   claude-gauge uninstall
//   claude-gauge update
//   claude-gauge update --dry-run
//
// setup and configure with no bar switches ask the questions themselves,
// with a preview of the status line after each answer (wizard.ts). With
// switches they ask nothing: the form the plugin's slash commands run once
// Claude has asked the questions.
//
// Everything it keeps lives in the state folder, claude-gauge/ in the Claude
// config folder ($CLAUDE_CONFIG_DIR, else ~/.claude): the copy of the
// scripts in runtime/, or, when it runs from the plugin, the launcher in
// launcher/, and the status line it replaced in .state/.
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
const settings_1 = require("./settings");
const settings_file_1 = require("./settings-file");
const wizard_1 = require("./wizard");
const statusline_1 = require("./statusline");
const wordmark_1 = require("./wordmark");
const styles_1 = require("./styles");
const USAGE = `Usage: claude-gauge <setup | configure | uninstall | update> [switches]

  setup        add the status line and the token line to Claude Code's settings
  configure    change the switches of a bar that setup added, or take it out
  uninstall    take claude-gauge out, and put back the status line it replaced
  update       update claude-gauge with the tool that installed it

Switches for setup and configure:
  --status-line <switches>   add the status line, run with these switches ("" for none)
  --no-status-line           leave the status line out
  --token-line <switches>    add the token line, run with these switches ("" for none)
  --no-token-line            leave the token line out
  --replace                  replace a status line that is not claude-gauge's
  --yes                      setup only: add each bar not chosen above, with no switches

Switches for update:
  --dry-run                  print the commands that update would run, and run nothing

With none of the bar switches above, setup and configure ask which bars and
parts you want, and show the status line after each answer.

The bars' switches are in README.md, under Options. The settings file is
$CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json.
`;
// The wordmark and a blank line, in colour when `stream` takes colour. The
// usage and the questions start with it. Scripts and the plugin's slash
// commands run the commands with switches, and those print no wordmark.
const banner = (stream) => `${(0, wordmark_1.wordmark)((0, wordmark_1.colorEnabled)(stream))}\n`;
// The usage, under the wordmark, for `stream`.
const usage = (stream) => banner(stream) + USAGE;
// A mistake in the command line: exit 2, with the usage.
class UsageError extends Error {
}
// A tool that update needs is not on PATH: exit 2, with no usage.
class MissingTool extends Error {
}
const COMMANDS = ['setup', 'configure', 'uninstall', 'update'];
// The words of a bar switch's value, `--show ctx,5h,7d --segments 10`, split
// at runs of white space with empty words dropped, so that "" is no switches.
const words = (value) => value.split(/\s+/).filter(Boolean);
// Every switch: its names, the commands that take it, and what it sets.
// --help goes with any command.
const SWITCHES = [
    { names: ['--status-line'], commands: ['setup', 'configure'], apply: (args, value) => { args.statusLine = words(value()); } },
    { names: ['--no-status-line'], commands: ['setup', 'configure'], apply: (args) => { args.statusLine = null; } },
    { names: ['--token-line'], commands: ['setup', 'configure'], apply: (args, value) => { args.tokenLine = words(value()); } },
    { names: ['--no-token-line'], commands: ['setup', 'configure'], apply: (args) => { args.tokenLine = null; } },
    { names: ['--replace'], commands: ['setup', 'configure'], apply: (args) => { args.replace = true; } },
    { names: ['--yes', '-y'], commands: ['setup'], apply: (args) => { args.yes = true; } },
    { names: ['--dry-run'], commands: ['update'], apply: (args) => { args.dryRun = true; } },
    { names: ['--help', '-h'], commands: [...COMMANDS], apply: (args) => { args.help = true; } },
];
// Unlike the two bars, which ignore what they do not know so that a typo
// never blanks the status line, the command refuses an unknown word: it
// writes the user's settings, and a typo there should stop it.
function parseArgs(argv) {
    const args = { help: false, replace: false, yes: false, dryRun: false };
    const seen = [];
    for (let i = 0; i < argv.length; i++) {
        const [name, inline] = argv[i].split(/=(.*)/s);
        if (!name.startsWith('-')) {
            if (args.command)
                throw new UsageError(`Unexpected word: ${name}`);
            if (name === 'help')
                args.help = true;
            else if (COMMANDS.includes(name))
                args.command = name;
            else
                throw new UsageError(`Unknown command: ${name}`);
            continue;
        }
        const known = SWITCHES.find((s) => s.names.includes(name));
        if (!known)
            throw new UsageError(`Unknown switch: ${name}`);
        // A value is the next word whatever it holds, since switches start with --.
        known.apply(args, () => {
            const v = inline ?? argv[++i];
            if (v === undefined)
                throw new UsageError(`${name} needs a value: the switches for that bar, or "" for none.`);
            return v;
        });
        seen.push(known);
    }
    const { command } = args;
    const stray = command && seen.find((s) => !s.commands.includes(command));
    if (stray)
        throw new UsageError(`${args.command} takes no ${stray.names[0]}`);
    return args;
}
// The folders and files it works with.
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = () => path.join(configDir(), 'settings.json');
const stateDir = () => path.join(configDir(), 'claude-gauge');
const savedStatusLineFile = () => path.join(stateDir(), '.state', 'previous-statusline.json');
// The package this command runs from: dist/.. of this file.
const packageRoot = path.resolve(__dirname, '..');
const RUNTIME = ['statusline.js', 'tokenline.js'];
// The native realpath also expands a Windows short name, such as RUNNER~1,
// which Bun has already expanded in __dirname and the JavaScript one keeps.
function sameFolder(a, b) {
    try {
        const [x, y] = [fs.realpathSync.native(a), fs.realpathSync.native(b)];
        return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
    }
    catch {
        return false;
    }
}
// The folder that holds the plugin's installed versions, when this command
// runs from one of them: Claude Code installs a plugin into
// <plugins>/cache/<marketplace>/<plugin>/<version>/, with its manifest.
function pluginVersions() {
    const versions = path.dirname(packageRoot);
    const cache = path.dirname(path.dirname(versions));
    if (path.basename(cache) !== 'cache')
        return undefined;
    if (!fs.existsSync(path.join(packageRoot, '.claude-plugin', 'plugin.json')))
        return undefined;
    return versions;
}
function scripts() {
    if (sameFolder(packageRoot, stateDir()))
        return { route: 'clone', dir: path.join(stateDir(), 'dist') };
    const versions = pluginVersions();
    if (versions)
        return { route: 'launcher', dir: path.join(stateDir(), 'launcher'), versions };
    return { route: 'copy', dir: path.join(stateDir(), 'runtime') };
}
const version = () => {
    try {
        return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
};
// Copies the two scripts into `dir`, each replaced whole, so a status line
// that runs during the copy reads the old script or the new one. The
// package.json beside them keeps Node reading them as CommonJS, whatever a
// package.json further up says.
function copyRuntime(dir) {
    for (const file of RUNTIME)
        (0, settings_file_1.writeAtomic)(path.join(dir, file), fs.readFileSync(path.join(packageRoot, 'dist', file)));
    writePackageJson(dir, 'claude-gauge-runtime');
}
function writePackageJson(dir, name) {
    const pkg = { name, version: version(), private: true, type: 'commonjs' };
    (0, settings_file_1.writeAtomic)(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
// Writes the launcher into `dir`: launch.js, and one entry file per script
// that runs it from the newest version in `versions`. The entry files keep
// the scripts' names, so the settings name statusline.js and tokenline.js
// as on every other route, and claude-gauge knows them as its own.
function writeLauncher(dir, versions) {
    (0, settings_file_1.writeAtomic)(path.join(dir, 'launch.js'), fs.readFileSync(path.join(packageRoot, 'dist', 'launcher.js')));
    for (const file of RUNTIME) {
        const entry = [
            '#!/usr/bin/env node',
            `// Written by claude-gauge setup: runs ${file} from the newest installed`,
            '// claude-gauge plugin, so a plugin update needs no setup.',
            `require('./launch.js').launch(${JSON.stringify(versions)}, ${JSON.stringify(file)});`,
            '',
        ].join('\n');
        (0, settings_file_1.writeAtomic)(path.join(dir, file), entry);
    }
    writePackageJson(dir, 'claude-gauge-launcher');
}
// The status line claude-gauge replaced: undefined when none is saved, null
// when there was none to replace. Only a missing file means none is saved: a
// file it cannot read or parse stops the command, because going on would
// drop the only record of the status line to put back.
function savedStatusLine() {
    const file = savedStatusLineFile();
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return undefined;
        throw new Error(`Cannot read ${file}: ${err.message}. Fix or delete it by hand.`);
    }
    let saved;
    try {
        saved = JSON.parse(text);
    }
    catch {
        saved = undefined;
    }
    const statusLine = saved?.statusLine;
    if (typeof saved !== 'object' || saved === null || !(statusLine === null || (typeof statusLine === 'object' && !Array.isArray(statusLine)))) {
        throw new Error(`${file} does not hold a saved status line, so claude-gauge cannot tell what to put back. Fix or delete it by hand.`);
    }
    return statusLine;
}
// Writes the pieces to stdout, each a styled line or a pill.
const say = (...pieces) => process.stdout.write(pieces.join(''));
// setup and configure: turns the bars' switches into commands, plans the
// settings, and writes them, under a pill that names the step: SETUP or
// CONFIGURE when run with switches, DONE after the wizard.
function apply({ statusLine, tokenLine }, replace, heading) {
    const file = settingsFile();
    const { settings, text } = (0, settings_file_1.readSettings)(file);
    const where = scripts();
    const { dir } = where;
    const command = (script, switches) => switches === null || switches === undefined ? switches : (0, settings_1.commandFor)(path.join(dir, script), switches);
    const choices = {
        statusLine: command('statusline.js', statusLine),
        tokenLine: command('tokenline.js', tokenLine),
        replace,
        previous: savedStatusLine() ?? null,
    };
    const next = (0, settings_1.plan)(settings, choices);
    if (next.blocked) {
        const current = settings.statusLine.command ?? JSON.stringify(settings.statusLine);
        const whose = next.found === 'claude-hud' ? "claude-hud's status line" : 'another status line';
        throw new Error([
            `${file} already runs ${whose}:`,
            `  ${current}`,
            'Run again with --replace to replace it. claude-gauge saves it, and claude-gauge uninstall puts it back.',
        ].join('\n'));
    }
    // The scripts go in first, so the settings never name a missing file.
    if (typeof choices.statusLine === 'string' || typeof choices.tokenLine === 'string') {
        if (where.route === 'copy')
            copyRuntime(dir);
        if (where.route === 'launcher')
            writeLauncher(dir, where.versions);
    }
    // The status line to put back is saved before the settings change, so a
    // failed save leaves nothing to restore wrongly.
    if (next.backup)
        (0, settings_file_1.writeAtomic)(savedStatusLineFile(), JSON.stringify(next.backup, null, 2) + '\n');
    const settingsBackup = next.changed ? (0, settings_file_1.writeSettings)(file, next.settings, text) : null;
    if (next.dropBackup)
        fs.rmSync(savedStatusLineFile(), { force: true });
    const s = (0, styles_1.stylesFor)(process.stdout);
    if (!next.changed) {
        say(s.pill(heading), s.info(`${s.value(file)} already holds these choices. Nothing to change.`));
        return;
    }
    const ours = (0, settings_1.installed)(next.settings);
    const bar = (name, command) => (command ? s.ok(`${name}: ${s.value(command)}`) : s.info(`${name}: not set up`));
    say(s.pill(heading), bar('Status line', ours.statusLine), bar('Token line', ours.tokenLine), ...(settingsBackup ? [s.info(`Backup of the previous settings: ${s.value(settingsBackup)}`)] : []), s.info('Start a new Claude Code session to pick up the changes.'));
}
// Whether gh runs here, and the call that stars the repo with it.
const hasGh = () => (0, node_child_process_1.spawnSync)('gh', ['--version'], { stdio: 'ignore' }).status === 0;
const starWithGh = () => (0, node_child_process_1.spawnSync)('gh', ['api', '--method', 'PUT', 'user/starred/jv-k/claude-gauge'], { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;
// setup or configure with no bar switches: asks before it replaces another
// status line, then asks for the bars, and writes them. configure starts the
// questions from the bars set up, setup from the defaults. setup ends with
// the star offer.
async function interactive(command, replace) {
    const io = (0, wizard_1.streamIo)(process.stdin, process.stdout);
    const s = (0, styles_1.stylesFor)(process.stdout);
    try {
        io.write((0, wordmark_1.wordmark)((0, wordmark_1.colorEnabled)(process.stdout)) + s.pill(command));
        const file = settingsFile();
        const { settings } = (0, settings_file_1.readSettings)(file);
        const current = settings.statusLine;
        const owner = (0, settings_1.ownerOf)(current);
        if (!replace && (0, settings_1.isForeign)(owner)) {
            const whose = owner === 'claude-hud' ? "claude-hud's status line" : 'another status line';
            io.write(s.pill('Warning', 'warning') + s.warn(`${s.value(file)} already runs ${whose}:`) + s.trace(s.value(current?.command ?? JSON.stringify(current))));
            if (!(await (0, wizard_1.confirm)(io, 'Replace it? claude-gauge saves it, and claude-gauge uninstall puts it back.', false))) {
                say(s.info('Nothing changed.'));
                return;
            }
            replace = true;
        }
        const preview = (0, wizard_1.previewer)((0, wizard_1.loadPayload)((0, statusline_1.payloadFile)()));
        const choices = await (0, wizard_1.runWizard)(io, { preview, installed: command === 'configure' ? (0, settings_1.installedSwitches)(settings) : undefined });
        if (!choices) {
            say(s.info('Nothing changed.'));
            return;
        }
        apply(choices, replace, 'Done');
        if (command === 'setup')
            await (0, wizard_1.offerStar)(io, { hasGh, star: starWithGh });
    }
    finally {
        io.close();
    }
}
async function setup(args) {
    const chosen = args.statusLine !== undefined || args.tokenLine !== undefined;
    if (!chosen && !args.yes)
        return interactive('setup', args.replace);
    const orDefault = (v) => (v === undefined && args.yes ? [] : v);
    apply({ statusLine: orDefault(args.statusLine), tokenLine: orDefault(args.tokenLine) }, args.replace, 'Setup');
}
async function configure(args) {
    const file = settingsFile();
    if (!(0, settings_1.installed)((0, settings_file_1.readSettings)(file).settings).any) {
        throw new Error(`claude-gauge is not set up in ${file}. Run claude-gauge setup first.`);
    }
    if (args.statusLine === undefined && args.tokenLine === undefined)
        return interactive('configure', args.replace);
    apply(args, args.replace, 'Configure');
}
function uninstall() {
    const file = settingsFile();
    const { settings, text } = (0, settings_file_1.readSettings)(file);
    const saved = savedStatusLine();
    const next = (0, settings_1.plan)(settings, { uninstall: true, previous: saved ?? null });
    // The saved status line goes only once the settings no longer need it, so
    // a failed write leaves it for the next try.
    const settingsBackup = next.changed ? (0, settings_file_1.writeSettings)(file, next.settings, text) : null;
    fs.rmSync(savedStatusLineFile(), { force: true });
    const s = (0, styles_1.stylesFor)(process.stdout);
    if (!next.changed) {
        say(s.pill('Uninstall'), s.info(`claude-gauge is not in ${s.value(file)}. Nothing to change.`));
        return;
    }
    const restored = next.found === 'claude-gauge' && saved ? s.ok(`Put back the previous status line: ${s.value(saved.command ?? JSON.stringify(saved))}`) : '';
    say(s.pill('Uninstall'), s.ok(`Took claude-gauge out of ${s.value(file)}.`), restored, settingsBackup ? s.info(`Backup of the previous settings: ${s.value(settingsBackup)}`) : '', s.info(`The scripts stay in ${s.value(stateDir())}. Delete that folder to remove them too.`), s.info('Start a new Claude Code session to pick up the changes.'));
}
// The tools that install claude-gauge, and the release that update asks
// each one for.
const PACKAGE = '@jv-k/claude-gauge';
const PLUGIN = 'claude-gauge@claude-gauge';
// Set on the claude-gauge that update runs from the newest release, so that
// one copies its own scripts into the state folder and runs nothing else.
const IN_PLACE = 'CLAUDE_GAUGE_UPDATE_IN_PLACE';
// Windows runs npm, npx and claude through their .cmd shims, which only a
// shell finds. The words are fixed, so the shell splits nothing it should not.
const viaShell = (program) => process.platform === 'win32' && program !== process.execPath;
const onPath = (program) => (0, node_child_process_1.spawnSync)(program, ['--version'], { stdio: 'ignore', shell: viaShell(program) }).status === 0;
// Whether this command runs from a global npm install of the package.
// A link that npm link made points at a checkout, which update copies from
// in place, as it does any other folder.
function globalInstall() {
    if (path.basename(path.dirname(path.dirname(packageRoot))) !== 'node_modules')
        return false;
    const root = (0, node_child_process_1.spawnSync)('npm', ['root', '-g'], { encoding: 'utf8', shell: viaShell('npm') });
    if (root.status !== 0)
        return false;
    const installed = path.join(root.stdout.trim(), ...PACKAGE.split('/'));
    try {
        if (fs.lstatSync(installed).isSymbolicLink())
            return false;
    }
    catch {
        return false;
    }
    return sameFolder(installed, packageRoot);
}
// The commands that update the copy in `runtime/`, or none when this command
// copies from itself: a checkout, or the newest release that a parent update
// ran. npx keeps each version in a cache folder under _npx/.
function copySteps() {
    if (process.env[IN_PLACE])
        return undefined;
    const env = { [IN_PLACE]: '1' };
    if (packageRoot.split(path.sep).includes('_npx')) {
        return { method: 'npx', steps: [{ argv: ['npx', '--yes', `${PACKAGE}@latest`, 'update'], env }] };
    }
    if (globalInstall()) {
        return {
            method: 'A global npm install',
            steps: [{ argv: ['npm', 'install', '-g', `${PACKAGE}@latest`] }, { argv: [process.execPath, path.join(packageRoot, 'dist', 'cli.js'), 'update'], env }],
        };
    }
    return undefined;
}
const shown = (step) => step.argv.map((w) => (/[\s"']/.test(w) ? JSON.stringify(w) : w)).join(' ');
// Runs `steps` in turn, with the terminal, after it has checked that each
// program is on PATH. A step that fails stops the rest.
function runSteps(method, steps, dryRun) {
    const s = (0, styles_1.stylesFor)(process.stdout);
    say(s.pill('Update'), s.info(`${method} installed claude-gauge. ${dryRun ? 'Would run:' : 'Running:'}`), ...steps.map((step) => s.trace(s.value(shown(step)))));
    if (dryRun)
        return;
    const missing = steps.find((step) => !path.isAbsolute(step.argv[0]) && !onPath(step.argv[0]));
    if (missing)
        throw new MissingTool(`${missing.argv[0]} is not on PATH, so run ${shown(missing)} by hand.`);
    for (const step of steps) {
        const [program, ...rest] = step.argv;
        const r = (0, node_child_process_1.spawnSync)(program, rest, { stdio: 'inherit', env: { ...process.env, ...step.env }, shell: viaShell(program) });
        if (r.status !== 0)
            throw new Error(`${shown(step)} failed.`);
    }
}
// The scripts that the settings run, for update. scripts() goes by where this
// command runs from, so npx on a plugin or clone install would find no copy
// in runtime/: the launcher or the clone in the state folder names the tool.
function installedScripts() {
    const where = scripts();
    if (where.route !== 'copy' || fs.existsSync(path.join(where.dir, 'statusline.js')))
        return where;
    const launcher = path.join(stateDir(), 'launcher');
    if (fs.existsSync(path.join(launcher, 'statusline.js')))
        return { route: 'launcher', dir: launcher };
    if (fs.existsSync(path.join(stateDir(), '.git')))
        return { route: 'clone', dir: path.join(stateDir(), 'dist') };
    return where;
}
// Updates claude-gauge with the tool that installed it, as the settings run
// it: the plugin with Claude Code, an npx or global npm copy with npm. A git
// clone, like any checkout, is the user's to pull.
function update(dryRun) {
    const where = installedScripts();
    const { dir } = where;
    const s = (0, styles_1.stylesFor)(process.stdout);
    if (where.route === 'clone') {
        say(s.pill('Update'), s.info(`This claude-gauge is a git clone in ${s.value(stateDir())}. Update it with:`), s.trace(s.value(`git -C ${stateDir()} pull`)));
        return;
    }
    if (where.route === 'launcher') {
        runSteps('The Claude Code plugin', [{ argv: ['claude', 'plugin', 'update', PLUGIN] }], dryRun);
        if (!dryRun)
            say(s.ok(`Updated the plugin. The settings run ${s.value(dir)}, which runs the newest installed version, so the next new session runs it with no setup.`));
        return;
    }
    if (!fs.existsSync(path.join(dir, 'statusline.js'))) {
        throw new Error(`There is no copy of claude-gauge in ${dir} to update. Run claude-gauge setup first.`);
    }
    const fetch = copySteps();
    if (fetch) {
        runSteps(fetch.method, fetch.steps, dryRun);
        return;
    }
    if (dryRun) {
        say(s.pill('Update'), s.info(`Would copy claude-gauge ${s.value(version())} into ${s.value(dir)}.`));
        return;
    }
    copyRuntime(dir);
    say(s.pill('Update'), s.ok(`Updated claude-gauge in ${s.value(dir)} to ${s.value(version())}.`));
}
// An error on stderr: a red pill, then a red ✖ before the first line of
// `message` and a ↳ before each line after it.
function failure(message) {
    const s = (0, styles_1.stylesFor)(process.stderr);
    const [first, ...rest] = message.split('\n');
    return s.pill('Error', 'error') + s.error(first) + rest.map((line) => s.trace(line.trim())).join('');
}
async function main(argv) {
    try {
        // A bare claude-gauge gets the usage alone, as a mistake: exit 2.
        if (!argv.length) {
            process.stderr.write(usage(process.stderr));
            return 2;
        }
        const args = parseArgs(argv);
        if (args.help) {
            process.stdout.write(usage(process.stdout));
            return 0;
        }
        if (!args.command)
            throw new UsageError('Name a command.');
        switch (args.command) {
            case 'setup':
                await setup(args);
                break;
            case 'configure':
                await configure(args);
                break;
            case 'uninstall':
                uninstall();
                break;
            case 'update':
                update(args.dryRun);
                break;
        }
        return 0;
    }
    catch (err) {
        if (err instanceof UsageError) {
            process.stderr.write(`${failure(err.message)}\n${usage(process.stderr)}`);
            return 2;
        }
        if (err instanceof MissingTool) {
            process.stderr.write(failure(err.message));
            return 2;
        }
        process.stderr.write(failure(err.message));
        return 1;
    }
}
main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
});
