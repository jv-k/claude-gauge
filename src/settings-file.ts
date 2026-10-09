// The settings writer's file half: reads settings.json, and writes it back
// atomically, through a symlink to its target, after a timestamped backup.
// What to write is plan()'s job, in settings.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';

type Json = Record<string, unknown>;

interface SettingsFile {
  settings: Json;
  // The file as read, or null when there was none. Its layout guides the
  // write, so a hand-formatted file keeps its indent and line ends.
  text: string | null;
}

// Reads settings.json. A missing or empty file reads as {}. A file that is
// not a JSON object stops the write: claude-gauge never guesses at a file it
// cannot read.
function readSettings(file: string): SettingsFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, text: null };
    throw err;
  }
  if (!text.trim()) return { settings: {}, text };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}), so claude-gauge leaves it alone. Fix it by hand.`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${file} does not hold a JSON object, so claude-gauge leaves it alone. Fix it by hand.`);
  }
  return { settings: settings as Json, text };
}

// The file a write to `file` should replace: the target of a symlink, even
// one whose target does not exist yet, or the file itself. Replacing the
// link instead would cut it from a dotfiles repository.
function targetOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      return path.resolve(path.dirname(file), fs.readlinkSync(file));
    } catch {
      return file;
    }
  }
}

// Windows refuses a rename over a file that another program has open for a
// moment, so a rename there gets a few short retries.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 5 || !BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      pause(50 * attempt);
    }
  }
}

// Writes `text` to `file` so that a reader sees the old file or the new one,
// never part of either: a temporary file beside the target, flushed, then
// renamed over it. The target keeps its permissions.
function writeAtomic(file: string, text: string | Buffer): void {
  const target = targetOf(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* a new file takes the default permissions */
  }
  try {
    const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// 2026-10-09T00-07-18-123Z: an ISO time with no colons, which Windows
// forbids in file names.
const stamp = (d: Date) => d.toISOString().replace(/:/g, '-').replace('.', '-');

// Copies `file` to a timestamped backup beside it, beside the link when it is
// one, and returns the backup's path; null when there is no file to back up.
function backUp(file: string, now = new Date()): string | null {
  if (!fs.existsSync(file)) return null;
  const base = `${file}.claude-gauge-${stamp(now)}`;
  for (let n = 0; ; n++) {
    const backup = n ? `${base}-${n}.bak` : `${base}.bak`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

// The new file's text in the old file's layout: its indent and line ends,
// else two spaces and \n.
function format(settings: Json, previous: string | null): string {
  const indent = (previous && /^[ \t]+(?=")/m.exec(previous)?.[0]) || 2;
  const text = JSON.stringify(settings, null, indent) + '\n';
  return previous?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

// Backs settings.json up, then writes `settings` over it. Returns the
// backup's path, or null when there was no file before.
function writeSettings(file: string, settings: Json, previous: string | null): string | null {
  const backup = backUp(file);
  writeAtomic(file, format(settings, previous));
  return backup;
}

export { readSettings, writeSettings, writeAtomic };

export type { SettingsFile };
