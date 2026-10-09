#!/usr/bin/env node

// The claude-gauge command: sets the bars up in Claude Code's settings,
// changes their switches, takes them out again, and updates the copy of the
// scripts that the settings run.
//
//   claude-gauge setup --yes
//   claude-gauge setup --status-line "--show ctx,5h,7d --segments 10" --token-line "--window 1m"
//   claude-gauge configure --no-token-line
//   claude-gauge uninstall
//   claude-gauge update
//
// This is the non-interactive form, which the plugin's slash commands run
// once Claude has asked the questions. The interactive wizard comes later.
//
// Everything it keeps lives in the state folder, claude-gauge/ in the Claude
// config folder ($CLAUDE_CONFIG_DIR, else ~/.claude): the copy of the
// scripts in runtime/, or, when it runs from the plugin, the launcher in
// launcher/, and the status line it replaced in .state/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { plan, commandFor, installed } from './settings';
import type { Choices, StatusLineSetting } from './settings';
import { readSettings, writeSettings, writeAtomic } from './settings-file';

const USAGE = `Usage: claude-gauge <setup | configure | uninstall | update> [switches]

  setup        add the status line and the token line to Claude Code's settings
  configure    change the switches of a bar that setup added, or take it out
  uninstall    take claude-gauge out, and put back the status line it replaced
  update       refresh the copy of claude-gauge that the settings run

Switches for setup and configure:
  --status-line <switches>   add the status line, run with these switches ("" for none)
  --no-status-line           leave the status line out
  --token-line <switches>    add the token line, run with these switches ("" for none)
  --no-token-line            leave the token line out
  --replace                  replace a status line that is not claude-gauge's
  --yes                      setup only: add each bar not chosen above, with no switches

The bars' switches are in README.md, under Options. The settings file is
$CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json.
`;

// A mistake in the command line: exit 2, with the usage.
class UsageError extends Error {}

const COMMANDS = ['setup', 'configure', 'uninstall', 'update'] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  command?: Command;
  help: boolean;
  statusLine?: string | null;
  tokenLine?: string | null;
  replace: boolean;
  yes: boolean;
}

// Every switch: its names, the commands that take it, and what it sets.
// --help goes with any command.
const SWITCHES: { names: string[]; commands: Command[]; apply: (args: Args, value: () => string) => void }[] = [
  { names: ['--status-line'], commands: ['setup', 'configure'], apply: (args, value) => { args.statusLine = value(); } },
  { names: ['--no-status-line'], commands: ['setup', 'configure'], apply: (args) => { args.statusLine = null; } },
  { names: ['--token-line'], commands: ['setup', 'configure'], apply: (args, value) => { args.tokenLine = value(); } },
  { names: ['--no-token-line'], commands: ['setup', 'configure'], apply: (args) => { args.tokenLine = null; } },
  { names: ['--replace'], commands: ['setup', 'configure'], apply: (args) => { args.replace = true; } },
  { names: ['--yes', '-y'], commands: ['setup'], apply: (args) => { args.yes = true; } },
  { names: ['--help', '-h'], commands: [...COMMANDS], apply: (args) => { args.help = true; } },
];

