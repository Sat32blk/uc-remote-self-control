// Smart Buttons: conditional rules evaluated by the driver.
//
// Rules JSON:
// {
//   "aliases": { "shield": "uc_androidtv_driver.main.YOUR_SHIELD_ID", ... },
//   "buttons": [
//     { "id": "smart_volume_up", "name": "Smart Volume Up",
//       "cases": [ { "if": COND, "do": [ACTION...] }, ..., { "else": [ACTION...] } ] }
//   ]
// }
// A button may also use the short form { "if": COND, "do": [...], "else": [...] }.
//
// COND:
//   { "entity": "shield", "attr": "state", "is": "PLAYING" }   (attr defaults to "state")
//     operators: is, is_not, in [..], not_in [..], ">", "<", ">=", "<=", contains
//   { "activity_on": "<activity id or alias>" }
//   { "time_between": ["22:00", "06:00"] }
//   { "var": "night", "is": "on" }                  (unset var = "")
//   { "setting": "button.brightness", ">": 30 }     (the remote's own settings, raw values)
//   { "control": "backlight_color", "is": "Amber" }  (this integration's controls: list option or on/off)
//   { "all": [COND...] } | { "any": [COND...] } | { "not": COND } | true
// ACTION:
//   { "cmd": "media_player.volume_up", "entity": "marantz", "params": { ... } }
//   { "cmd": "DIMMER_DIM", "entity": "receiver" }           simple command (sent as-is)
//   { "self": "backlight_color", "option": "Movie red" }   select of this integration
//     option may also be "next" / "previous" (wrap around) or "up" / "down" (stop at the ends)
//   { "self": "sound_effects", "state": "off" }             switch of this integration (on/off/toggle)
//   { "delay": 500 }                                        ms
//   { "wait_until": COND, "timeout": 8000, "on_timeout": "stop" | "continue" }
//   { "set_var": "night", "to": "on" }
//   { "save_settings": "night" } / { "restore_settings": "night" }
//     remember / put back the remote's backlight, display, sound and haptic settings
//   { "stop": true }

import fs from "node:fs";

export const LIMITS = { buttons: 30, cases: 8, actions: 12, delayMs: 30000, waitMs: 30000 };

const COMPARE_OPS = ["is", "is_not", "in", "not_in", ">", "<", ">=", "<=", "contains"];
const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function vCond(c, path, errs, ctx) {
  if (c === true) return;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    errs.push(`${path}: condition must be an object`);
    return;
  }
  if ("all" in c || "any" in c) {
    const k = "all" in c ? "all" : "any";
    if (!Array.isArray(c[k]) || c[k].length === 0) errs.push(`${path}.${k}: must be a non-empty list`);
    else c[k].forEach((x, i) => vCond(x, `${path}.${k}[${i}]`, errs, ctx));
    return;
  }
  if ("not" in c) return vCond(c.not, `${path}.not`, errs, ctx);
  if ("activity_on" in c) {
    if (typeof c.activity_on !== "string") errs.push(`${path}.activity_on: must be an activity id or alias`);
    return;
  }
  if ("time_between" in c) {
    const t = c.time_between;
    if (!Array.isArray(t) || t.length !== 2 || !t.every((x) => /^\d{1,2}:\d{2}$/.test(x))) {
      errs.push(`${path}.time_between: must be ["HH:MM","HH:MM"]`);
    }
    return;
  }
  const subject = ["entity", "var", "setting", "control"].filter((k) => k in c);
  if (subject.length !== 1) {
    errs.push(`${path}: needs exactly one of entity / var / setting / control / activity_on / time_between / all / any / not`);
    return;
  }
  if (typeof c[subject[0]] !== "string" || !c[subject[0]]) errs.push(`${path}.${subject[0]}: must be a text value`);
  const ops = COMPARE_OPS.filter((o) => o in c);
  if (ops.length !== 1) errs.push(`${path}: needs exactly one operator (${COMPARE_OPS.join(", ")})`);
  else if ((ops[0] === "in" || ops[0] === "not_in") && !Array.isArray(c[ops[0]])) errs.push(`${path}.${ops[0]}: must be a list`);
  if (c.entity && ctx && !ctx.resolvable(c.entity)) errs.push(`${path}.entity: unknown alias "${c.entity}"`);
  if (c.control && ctx && !ctx.selfKnown(c.control)) errs.push(`${path}.control: unknown control "${c.control}"`);
}

