// Display sensors: each display is a sensor entity of this integration whose text is a default value
// (a device's value, a slider, the time…) with text before / after it, and that switches to something
// else for a while when a condition is met (a value changes, goes above / below a number, a Control is
// on, an activity starts), then back. A display can also show messages one after another
// ("Ding dong" 1 s → "Someone's" 1 s → "at the door" 1 s), and smart controls can send it messages.
//
// What a sensor widget can show was tested on a Remote 3 (display test, 1.2.10–1.2.12): letters, emoji,
// ★ ☀ ⚠ ♪ ✓ ✕ ▶ ⏸ ⏻ → ↑ ● ■ ▲ ▪ ▫ ◼ ◻ and the remote's own icons show; □ ○ ▼ and block characters
// (█ ░ ▌ ▁ ▰ ━ …) show as a crossed box. Long text wraps, "\n" breaks the line, and updates every 0.5 s
// redraw live (an attribute update, no page rewrite).
//
// Config (displays.json): { displays: [DISPLAY] }
//   DISPLAY: { id: "disp_volume", name, size: "4x1" | "4x2" | "2x1" | "1x1", def: SHOW, rules: [RULE] }
//   SHOW: { type: "value", src: SRC, fmt: "text" | "num" | "dec" | "bar", bar, cells, pct, min, max,
//           before, after, long: "wrap" | "scroll" }
//       | { type: "messages", steps: [{ t, s }], repeat: "once" | "loop" }
//   SRC: { ent, attr }  ent = a device's entity id | "slider:<id>" | "self:remote" (attr = setting path like
//        "battery.level") | "clock" (attr time | date | datetime) | "control" (attr value | name: the
//        Control that's on) | "activity" (attr name: the activity on screen)
//   RULE: { when: WHEN, show: SHOW, dur: "once" | "while" | "next" | seconds, prio: "normal" | "high" }
//   WHEN: { type: "changes", src } | { type: "above" | "below", src, val: number } | { type: "equals", src, val }
//       | { type: "control", control: "" (any) | control id } | { type: "activity", activity: id }
import fs from "node:fs";