// Unlike the two bars, which ignore what they do not know so that a typo
// never blanks the status line, the command refuses an unknown word: it
// writes the user's settings, and a typo there should stop it.
function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, replace: false, yes: false };
  const seen: (typeof SWITCHES)[number][] = [];
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    if (!name.startsWith('-')) {
      if (args.command) throw new UsageError(`Unexpected word: ${name}`);
      if (name === 'help') args.help = true;
      else if ((COMMANDS as readonly string[]).includes(name)) args.command = name as Command;
      else throw new UsageError(`Unknown command: ${name}`);
      continue;
    }
    const known = SWITCHES.find((s) => s.names.includes(name));
    if (!known) throw new UsageError(`Unknown switch: ${name}`);
    // A value is the next word whatever it holds, since switches start with --.
    known.apply(args, () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${name} needs a value: the switches for that bar, or "" for none.`);
      return v;
    });
    seen.push(known);
  }
  const stray = args.command && seen.find((s) => !s.commands.includes(args.command!));
  if (stray) throw new UsageError(`${args.command} takes no ${stray.names[0]}`);
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

function sameFolder(a: string, b: string): boolean {
  try {
    const [x, y] = [fs.realpathSync(a), fs.realpathSync(b)];
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
}

// The folder that holds the plugin's installed versions, when this command
// runs from one of them: Claude Code installs a plugin into
// <plugins>/cache/<marketplace>/<plugin>/<version>/, with its manifest.
function pluginVersions(): string | undefined {
  const versions = path.dirname(packageRoot);
  const cache = path.dirname(path.dirname(versions));
  if (path.basename(cache) !== 'cache') return undefined;
  if (!fs.existsSync(path.join(packageRoot, '.claude-plugin', 'plugin.json'))) return undefined;
  return versions;
}

// How the settings' commands reach the scripts.
//   clone:    a git clone in the state folder runs from its own dist/, which
//             `git pull` updates, named by its path in the config folder
//             rather than the resolved one.
//   launcher: the plugin runs from the state folder's launcher/, which runs
//             the newest installed plugin version, so an update needs no
//             setup. `versions` is the folder that holds them.
//   copy:     any other copy, such as the npx cache, which npm prunes, is
//             copied into the state folder's runtime/.
type Scripts = { route: 'clone'; dir: string } | { route: 'launcher'; dir: string; versions: string } | { route: 'copy'; dir: string };

function scripts(): Scripts {
  if (sameFolder(packageRoot, stateDir())) return { route: 'clone', dir: path.join(stateDir(), 'dist') };
  const versions = pluginVersions();
  if (versions) return { route: 'launcher', dir: path.join(stateDir(), 'launcher'), versions };
  return { route: 'copy', dir: path.join(stateDir(), 'runtime') };
}

const version = (): string => {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

// Copies the two scripts into `dir`, each replaced whole, so a status line
// that runs during the copy reads the old script or the new one. The
// package.json beside them keeps Node reading them as CommonJS, whatever a
// package.json further up says.
function copyRuntime(dir: string): void {
  for (const file of RUNTIME) writeAtomic(path.join(dir, file), fs.readFileSync(path.join(packageRoot, 'dist', file)));
  writePackageJson(dir, 'claude-gauge-runtime');
}

function writePackageJson(dir: string, name: string): void {
  const pkg = { name, version: version(), private: true, type: 'commonjs' };
  writeAtomic(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

// Writes the launcher into `dir`: launch.js, and one entry file per script
// that runs it from the newest version in `versions`. The entry files keep
// the scripts' names, so the settings name statusline.js and tokenline.js
// as on every other route, and claude-gauge knows them as its own.
function writeLauncher(dir: string, versions: string): void {
  writeAtomic(path.join(dir, 'launch.js'), fs.readFileSync(path.join(packageRoot, 'dist', 'launcher.js')));
  for (const file of RUNTIME) {
    const entry = [
      '#!/usr/bin/env node',
      `// Written by claude-gauge setup: runs ${file} from the newest installed`,
      '// claude-gauge plugin, so a plugin update needs no setup.',
      `require('./launch.js').launch(${JSON.stringify(versions)}, ${JSON.stringify(file)});`,
      '',
    ].join('\n');
    writeAtomic(path.join(dir, file), entry);
  }
  writePackageJson(dir, 'claude-gauge-launcher');
}

