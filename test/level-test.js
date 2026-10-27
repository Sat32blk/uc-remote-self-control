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
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
