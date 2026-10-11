// The settings writer's pure half: plan() takes the settings Claude Code
// reads and the user's choices, and returns the next settings, the status
// line to save for uninstall, and what it found. It reads no file and writes
// none; settings-file.ts and the CLI do that.
//
// claude-gauge owns at most three things in settings.json: `statusLine` when
// it runs claude-gauge's status line, its token line entry in `hooks.Stop`,
// and the `--instruct` entries in `hooks.SessionStart`. plan() changes only
// those, and keeps every other key, including the status line's
// `refreshInterval`.

type Json = Record<string, unknown>;

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

interface StatusLineSetting {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

// Who runs the status line now. claude-hud is a common status line plugin
// that the setup names when it offers to replace one.
type Owner = 'none' | 'claude-gauge' | 'claude-hud' | 'other';

// One value per bar: `statusLine` for the status line, `tokenLine` for the
// token line. Every type that pairs the two bars is built from this one, so
// a bar added later changes this one type; the code that names each bar by
// hand, such as installedSwitches() and the CLI's apply(), still changes
// too. The token line's type defaults to the status line's; the wizard
// gives it a second one.
type PerBar<T, U = T> = { statusLine?: T; tokenLine?: U };

// The command to run as the status line, and the token line's Stop hook
// command. For each, null takes claude-gauge's out (and, for the status line,
// puts back `previous`); undefined leaves the bar as it is.
interface Choices extends PerBar<string | null> {
  // Consent to replace a status line that is not claude-gauge's.
  replace?: boolean;
  // Take out everything of claude-gauge's: the status line, and its hooks
  // in every event, the --instruct ones included.
  uninstall?: boolean;
  // The status line claude-gauge replaced, as the backup saved it. null when
  // there was none.
  previous?: StatusLineSetting | null;
}

interface Plan {
  settings: Json;
  // The status line to save for uninstall. Set only when claude-gauge takes
  // the status line over, so a re-run keeps the first one saved.
  backup?: { statusLine: StatusLineSetting | null };
  // The saved status line has done its work: forget it.
  dropBackup: boolean;
  found: Owner;
  // The status line is not claude-gauge's and `replace` was not given, so
  // nothing changes.
  blocked: boolean;
  changed: boolean;
}

// A command that runs one of claude-gauge's scripts, wherever the copy lives:
// ~/.claude/claude-gauge/dist/, its runtime/ copy, the scripts from before
// they moved into dist/, or a Windows path to any of them. The folder name
// must be a whole path component and the script name must end the word, so
// not-claude-gauge/ or statusline.js.old is someone else's.
const SCRIPT = /(?<![^\s'"\\/])claude-gauge[\\/](?:[^\s'"]*[\\/])?(statusline|tokenline)\.js(?![^\s'"])/;

const scriptOf = (command: unknown) => (typeof command === 'string' ? SCRIPT.exec(command)?.[1] : undefined);
const isInstruct = (command: unknown) => typeof command === 'string' && /(?:^|\s)--instruct\b/.test(command);

// The token line's Stop hook, as opposed to its --instruct SessionStart one.
const isTokenLine = (h: HookCommand) => scriptOf(h.command) === 'tokenline' && !isInstruct(h.command);
const isOurs = (h: HookCommand) => scriptOf(h.command) !== undefined;

// Whether writing claude-gauge's status line over this owner's replaces
// someone else's, which needs the user's consent.
const isForeign = (owner: Owner) => owner === 'other' || owner === 'claude-hud';

function ownerOf(statusLine: unknown): Owner {
  if (statusLine === undefined || statusLine === null) return 'none';
  const command = (statusLine as StatusLineSetting).command;
  if (scriptOf(command) === 'statusline') return 'claude-gauge';
  if (typeof command === 'string' && /claude-hud/i.test(command)) return 'claude-hud';
  return 'other';
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// The settings' hooks, checked as far as plan() reads them. A shape it does
// not know stops the plan, because writing over it would lose the user's
// hooks.
function readHooks(settings: Json): Record<string, HookEntry[]> | undefined {
  const hooks = settings.hooks;
  if (hooks === undefined) return undefined;
  if (!isObject(hooks)) throw new Error('settings.json: hooks is not an object, so claude-gauge leaves it alone. Fix it by hand.');
  for (const [event, entries] of Object.entries(hooks)) {
    const readable = (e: unknown) => isObject(e) && (e.hooks === undefined || (Array.isArray(e.hooks) && e.hooks.every(isObject)));
    if (!Array.isArray(entries) || !entries.every(readable)) {
      throw new Error(`settings.json: hooks.${event} is not a list of hook entries, so claude-gauge leaves it alone. Fix it by hand.`);
    }
  }
  return hooks as Record<string, HookEntry[]>;
}

// Takes the hook commands that `drop` matches out of `event`, then any entry
// and event that this left empty. Lists that were empty before stay.
function removeHooks(hooks: Record<string, HookEntry[]>, event: string, drop: (h: HookCommand) => boolean): void {
  const entries = hooks[event];
  if (!entries) return;
  let removed = false;
  const kept: HookEntry[] = [];
  for (const e of entries) {
    const commands = e.hooks ?? [];
    const left = commands.filter((h) => !drop(h));
    if (left.length === commands.length) {
      kept.push(e);
      continue;
    }
    removed = true;
    if (left.length) kept.push({ ...e, hooks: left });
  }
  if (!removed) return;
  if (kept.length) hooks[event] = kept;
  else delete hooks[event];
}

// Points the token line's Stop hook at `command`: the first existing one is
// updated in place, any others are removed, and with none an entry is added
// at the end.
function setTokenLine(hooks: Record<string, HookEntry[]>, command: string): void {
  const stop = hooks.Stop ?? [];
  let done = false;
  const next: HookEntry[] = [];
  for (const e of stop) {
    const commands = e.hooks ?? [];
    if (!commands.some(isTokenLine)) {
      next.push(e);
      continue;
    }
    const left: HookCommand[] = [];
    for (const h of commands) {
      if (!isTokenLine(h)) left.push(h);
      else if (!done) {
        left.push({ ...h, type: 'command', command });
        done = true;
      }
    }
    if (left.length) next.push({ ...e, hooks: left });
  }
  if (!done) next.push({ hooks: [{ type: 'command', command }] });
  hooks.Stop = next;
}

function plan(current: Json, choices: Choices): Plan {
  const settings: Json = JSON.parse(JSON.stringify(current ?? {}));
  const found = ownerOf(settings.statusLine);
  if (settings.statusLine === null) delete settings.statusLine;
  if (settings.statusLine !== undefined && !isObject(settings.statusLine)) {
    throw new Error('settings.json: statusLine is not an object, so claude-gauge leaves it alone. Fix it by hand.');
  }
  const hooks = readHooks(settings);

  const statusChoice = choices.uninstall ? null : choices.statusLine;
  const tokenChoice = choices.uninstall ? null : choices.tokenLine;

  const takeOver = typeof statusChoice === 'string' && isForeign(found);
  if (takeOver && !choices.replace) {
    return { settings, dropBackup: false, found, blocked: true, changed: false };
  }

  let backup: Plan['backup'];
  if (typeof statusChoice === 'string') {
    if (found !== 'claude-gauge') {
      backup = { statusLine: (settings.statusLine as StatusLineSetting | undefined) ?? null };
    }
    settings.statusLine = { ...(settings.statusLine as StatusLineSetting | undefined), type: 'command', command: statusChoice };
  } else if (statusChoice === null && found === 'claude-gauge') {
    if (choices.previous) settings.statusLine = choices.previous;
    else delete settings.statusLine;
  }

  if (tokenChoice !== undefined || choices.uninstall) {
    const next = hooks ?? {};
    if (typeof tokenChoice === 'string') setTokenLine(next, tokenChoice);
    else if (choices.uninstall) for (const event of Object.keys(next)) removeHooks(next, event, isOurs);
    else removeHooks(next, 'Stop', isTokenLine);
    // A hooks object that held only claude-gauge's entries goes with them.
    // One that was absent, or empty already, stays as it was.
    const hadHooks = isObject(current?.hooks) && Object.keys(current.hooks).length > 0;
    if (Object.keys(next).length) settings.hooks = next;
    else if (hadHooks) delete settings.hooks;
  }

  return {
    settings,
    ...(backup ? { backup } : {}),
    dropBackup: statusChoice === null,
    found,
    blocked: false,
    changed: JSON.stringify(settings) !== JSON.stringify(current ?? {}),
  };
}

// claude-gauge's commands in the settings: the status line, the token
// line's Stop hook, and whether any hook in any event runs one of its
// scripts. Hooks it cannot read stop it, as they stop plan().
function installed(settings: Json): PerBar<string> & { any: boolean } {
  const statusLine = ownerOf(settings.statusLine) === 'claude-gauge' ? (settings.statusLine as StatusLineSetting).command : undefined;
  const hooks = readHooks(settings) ?? {};
  const commandsIn = (entries: HookEntry[]) => entries.flatMap((e) => e.hooks ?? []);
  const tokenLine = commandsIn(hooks.Stop ?? []).find(isTokenLine)?.command;
  const anyHook = Object.values(hooks).some((entries) => commandsIn(entries).some(isOurs));
  return { statusLine, tokenLine, any: statusLine !== undefined || anyHook };
}

// The switches of each claude-gauge bar in the settings, as words:
// undefined for a bar that is not set up.
type InstalledSwitches = PerBar<string[]>;

function installedSwitches(settings: Json): InstalledSwitches {
  const { statusLine, tokenLine } = installed(settings);
  return {
    ...(statusLine === undefined ? {} : { statusLine: switchesOf(statusLine) }),
    ...(tokenLine === undefined ? {} : { tokenLine: switchesOf(tokenLine) }),
  };
}

// A shell word for a settings command: as is when plain, in double quotes
// when it holds only spaces or other characters both bash and cmd.exe read
// literally there, else in single quotes. Claude Code runs the command
// through a shell on every OS.
const shellWord = (s: string) =>
  /^[\w@%+=:,./~-]+$/.test(s) ? s : /^[^"$`\\!']*$/.test(s) ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;

// The command that runs `script` with the switches the user chose, as words,
// which keeps a value that holds a space. Each word is quoted on its own, so
// nothing in it can run as a second command.
function commandFor(script: string, switches: readonly string[] = []): string {
  return ['node', script.replace(/\\/g, '/'), ...switches].map(shellWord).join(' ');
}

// The words of a command as the shell splits them, which undoes shellWord:
// single quotes keep everything, double quotes keep all but an escaped " \ $
// or `, and a backslash outside quotes keeps the next character. Each word
// keeps its text as written too, `raw`, where a Windows path still has its
// backslashes.
function shellWords(command: string): { value: string; raw: string }[] {
  const words: { value: string; raw: string }[] = [];
  let value = '';
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else value += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) value += command[++i];
      else value += c;
    } else if (/\s/.test(c)) {
      if (start >= 0) words.push({ value, raw: command.slice(start, i) });
      value = '';
      start = -1;
    } else {
      if (start < 0) start = i;
      if (c === "'" || c === '"') quote = c;
      else if (c === '\\' && i + 1 < command.length) value += command[++i];
      else value += c;
    }
  }
  if (start >= 0) words.push({ value, raw: command.slice(start) });
  return words;
}

// The switches a claude-gauge command runs its script with, as words: the
// inverse of commandFor. None when the command runs no claude-gauge script.
function switchesOf(command: string): string[] {
  const words = shellWords(command);
  const at = words.findIndex((w) => scriptOf(w.raw) !== undefined);
  return at < 0 ? [] : words.slice(at + 1).map((w) => w.value);
}

export { plan, commandFor, switchesOf, installed, installedSwitches, ownerOf, scriptOf, isForeign };

export type { PerBar, Choices, Plan, Owner, StatusLineSetting, InstalledSwitches };
