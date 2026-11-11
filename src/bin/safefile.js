// Safe saving for the integration's settings files.
// A save writes a temporary file, flushes it to disk and then swaps it in, so a file is never left
// half-written if the hub or the remote stops mid-save. The version before each save is kept as
// <file>.bak; if a file can't be read or parsed, the .bak is used instead (and a warning logged), so
// a damaged file never turns into an empty setup that the next save would write over your settings.
import fs from "node:fs";
import path from "node:path";

const say = (...a) => console.warn(new Date().toISOString(), "[self-control] WARN", ...a);

/** Writes text or a Buffer to file atomically, keeping the previous version as file.bak. */
export function writeText(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { // only a good copy becomes the backup: a damaged file never replaces a good .bak
    const cur = fs.readFileSync(file);
    if (cur.length && (!file.endsWith(".json") || JSON.parse(cur.toString("utf8")) !== undefined)) fs.copyFileSync(file, `${file}.bak`);
  } catch {}
  fs.renameSync(tmp, file);
}

/** Writes obj as JSON (see writeText). */
export const writeJson = (file, obj, space) => writeText(file, JSON.stringify(obj, null, space));

/** Reads a file as text, falling back to file.bak. Throws (like fs.readFileSync) when neither can be read. */
export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    try {
      const t = fs.readFileSync(`${file}.bak`, "utf8");
      if (e.code !== "ENOENT") say(`couldn't read ${path.basename(file)} (${e.message}); using the backup copy`);
      return t;
    } catch {
      throw e;
    }
  }
}

/** Reads and parses a JSON file; a missing, unreadable or damaged file falls back to file.bak. Throws when neither works. */
export function readJson(file) {
  let err;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    err = e;
  }
  try {
    const d = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
    if (err.code !== "ENOENT") say(`${path.basename(file)} couldn't be read (${err.message}); using the backup copy`);
    return d;
  } catch {
    if (err.code !== "ENOENT") { // damaged and no usable backup: keep a copy so the next save can't erase it
      try { fs.copyFileSync(file, `${file}.damaged-${Date.now()}`); say(`${path.basename(file)} couldn't be read (${err.message}); a copy was kept as ${path.basename(file)}.damaged-…`); } catch {}
    }
    throw err;
  }
}

/** True if file (or its backup) exists. */
export const exists = (file) => fs.existsSync(file) || fs.existsSync(`${file}.bak`);

/** Removes file, its backup and any temporary file. */
export function remove(file) {
  for (const f of [file, `${file}.bak`, `${file}.tmp`]) fs.rmSync(f, { force: true });
}

// Saves that can wait a moment: many changes in a row become one write. Anything still waiting is
// written when the integration stops (process "exit", also after SIGTERM / SIGINT → process.exit).
const pending = new Set();
const DELAY = Number(process.env.UC_SELF_SAVE_DELAY_MS ?? 2000);
/** Returns { schedule(), flush() }: schedule() runs write() once, DELAY ms after the first call. */
export function saveLater(write, ms = DELAY) {
  let timer = null;
  const run = () => { clearTimeout(timer); timer = null; pending.delete(run); write(); };
  return {
    schedule() {
      if (ms <= 0) return write();
      if (timer) return;
      pending.add(run);
      timer = setTimeout(run, ms);
      timer.unref?.();
    },
    flush() { if (timer) run(); }
  };
}
/** Writes every save that is still waiting. */
export function flushSaves() { for (const run of [...pending]) { try { run(); } catch {} } }
process.once("exit", flushSaves);