// The status line claude-gauge replaced: undefined when none is saved, null
// when there was none to replace. Only a missing file means none is saved: a
// file it cannot read or parse stops the command, because going on would
// drop the only record of the status line to put back.
function savedStatusLine(): StatusLineSetting | null | undefined {
  const file = savedStatusLineFile();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}. Fix or delete it by hand.`);
  }
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    saved = undefined;
  }
  const statusLine = (saved as { statusLine?: unknown } | undefined)?.statusLine;
  if (typeof saved !== 'object' || saved === null || !(statusLine === null || (typeof statusLine === 'object' && !Array.isArray(statusLine)))) {
    throw new Error(`${file} does not hold a saved status line, so claude-gauge cannot tell what to put back. Fix or delete it by hand.`);
  }
  return statusLine as StatusLineSetting | null;
}

const say = (...lines: string[]) => process.stdout.write(lines.join('\n') + '\n');

// The switches chosen for each bar: a string to run it with, null to take it
// out, undefined to leave it as it is.
type Bars = Pick<Args, 'statusLine' | 'tokenLine'>;

// setup and configure: turns the bars' switches into commands, plans the
// settings, and writes them.
function apply({ statusLine, tokenLine }: Bars, replace: boolean): void {
  const file = settingsFile();
  const { settings, text } = readSettings(file);
  const where = scripts();
  const { dir } = where;
  const command = (script: string, switches: string | null | undefined) =>
    typeof switches === 'string' ? commandFor(path.join(dir, script), switches) : switches;
  const choices: Choices = {
    statusLine: command('statusline.js', statusLine),
    tokenLine: command('tokenline.js', tokenLine),
    replace,
    previous: savedStatusLine() ?? null,
  };
  const next = plan(settings, choices);
  if (next.blocked) {
    const current = (settings.statusLine as StatusLineSetting).command ?? JSON.stringify(settings.statusLine);
    const whose = next.found === 'claude-hud' ? "claude-hud's status line" : 'another status line';
    throw new Error(
      [
        `${file} already runs ${whose}:`,
        `  ${current}`,
        'Run again with --replace to replace it. claude-gauge saves it, and claude-gauge uninstall puts it back.',
      ].join('\n'),
    );
  }

  // The scripts go in first, so the settings never name a missing file.
  if (typeof choices.statusLine === 'string' || typeof choices.tokenLine === 'string') {
    if (where.route === 'copy') copyRuntime(dir);
    if (where.route === 'launcher') writeLauncher(dir, where.versions);
  }
  // The status line to put back is saved before the settings change, so a
  // failed save leaves nothing to restore wrongly.
  if (next.backup) writeAtomic(savedStatusLineFile(), JSON.stringify(next.backup, null, 2) + '\n');
  const settingsBackup = next.changed ? writeSettings(file, next.settings, text) : null;
  if (next.dropBackup) fs.rmSync(savedStatusLineFile(), { force: true });

  if (!next.changed) {
    say(`${file} already holds these choices. Nothing to change.`);
    return;
  }
  const ours = installed(next.settings);
  say(
    `Status line: ${ours.statusLine ?? 'not set up'}`,
    `Token line:  ${ours.tokenLine ?? 'not set up'}`,
    ...(settingsBackup ? [`Backup of the previous settings: ${settingsBackup}`] : []),
    'Start a new Claude Code session to pick up the changes.',
  );
}

function setup(args: Args): void {
  const chosen = args.statusLine !== undefined || args.tokenLine !== undefined;
  if (!chosen && !args.yes) {
    throw new UsageError(
      'The interactive setup is not built yet. Run claude-gauge setup --yes for both bars with no switches, or choose each bar with --status-line, --token-line, --no-status-line and --no-token-line.',
    );
  }
  const orDefault = (v: string | null | undefined) => (v === undefined && args.yes ? '' : v);
  apply({ statusLine: orDefault(args.statusLine), tokenLine: orDefault(args.tokenLine) }, args.replace);
}

function configure(args: Args): void {
  if (args.statusLine === undefined && args.tokenLine === undefined) {
    throw new UsageError('Say what to change: --status-line, --token-line, --no-status-line or --no-token-line.');
  }
  const file = settingsFile();
  if (!installed(readSettings(file).settings).any) {
    throw new Error(`claude-gauge is not set up in ${file}. Run claude-gauge setup first.`);
  }
  apply(args, args.replace);
}

function uninstall(): void {
  const file = settingsFile();
  const { settings, text } = readSettings(file);
  const saved = savedStatusLine();
  const next = plan(settings, { uninstall: true, previous: saved ?? null });
  // The saved status line goes only once the settings no longer need it, so
  // a failed write leaves it for the next try.
  const settingsBackup = next.changed ? writeSettings(file, next.settings, text) : null;
  fs.rmSync(savedStatusLineFile(), { force: true });
  if (!next.changed) {
    say(`claude-gauge is not in ${file}. Nothing to change.`);
    return;
  }
  const restored = next.found === 'claude-gauge' && saved ? `Put back the previous status line: ${saved.command ?? JSON.stringify(saved)}` : undefined;
  say(
    `Took claude-gauge out of ${file}.`,
    ...(restored ? [restored] : []),
    ...(settingsBackup ? [`Backup of the previous settings: ${settingsBackup}`] : []),
    `The scripts stay in ${stateDir()}. Delete that folder to remove them too.`,
    'Start a new Claude Code session to pick up the changes.',
  );
}

function update(): void {
  const where = scripts();
  const { dir } = where;
  if (where.route === 'clone') {
    say(`This claude-gauge is a git clone in ${stateDir()}. Update it with:`, `  git -C ${stateDir()} pull`);
    return;
  }
  if (where.route === 'launcher') {
    say(
      'This claude-gauge is the Claude Code plugin. Update it with /plugin in Claude Code.',
      `The settings run ${dir}, which runs the newest installed version, so an update needs no setup.`,
    );
    return;
  }
  if (!fs.existsSync(path.join(dir, 'statusline.js'))) {
    throw new Error(`There is no copy of claude-gauge in ${dir} to update. Run claude-gauge setup first.`);
  }
  copyRuntime(dir);
  say(`Updated claude-gauge in ${dir} to ${version()}.`);
}

function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!args.command) throw new UsageError('Name a command.');
    switch (args.command) {
      case 'setup': setup(args); break;
      case 'configure': configure(args); break;
      case 'uninstall': uninstall(); break;
      case 'update': update(); break;
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`claude-gauge: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`claude-gauge: ${(err as Error).message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
