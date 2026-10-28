// Level pictures: the new settings are kept (smooth colours, gradient inside, text format and label, longer
// times, no restart), and "each change starts the time again" can be turned off.
import { validateIcons } from "../src/bin/stateicons.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const frames = Array.from({ length: 11 }, (_, i) => `custom:lv_x_${i}.png`);
const base = { id: "lvl_vol", name: "Volume level", activity: "uc.main.a", location: { x: 2, y: 2 }, entity: "media_player.avr", attr: "volume", states: [],
  kind: "level", min: 0, max: 100, design: "text", color: "#2ecc71", frames, slider: "slider_vol",
  colors: [{ from: 50, color: "#f2c94c" }, { from: 100, color: "#ff5a4e" }] };
let v = validateIcons({ icons: [{ ...base, blend: true, inner: true, fmt: "raw", label: { on: true, fmt: "num", size: "l", dx: 1, dy: 0 }, show: "change", showMs: 300000, noRestart: true }] });
const o = v.icons?.[0] || {};
ok(!v.errors.length, "valid: " + (v.errors.join("; ") || "no errors"));
ok(o.blend === true && o.inner === true && o.fmt === "raw", "smooth colours, gradient inside and the text format are kept");
ok(o.label && o.label.on && o.label.fmt === "num" && o.label.size === "l" && o.label.dx === 1, "the text label is kept");
ok(o.show === "change" && o.showMs === 300000 && o.noRestart === true, "5 minutes, without restarting on each change");
v = validateIcons({ icons: [{ ...base, show: "change", showMs: 400000 }] });
ok(v.errors.some((e) => /1 second to 5 minutes/.test(e)), "more than 5 minutes is refused");
v = validateIcons({ icons: [{ ...base, fmt: "weird", label: { on: false } }] });
ok(!v.icons[0].fmt && !v.icons[0].label, "unknown text format and a label that's off are left out");
v = validateIcons({ icons: [{ ...base, cells: [{ x: 2, y: 2, frames }, { x: 3, y: 2, frames }, { x: 2, y: 3, frames }, { x: 3, y: 3, frames }], sig: "abc123" }] });
ok(v.icons[0].cells?.length === 4 && v.icons[0].sig === "abc123", "an area of 2 × 2 buttons");
// a slider that doesn't read its device: the level shows the slider's own remembered value
{
  const { StateIcons } = await import("../src/bin/stateicons.js");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  let page = { page_id: "p1", items: [{ type: "icon", icon: "custom:own.png", location: { x: 0, y: 0 }, size: { width: 1, height: 1 } }] };
  const asked = [];
  const core = { get: async (p) => { asked.push(p); if (/\/ui\/pages$/.test(p)) return [JSON.parse(JSON.stringify(page))]; throw new Error("not found"); },
    patch: async (p, body) => { page = { ...page, items: body.items }; return {}; } };
  const SI = new StateIcons({ getCore: () => core, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "si-")), "si.json"), log: () => {}, warn: () => {} });
  let val = 70;
  SI.local = (e) => (e === "slider:slider_amp" ? { value: val, state: "ON" } : null);
  const v2 = validateIcons({ icons: [{ ...base, entity: "slider:slider_amp", attr: "value", location: { x: 0, y: 0 }, activity: "uc.main.a", slider: "slider_amp", colors: undefined }] });
  ok(!v2.errors.length, "a level on the slider's own value is valid: " + v2.errors.join("; "));
  const r = await SI.replace(v2.icons);
  ok(!r.errors.length, "saved: " + r.errors.join("; "));
  await SI.refresh(true);
  ok(page.items[0].icon === frames[7] && !asked.some((p) => p.startsWith("/entities/")), "70 of 0–100 shows frame 7, without asking the remote for a device");
  val = 20; await SI.refresh(true);
  ok(page.items[0].icon === frames[2], "the slider moves to 20: frame 2");
}
// finer steps: 21, 51 or 101 pictures; the right one is picked for each value
{
  const { levelIndex } = await import("../src/bin/stateicons.js");
  const f101 = Array.from({ length: 101 }, (_, i) => `custom:lv_y_${i}.png`), f21 = f101.slice(0, 21);
  let v3 = validateIcons({ icons: [{ ...base, frames: f101 }] });
  ok(!v3.errors.length && v3.icons[0].frames.length === 101, "101 pictures (every 1 %) are accepted");
  ok(levelIndex({ min: 0, max: 100, frames: f101 }, 37) === 37 && levelIndex({ min: 0, max: 100, frames: f21 }, 37) === 7 && levelIndex({ min: 0, max: 100, frames }, 37) === 4, "37 shows picture 37 of 101, 7 of 21, 4 of 11");
  v3 = validateIcons({ icons: [{ ...base, frames: f101.slice(0, 30) }] });
  ok(v3.errors.length > 0, "30 pictures is refused");
  v3 = validateIcons({ icons: [{ ...base, cells: [{ x: 2, y: 2, frames: f21 }, { x: 3, y: 2, frames }] }] });
  ok(v3.errors.some((e) => /same number/.test(e)), "buttons with different numbers of pictures are refused");
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