function vActions(list, path, errs, ctx) {
  if (!Array.isArray(list)) {
    errs.push(`${path}: must be a list of steps`);
    return;
  }
  if (list.length > LIMITS.actions) errs.push(`${path}: at most ${LIMITS.actions} steps`);
  list.forEach((a, i) => {
    const p = `${path}[${i}]`;
    if (!a || typeof a !== "object") return errs.push(`${p}: step must be an object`);
    if ("cmd" in a) {
      if (typeof a.cmd !== "string" || !a.cmd.trim() || a.cmd.length > 64) errs.push(`${p}.cmd: a command like "media_player.volume_up" or a simple command name`);
      if (typeof a.entity !== "string") errs.push(`${p}.entity: required`);
      else if (!ctx.resolvable(a.entity)) errs.push(`${p}.entity: unknown alias "${a.entity}"`);
      if (a.params !== undefined && (typeof a.params !== "object" || Array.isArray(a.params))) errs.push(`${p}.params: must be an object`);
    } else if ("self" in a) {
      if (!ctx.selfKnown(a.self)) errs.push(`${p}.self: unknown control "${a.self}"`);
      if (!("option" in a) && !("state" in a)) errs.push(`${p}: self step needs "option" (lists) or "state" (on/off/toggle)`);
    } else if ("delay" in a) {
      if (!(Number(a.delay) >= 0 && Number(a.delay) <= LIMITS.delayMs)) errs.push(`${p}.delay: 0..${LIMITS.delayMs} ms`);
    } else if ("wait_until" in a) {
      vCond(a.wait_until, `${p}.wait_until`, errs, ctx);
      if (a.timeout !== undefined && !(Number(a.timeout) > 0 && Number(a.timeout) <= LIMITS.waitMs)) errs.push(`${p}.timeout: 1..${LIMITS.waitMs} ms`);
    } else if ("save_settings" in a || "restore_settings" in a) {
      const n = a.save_settings ?? a.restore_settings;
      if (typeof n !== "string" || !n) errs.push(`${p}: save_settings / restore_settings needs a name`);
    } else if ("set_var" in a) {
      if (typeof a.set_var !== "string" || !a.set_var) errs.push(`${p}.set_var: variable name`);
      if (!("to" in a)) errs.push(`${p}: set_var needs "to"`);
    } else if (!("stop" in a)) {
      errs.push(`${p}: unknown step (use cmd, self, delay, wait_until, set_var, save_settings, restore_settings or stop)`);
    }
  });
}

/** Returns { errors: [], rules } with buttons normalised to the "cases" form. */
export function validateRules(input, selfKeys = []) {
  const errs = [];
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      return { errors: [`Not valid JSON: ${e.message}`], rules: null };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { errors: ["Top level must be an object with \"buttons\""], rules: null };
  const aliases = obj.aliases || {};
  if (typeof aliases !== "object" || Array.isArray(aliases)) errs.push("aliases: must be an object");
  const ctx = {
    resolvable: (x) => x in aliases || x.includes("."),
    selfKnown: (x) => selfKeys.length === 0 || selfKeys.includes(x)
  };
  const buttons = obj.buttons;
  if (!Array.isArray(buttons)) return { errors: [...errs, "buttons: must be a list"], rules: null };
  if (buttons.length > LIMITS.buttons) errs.push(`buttons: at most ${LIMITS.buttons}`);
  const seen = new Set();
  const norm = buttons.map((b, i) => {
    const p = `buttons[${i}]`;
    if (!b || typeof b !== "object") {
      errs.push(`${p}: must be an object`);
      return null;
    }
    if (!ID_RE.test(b.id || "")) errs.push(`${p}.id: lower-case letters, digits, _ (2–41 chars, starts with a letter)`);
    else if (seen.has(b.id)) errs.push(`${p}.id: duplicate "${b.id}"`);
    seen.add(b.id);
    if (typeof b.name !== "string" || !b.name.trim()) errs.push(`${p}.name: required`);
    let cases = b.cases;
    if (!cases && ("if" in b || "do" in b)) {
      cases = [{ if: b.if ?? true, do: b.do || [] }];
      if (b.else) cases.push({ else: b.else });
    }
    if (!Array.isArray(cases) || cases.length === 0) {
      errs.push(`${p}: needs "cases" (or "if"/"do"/"else")`);
      return null;
    }
    if (cases.length > LIMITS.cases) errs.push(`${p}.cases: at most ${LIMITS.cases}`);
    cases.forEach((c, j) => {
      const cp = `${p}.cases[${j}]`;
      if (c && "else" in c) {
        if (j !== cases.length - 1) errs.push(`${cp}: "else" must be the last case`);
        vActions(c.else, `${cp}.else`, errs, ctx);
      } else if (c && "do" in c) {
        vCond(c.if ?? true, `${cp}.if`, errs, ctx);
        vActions(c.do, `${cp}.do`, errs, ctx);
      } else {
        errs.push(`${cp}: needs "if" + "do", or "else"`);
      }
    });
    return { id: b.id, name: b.name, cases };
  });
  return { errors: errs, rules: errs.length ? null : { aliases, buttons: norm } };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.+-]/g, "")));
