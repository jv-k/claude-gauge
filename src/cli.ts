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
// scripts in runtime/, and the status line it replaced in .state/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { plan, commandFor, ownerOf, scriptOf } from './settings';
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

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, replace: false, yes: false };
  const seen: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].split(/=(.*)/s);
    // A value is the next word whatever it holds, since switches start with --.
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${name} needs a value: the switches for that bar, or "" for none.`);
      return v;
    };
    if (!name.startsWith('-')) {
      if (args.command) throw new UsageError(`Unexpected word: ${name}`);
      if (name === 'help') args.help = true;
      else if ((COMMANDS as readonly string[]).includes(name)) args.command = name as Command;
      else throw new UsageError(`Unknown command: ${name}`);
      continue;
    }
    seen.push(name);
    switch (name) {
      case '--help': case '-h': args.help = true; break;
      case '--status-line': args.statusLine = value(); break;
      case '--no-status-line': args.statusLine = null; break;
      case '--token-line': args.tokenLine = value(); break;
      case '--no-token-line': args.tokenLine = null; break;
      case '--replace': args.replace = true; break;
      case '--yes': case '-y': args.yes = true; break;
      default: throw new UsageError(`Unknown switch: ${name}`);
    }
  }
  const allowed: Record<Command, string[]> = {
    setup: ['--status-line', '--no-status-line', '--token-line', '--no-token-line', '--replace', '--yes', '-y'],
    configure: ['--status-line', '--no-status-line', '--token-line', '--no-token-line', '--replace'],
    uninstall: [],
    update: [],
  };
  const stray = args.command && seen.find((s) => s !== '--help' && s !== '-h' && !allowed[args.command!].includes(s));
  if (stray) throw new UsageError(`${args.command} takes no ${stray}`);
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

// Where the settings' commands point. A git clone in the state folder runs
// from its own dist/, which `git pull` updates, named by its path in the
// config folder rather than the resolved one. Any other copy, such as the
// npx cache, which npm prunes, is copied into the state folder's runtime/.
function scripts(): { dir: string; copy: boolean } {
  if (sameFolder(packageRoot, stateDir())) return { dir: path.join(stateDir(), 'dist'), copy: false };
  return { dir: path.join(stateDir(), 'runtime'), copy: true };
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
  const pkg = { name: 'claude-gauge-runtime', version: version(), private: true, type: 'commonjs' };
  writeAtomic(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

// The status line claude-gauge replaced: undefined when none is saved, null
// when there was none to replace.
function savedStatusLine(): StatusLineSetting | null | undefined {
  try {
    return (JSON.parse(fs.readFileSync(savedStatusLineFile(), 'utf8')) as { statusLine: StatusLineSetting | null }).statusLine;
  } catch {
    return undefined;
  }
}

const say = (...lines: string[]) => process.stdout.write(lines.join('\n') + '\n');

// claude-gauge's commands in the settings: the status line, and the token
// line's Stop hook.
function ourCommands(settings: Record<string, unknown>): { statusLine?: string; tokenLine?: string; any: boolean } {
  const statusLine = ownerOf(settings.statusLine) === 'claude-gauge' ? (settings.statusLine as StatusLineSetting).command : undefined;
  const all: string[] = [];
  const hooks = settings.hooks as Record<string, { hooks?: { command?: string }[] }[]> | undefined;
  for (const entries of Object.values(hooks ?? {})) {
    for (const e of Array.isArray(entries) ? entries : []) for (const h of e?.hooks ?? []) if (scriptOf(h?.command)) all.push(h.command!);
  }
  const tokenLine = (hooks?.Stop ?? []).flatMap((e) => e.hooks ?? []).find((h) => scriptOf(h.command) === 'tokenline')?.command;
  return { statusLine, tokenLine, any: statusLine !== undefined || all.length > 0 };
}

// setup and configure: turns the bars' switches into commands, plans the
// settings, and writes them.
function apply(args: Args, { statusLine, tokenLine }: Pick<Args, 'statusLine' | 'tokenLine'>, mustExist: boolean): void {
  const file = settingsFile();
  const { settings, text } = readSettings(file);
  if (mustExist && !ourCommands(settings).any) {
    throw new Error(`claude-gauge is not set up in ${file}. Run claude-gauge setup first.`);
  }
  const { dir, copy } = scripts();
  const command = (script: string, switches: string | null | undefined) =>
    typeof switches === 'string' ? commandFor(path.join(dir, script), switches) : switches;
  const choices: Choices = {
    statusLine: command('statusline.js', statusLine),
    tokenLine: command('tokenline.js', tokenLine),
    replace: args.replace,
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
  if (copy && (typeof choices.statusLine === 'string' || typeof choices.tokenLine === 'string')) copyRuntime(dir);
  // The status line to put back is saved before the settings change, so a
  // failed save leaves nothing to restore wrongly.
  if (next.backup) writeAtomic(savedStatusLineFile(), JSON.stringify(next.backup, null, 2) + '\n');
  const backup = next.changed ? writeSettings(file, next.settings, text) : null;
  if (next.dropBackup) fs.rmSync(savedStatusLineFile(), { force: true });

  if (!next.changed) {
    say(`${file} already holds these choices. Nothing to change.`);
    return;
  }
  const ours = ourCommands(next.settings);
  say(
    `Status line: ${ours.statusLine ?? 'not set up'}`,
    `Token line:  ${ours.tokenLine ?? 'not set up'}`,
    ...(backup ? [`Backup of the previous settings: ${backup}`] : []),
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
  apply(args, { statusLine: orDefault(args.statusLine), tokenLine: orDefault(args.tokenLine) }, false);
}

function configure(args: Args): void {
  if (args.statusLine === undefined && args.tokenLine === undefined) {
    throw new UsageError('Say what to change: --status-line, --token-line, --no-status-line or --no-token-line.');
  }
  apply(args, args, true);
}

function uninstall(): void {
  const file = settingsFile();
  const { settings, text } = readSettings(file);
  const saved = savedStatusLine();
  const next = plan(settings, { uninstall: true, previous: saved ?? null });
  fs.rmSync(savedStatusLineFile(), { force: true });
  if (!next.changed) {
    say(`claude-gauge is not in ${file}. Nothing to change.`);
    return;
  }
  const backup = writeSettings(file, next.settings, text);
  const restored = next.found === 'claude-gauge' && saved ? `Put back the previous status line: ${saved.command ?? JSON.stringify(saved)}` : undefined;
  say(
    `Took claude-gauge out of ${file}.`,
    ...(restored ? [restored] : []),
    ...(backup ? [`Backup of the previous settings: ${backup}`] : []),
    `The scripts stay in ${stateDir()}. Delete that folder to remove them too.`,
    'Start a new Claude Code session to pick up the changes.',
  );
}

function update(): void {
  const { dir, copy } = scripts();
  if (!copy) {
    say(`This claude-gauge is a git clone in ${stateDir()}. Update it with:`, `  git -C ${stateDir()} pull`);
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