export const DISPLAY_LIMITS = { displays: 20, rules: 16, steps: 20, text: 120, stepMinS: 0.5, stepMaxS: 60, durMaxS: 300 };
// bar characters that showed on the remote (display test round 3)
export const BARS = {
  sq: ["◼", "◻"], small: ["▪", "▫"], green: ["🟩", "⬜"], dots: ["🟢", "⚪"], blue: ["🟦", "⬛"], black: ["⚫", "⚪"], hash: ["#", "-"], pipe: ["|", "·"],
};
const EMOJI_BARS = new Set(["green", "dots", "blue", "black"]);
export const SIZES = ["4x1", "4x2", "2x1", "1x1"];
// about how many characters fit on one line of a sensor widget (for scrolling); estimate per size
export const FIT = { "4x2": 16, "4x1": 26, "2x1": 16, "1x1": 8 };
const ID_RE = /^disp_[a-z0-9_]{1,40}$/;
const WHEN_TYPES = ["changes", "above", "below", "equals", "control", "activity"];
const STATEFUL = new Set(["above", "below", "equals", "control"]);
const SCROLL_MS = 300, SCROLL_PAUSE_MS = 1500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const str = (v, max = DISPLAY_LIMITS.text) => (typeof v === "string" ? v.slice(0, max) : "");
function vSrc(src, p, errs) {
  if (!src || typeof src !== "object" || typeof src.ent !== "string" || !src.ent) { errs.push(`${p}: pick what to show`); return null; }
  const attr = typeof src.attr === "string" && src.attr ? src.attr.slice(0, 80) : "state";
  return { ent: src.ent.slice(0, 120), attr };
}
function vShow(sh, p, errs) {
  if (!sh || typeof sh !== "object") { errs.push(`${p}: missing`); return null; }
  if (sh.type === "messages") {
    const steps = Array.isArray(sh.steps) ? sh.steps : [];
    if (!steps.length) errs.push(`${p}: add at least one message`);
    if (steps.length > DISPLAY_LIMITS.steps) errs.push(`${p}: at most ${DISPLAY_LIMITS.steps} messages`);
    const out = steps.slice(0, DISPLAY_LIMITS.steps).map((s, i) => {
      const t = str(s?.t), secs = Number(s?.s);
      if (!t.trim()) errs.push(`${p}: message ${i + 1} is empty`);
      if (!(secs >= DISPLAY_LIMITS.stepMinS && secs <= DISPLAY_LIMITS.stepMaxS)) errs.push(`${p}: message ${i + 1}: ${DISPLAY_LIMITS.stepMinS}–${DISPLAY_LIMITS.stepMaxS} seconds`);
      return { t, s: Math.min(DISPLAY_LIMITS.stepMaxS, Math.max(DISPLAY_LIMITS.stepMinS, secs || 1)) };
    });
    return { type: "messages", steps: out, repeat: sh.repeat === "loop" ? "loop" : "once" };
  }
  const src = vSrc(sh.src, p, errs);
  const fmt = ["text", "num", "dec", "bar"].includes(sh.fmt) ? sh.fmt : "text";
  const out = { type: "value", src, fmt, before: str(sh.before, 40), after: str(sh.after, 40), long: sh.long === "scroll" ? "scroll" : "wrap" };
  if (fmt === "bar") {
    out.bar = BARS[sh.bar] ? sh.bar : "sq";
    out.cells = Math.min(EMOJI_BARS.has(out.bar) ? 10 : 20, Math.max(3, Math.round(Number(sh.cells) || 8)));
    out.pct = !!sh.pct;
    const min = Number(sh.min), max = Number(sh.max);
    if (sh.min !== undefined && sh.min !== "" && !Number.isFinite(min)) errs.push(`${p}: lowest must be a number`);
    if (sh.max !== undefined && sh.max !== "" && !Number.isFinite(max)) errs.push(`${p}: highest must be a number`);
    if (Number.isFinite(min)) out.min = min;
    if (Number.isFinite(max)) out.max = max;
    if (Number.isFinite(min) && Number.isFinite(max) && max <= min) errs.push(`${p}: highest must be above lowest`);
  }
  return out;
}
function vWhen(w, p, errs) {
  if (!w || !WHEN_TYPES.includes(w.type)) { errs.push(`${p}: pick when it shows`); return null; }
  const out = { type: w.type };
  if (["changes", "above", "below", "equals"].includes(w.type)) out.src = vSrc(w.src, p, errs);
  if (w.type === "above" || w.type === "below") {
    if (!Number.isFinite(Number(w.val)) || w.val === "" || w.val === null) errs.push(`${p}: a number to compare with`);
    out.val = Number(w.val);
  }
  if (w.type === "equals") { out.val = str(String(w.val ?? ""), 80); if (!out.val.trim()) errs.push(`${p}: the value to wait for`); }
  if (w.type === "control") out.control = str(w.control || "", 60);
  if (w.type === "activity") { out.activity = str(w.activity || "", 120); if (!out.activity) errs.push(`${p}: pick an activity`); }
  return out;
}
export function validateDisplays(body) {
  const errs = [];
  const list = Array.isArray(body?.displays) ? body.displays : [];
  if (list.length > DISPLAY_LIMITS.displays) errs.push(`at most ${DISPLAY_LIMITS.displays} displays`);
  const ids = new Set();
  const displays = list.slice(0, DISPLAY_LIMITS.displays).map((d, i) => {
    const name = str(d?.name, 60).trim();
    const p = name ? `"${name}"` : `display ${i + 1}`;
    if (!name) errs.push(`${p}: give it a name`);
    const id = String(d?.id || "");
    if (!ID_RE.test(id)) errs.push(`${p}: id must look like disp_living_room`);
    if (ids.has(id)) errs.push(`${p}: the id ${id} is used twice`);
    ids.add(id);
    const rules = Array.isArray(d?.rules) ? d.rules : [];
    if (rules.length > DISPLAY_LIMITS.rules) errs.push(`${p}: at most ${DISPLAY_LIMITS.rules} temporary changes`);
    const def = vShow(d?.def, `${p} default`, errs);
    return {
      id, name, size: SIZES.includes(d?.size) ? d.size : "4x1", def,
      rules: rules.slice(0, DISPLAY_LIMITS.rules).map((r, k) => {
        const rp = `${p} change ${k + 1}`;
        const when = vWhen(r?.when, rp, errs), show = vShow(r?.show, rp, errs);
        let dur = r?.dur;
        if (dur === "while" && !(when && STATEFUL.has(when.type))) dur = "4";
        if (dur === "once" && show?.type !== "messages") dur = "4";
        if (!["once", "while", "next"].includes(dur)) {
          const n = Number(dur);
          if (!(n > 0 && n <= DISPLAY_LIMITS.durMaxS)) errs.push(`${rp}: show it for 1–${DISPLAY_LIMITS.durMaxS} seconds`);
          dur = String(Math.round(Math.min(DISPLAY_LIMITS.durMaxS, Math.max(1, n || 4))));
        }
        return { when, show, dur, prio: r?.prio === "high" ? "high" : "normal" };
      }),
    };
  });
  return { errors: errs, displays };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
/** Width of a text in character cells (emoji count as two). */
export const width = (t) => Array.from(String(t)).reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : ch === "️" ? 0 : 1), 0);
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
export function barOf(f, sh) {
  const st = BARS[sh.bar] ? sh.bar : "sq", n = sh.cells || 8;
  const on = Math.round(Math.max(0, Math.min(1, f)) * n);
  const b = BARS[st][0].repeat(on) + BARS[st][1].repeat(n - on);
  return st === "hash" ? `[${b}]` : b;
}
/** A value as text in a SHOW's format; `range` is { min, max } of the source (sliders know theirs). */
export function formatValue(v, sh, range = {}) {
  if (v === undefined || v === null || v === "") return "–";
  const n = num(v);
  if (sh.fmt === "num") return n === null ? String(v) : String(Math.round(n));
  if (sh.fmt === "dec") return n === null ? String(v) : (n < 0 ? "−" : "") + Math.abs(n).toFixed(1);
  if (sh.fmt === "bar") {
    if (n === null) return String(v);
    const min = sh.min ?? range.min ?? 0, max = sh.max ?? range.max ?? 100;
    const f = max > min ? (n - min) / (max - min) : 0;
    return barOf(f, sh) + (sh.pct ? ` ${Math.round(Math.max(0, Math.min(1, f)) * 100)} %` : "");
  }
  return typeof v === "number" ? String(Math.round(v * 10) / 10) : String(v);
}
/** Scrolls text that's longer than `fit` cells through one line; elapsed = ms since it started. */
export function scrollText(text, fit, elapsed) {
  if (width(text) <= fit) return text;
  const loop = Array.from(text + "   ·   ");
  const k = Math.floor(Math.max(0, elapsed - SCROLL_PAUSE_MS) / SCROLL_MS) % loop.length;
  let out = "", w = 0;
  for (const ch of loop.slice(k).concat(loop.slice(0, k))) { const cw = width(ch); if (w + cw > fit) break; out += ch; w += cw; }
  return out;
}
const msgLen = (sh) => sh.steps.reduce((a, s) => a + s.s * 1000, 0);
function messageAt(sh, elapsed) {
  if (!sh.steps.length) return "";
  const total = msgLen(sh);
  let t = sh.repeat === "loop" ? elapsed % total : Math.min(elapsed, total - 1);
  for (const s of sh.steps) { t -= s.s * 1000; if (t < 0) return s.t; }
  return sh.steps[sh.steps.length - 1].t;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class Displays {
  /**
   * value(src) → { v, min?, max? } | undefined: the current value of a source (the driver knows devices,
   *   sliders, the remote, Controls, the activity on screen).
   * controlOn(id) → bool: is that Control on ("" = any)?
   * publish(entityId, attrs): pushes the sensor's attributes to the remote.
   */
  constructor({ file, value, controlOn = () => false, publish, clock = null, now = () => Date.now(), log = () => {}, warn = () => {} }) {
    Object.assign(this, { file, value, controlOn, publish, now, log, warn });
    this.clock = clock;
    this.displays = [];
    this.run = new Map(); // display id -> { rule, show, start, until, prio }
    this.last = new Map(); // "id:k" -> last value seen (changes) / truth (stateful)
    this.shown = new Map(); // display id -> text last pushed
    this.timer = null;
    this.load();
  }
  load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, "utf8")); this.displays = validateDisplays(d).displays; } catch { this.displays = []; }
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify({ displays: this.displays }, null, 1)); } catch (e) { this.warn("displays: couldn't save:", e.message); }
  }
  get config() { return { displays: this.displays }; }
  /** Replaces all displays (already validated). */
  replace(list) {
    this.displays = list;
    this.save();
    this.run.clear(); this.last.clear(); this.shown.clear();
    this.tick();
  }
  display(id) { return this.displays.find((d) => d.id === id) || null; }
  /** Every source a display uses (to know which devices to read). */
  sources() {
    const out = [];
    for (const d of this.displays) {
      const add = (sh) => { if (sh?.type === "value" && sh.src) out.push(sh.src); };
      add(d.def);
      for (const r of d.rules) { add(r.show); if (r.when?.src) out.push(r.when.src); }
    }
    return out;
  }

  // ---- what a display shows ---------------------------------------------------------------
  current(d) {
    const r = this.run.get(d.id);
    if (r && this.now() < r.until) return r;
    return null;
  }
  textOf(d, show, start) {
    const elapsed = this.now() - (start ?? 0);
    if (show.type === "messages") return messageAt(show, elapsed);
    const val = this.value(show.src) || {};
    const text = (show.before || "") + formatValue(val.v, show, val) + (show.after || "");
    return show.long === "scroll" ? scrollText(text, FIT[d.size] || 26, elapsed) : text;
  }
  /** What a display shows now. */
  text(d) {
    const c = this.current(d);
    return c ? this.textOf(d, c.show, c.start) : this.textOf(d, d.def, 0);
  }

  // ---- switching -------------------------------------------------------------------------
  activate(d, rule, show, why, { dur, prio } = {}) {
    const now = this.now(), cur = this.current(d);
    prio = prio || rule?.prio || "normal";
    if (cur && cur.rule !== rule && cur.prio === "high" && prio !== "high") return false;
    dur = dur ?? rule?.dur ?? "4";
    let until = Infinity;
    if (dur === "once") until = now + (show.type === "messages" ? msgLen(show) : 4000);
    else if (/^\d+(\.\d+)?$/.test(String(dur))) until = now + Number(dur) * 1000;
    const keep = cur && cur.rule === rule && rule && show.type === "messages"; // repeated trigger: messages go on, not restart
    this.run.set(d.id, { rule, show, start: keep ? cur.start : now, until, prio, why });
    return true;
  }
  /** An activity was opened (from the remote's events). */
  activityStarted(activityId) {
    for (const d of this.displays) for (const r of d.rules) if (r.when?.type === "activity" && r.when.activity === activityId) this.activate(d, r, r.show, "activity started");
    this.tick();
  }
  /** A smart control's step "Show on a display": messages, high priority, once through. */
  showMessages(displayId, messages, secs = 1) {
    const d = this.display(displayId);
    if (!d) throw new Error(`no display "${displayId}"`);
    const show = { type: "messages", steps: messages.map((t) => ({ t: String(t).slice(0, DISPLAY_LIMITS.text), s: Math.min(DISPLAY_LIMITS.stepMaxS, Math.max(DISPLAY_LIMITS.stepMinS, Number(secs) || 1)) })), repeat: "once" };
    this.activate(d, null, show, "smart control", { dur: "once", prio: "high" });
    this.tick();
    return `${d.name}: ${messages.join(" · ")}`;
  }
  truth(rule) {
    const w = rule.when;
    if (w.type === "control") return !!this.controlOn(w.control || "");
    const v = this.value(w.src)?.v;
    if (w.type === "equals") return String(v ?? "").toLowerCase() === String(w.val).toLowerCase() || (num(v) !== null && num(v) === num(w.val));
    const n = num(v);
    if (n === null) return false;
    return w.type === "above" ? n > w.val : n < w.val;
  }

  /** One step: conditions, then push the text of every display whose text changed. */
  tick() {
    const now = this.now();
    for (const d of this.displays) {
      d.rules.forEach((r, k) => {
        const key = d.id + ":" + k;
        if (r.when?.type === "changes") {
          const v = JSON.stringify(this.value(r.when.src)?.v ?? null);
          const had = this.last.has(key), was = this.last.get(key);
          this.last.set(key, v);
          if (had && v !== was && v !== "null") this.activate(d, r, r.show, "changed");
        } else if (r.when && STATEFUL.has(r.when.type)) {
          const t = this.truth(r), was = this.last.get(key);
          this.last.set(key, t);
          if (t && was === false) this.activate(d, r, r.show, "became true");
          else if (!t && this.run.get(d.id)?.rule === r && r.dur === "while") this.run.delete(d.id);
        }
      });
      let cur = this.current(d);
      if (cur && cur.rule?.dur === "while" && !this.truth(cur.rule)) { this.run.delete(d.id); cur = null; }
      if (!cur) {
        if (this.run.has(d.id)) this.run.delete(d.id);
        // a condition that's still true (a Control still on, battery still low) shows next
        const still = d.rules.find((r) => r.dur === "while" && r.when && STATEFUL.has(r.when.type) && this.truth(r));
        if (still) this.activate(d, still, still.show, "still true");
      }
      let text;
      try { text = this.text(d); } catch (e) { text = "–"; this.warn(`display ${d.id}:`, e.message); }
      text = String(text).slice(0, 250);
      if (this.shown.get(d.id) !== text) {
        this.shown.set(d.id, text);
        this.publish(d.id, { state: "ON", value: text });
      }
    }
    return now;
  }
  start(ms = 250) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.warn("displays:", e.message); } }, ms);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  status() {
    const out = {};
    for (const d of this.displays) { const c = this.current(d); out[d.id] = { text: this.shown.get(d.id) ?? "", changed: !!c, why: c?.why || null, until: c && c.until !== Infinity ? c.until : null }; }
    return out;
  }
}