const norm = (v) => (v === undefined || v === null ? "" : String(v)).trim().toUpperCase();

function compare(actual, c) {
  if ("is" in c) return norm(actual) === norm(c.is);
  if ("is_not" in c) return norm(actual) !== norm(c.is_not);
  if ("in" in c) return c.in.map(norm).includes(norm(actual));
  if ("not_in" in c) return !c.not_in.map(norm).includes(norm(actual));
  if ("contains" in c) return norm(actual).includes(norm(c.contains));
  const a = toNum(actual);
  if (Number.isNaN(a)) return false;
  if (">" in c) return a > toNum(c[">"]);
  if ("<" in c) return a < toNum(c["<"]);
  if (">=" in c) return a >= toNum(c[">="]);
  if ("<=" in c) return a <= toNum(c["<="]);
  return false;
}

function inTimeWindow([from, to], now = new Date()) {
  const m = (s) => {
    const [h, mi] = s.split(":").map(Number);
    return h * 60 + mi;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = m(from);
  const b = m(to);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b; // window may cross midnight
}

export class SmartEngine {
  /**
   * @param {object} o
   * @param {() => object} o.core        returns the CoreClient (or null)
   * @param {object} o.self              { keys: string[], read(path), run(key, step) }
   * @param {string} o.varsFile          where variables are persisted
   * @param {(text: string) => void} o.report  last-result reporter
   * @param {Function} o.log
   */
  constructor({ core, self, varsFile, report, log }) {
    this.core = core;
    this.self = self;
    this.varsFile = varsFile;
    this.report = report || (() => {});
    this.log = log || (() => {});
    this.rules = { aliases: {}, buttons: [] };
    this.vars = {};
    this.running = new Set();
    try {
      this.vars = JSON.parse(fs.readFileSync(varsFile, "utf8"));
    } catch {
      this.vars = {};
    }
  }

  load(input) {
    const res = validateRules(input, this.self.keys);
    if (!res.errors.length) this.rules = res.rules;
    return res;
  }

  get buttons() {
    return this.rules.buttons;
  }

  resolve(x) {
    return this.rules.aliases[x] || x;
  }

  saveVars() {
    try {
      fs.writeFileSync(this.varsFile, JSON.stringify(this.vars));
    } catch (e) {
      this.log("could not save smart-button variables:", e.message);
    }
  }

  async entityAttrs(id, cache) {
    if (cache && cache.has(id)) return cache.get(id);
    const core = this.core();
    if (!core) throw new Error("not connected to the remote");
    const e = await core.get(`/entities/${encodeURI(id)}`);
    const attrs = (e && e.attributes) || {};
    this.rememberName(id, e?.name);
    if (cache) cache.set(id, attrs);
    return attrs;
  }

  rememberName(id, name) {
    this.names = this.names || {};
    const n = name && typeof name === "object" ? name.en || Object.values(name)[0] : name;
    if (n) this.names[id] = String(n);
  }

  /** Device name for summaries (falls back to the alias or id). */
  async displayName(ref) {
    const id = this.resolve(ref);
    this.names = this.names || {};
    if (!(id in this.names)) {
      this.names[id] = "";
      try {
        const e = await this.core()?.get(`/entities/${encodeURI(id)}`);
        this.rememberName(id, e?.name);
      } catch {}
    }
    return this.names[id] || ref;
  }

  async test(c, cache) {
    if (c === true || c === undefined) return true;
    if (c.all) {
      for (const x of c.all) if (!(await this.test(x, cache))) return false;
      return true;
    }
    if (c.any) {
      for (const x of c.any) if (await this.test(x, cache)) return true;
      return false;
    }
    if (c.not) return !(await this.test(c.not, cache));
    if (c.time_between) return inTimeWindow(c.time_between);
    if (c.activity_on) {
      const a = await this.entityAttrs(this.resolve(c.activity_on), cache);
      return ["ON", "RUNNING"].includes(norm(a.state));
    }
    if (c.var) return compare(this.vars[c.var] ?? "", c);
    if (c.setting) return compare(this.self.read(c.setting), c);
    if (c.control) return compare(this.self.control(c.control), c);
    const attrs = await this.entityAttrs(this.resolve(c.entity), cache);
    return compare(attrs[c.attr || "state"], c);
  }

  async step(a, trail) {
    if (a.cmd) {
      const id = this.resolve(a.entity);
      const core = this.core();
      if (!core) throw new Error("not connected to the remote");
      await core.request("PUT", `/entities/${encodeURI(id)}/command`, { cmd_id: a.cmd, params: a.params || undefined });
      const what = a.cmd.split(".").pop().replace(/_/g, " ");
      trail.push(`${await this.displayName(a.entity)} ${what}${a.params ? " " + Object.values(a.params).join(",") : ""}`);
    } else if (a.self) {
      await this.self.run(a.self, a);
      trail.push(`${a.self} → ${a.option ?? a.state}`);
    } else if ("delay" in a) {
      await sleep(Number(a.delay));
    } else if (a.wait_until) {
      const until = Date.now() + Number(a.timeout || 8000);
      while (!(await this.test(a.wait_until, null))) {
        if (Date.now() > until) {
          trail.push("wait timed out");
          if (a.on_timeout === "continue") return true;
          return false;
        }
        await sleep(400);
      }
    } else if (a.save_settings) {
      this.vars["__settings_" + a.save_settings] = JSON.stringify(this.self.snapshot());
      this.saveVars();
      trail.push(`saved settings "${a.save_settings}"`);
    } else if (a.restore_settings) {
      const snap = this.vars["__settings_" + a.restore_settings];
      if (snap) {
        await this.self.restore(JSON.parse(snap));
        trail.push(`restored settings "${a.restore_settings}"`);
      } else {
        trail.push(`no saved settings "${a.restore_settings}"`);
      }
    } else if (a.set_var) {
      this.vars[a.set_var] = String(a.to);
      this.saveVars();
    } else if (a.stop) {
      return false;
    }
    return true;
  }

  /** Runs a button by id. Resolves with a short text summary. */
  async run(id) {
    const b = this.rules.buttons.find((x) => x.id === id);
    if (!b) throw new Error(`no smart button "${id}"`);
    if (this.running.has(id)) return `${b.name}: still running, press ignored`;
    this.running.add(id);
    const trail = [];
    let summary;
    try {
      const cache = new Map();
      let chosen = null;
      let label = "";
      for (let i = 0; i < b.cases.length; i++) {
        const c = b.cases[i];
        if ("else" in c) {
          chosen = c.else;
          label = "else";
          break;
        }
        if (await this.test(c.if ?? true, cache)) {
          chosen = c.do;
          label = b.cases.length > 1 ? `case ${i + 1}` : "if";
          break;
        }
      }
      if (!chosen) {
        summary = `${b.name}: no condition matched`;
      } else {
        for (const a of chosen) {
          if (!(await this.step(a, trail))) break;
        }
        summary = `${b.name} (${label}): ${trail.join("; ") || "done"}`;
      }
    } catch (e) {
      summary = `${b.name}: ERROR ${e.message}${trail.length ? " after " + trail.join("; ") : ""}`;
    } finally {
      this.running.delete(id);
    }
    this.log("smart:", summary);
    this.report(summary);
    return summary;
  }
}
