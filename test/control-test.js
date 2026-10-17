// Unit test of the "Control" test proxy with a fake core.
import { ControlProxy } from "../src/bin/control.js";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const light = { entity_id: "hass.main.light.x", entity_type: "light", name: { en: "Ceiling Light" }, attributes: { state: "ON", brightness: 127 } };
const sent = [];
const core = {
  get: async (p) => (p === "/entities/hass.main.light.x" ? light : []),
  request: async (m, p, b) => { sent.push(b); if (b.cmd_id === "light.on") light.attributes.brightness = b.params.brightness; }
};
let display = 40; const dispSet = [];
let last = {};
const c = new ControlProxy({ getCore: () => core, publish: (a) => (last = a), getDisplay: () => display, setDisplay: async (v) => { dispSet.push(v); display = v; }, idleMs: 300 });
await c.findLight(async () => [{ entity_id: "self_control.main.backlight", entity_type: "light", name: "x" }, light]);
ok(c.light?.name === "Ceiling Light", "finds the Home Assistant light, not our own");
await c.activate("display");
ok(last.volume === 40 && last.media_title === "Normal controls", "normal: shows screen brightness 40");
await c.command("volume_up");
ok(dispSet.at(-1) === 45 && last.volume === 45, "rocker up in normal mode sets screen brightness 45");
await c.activate("light");
ok(last.volume === 50 && /Control active/.test(last.media_artist), "light mode: loads 127/255 = 50 % and shows Control active");
await c.command("volume", { volume: 80 });
ok(sent.at(-1).cmd_id === "light.on" && sent.at(-1).params.brightness === 204, "slider to 80 % sets the light to 204/255");
await c.command("volume_down");
ok(sent.at(-1).params.brightness === 191, "rocker down: 75 %");
await c.command("volume", { volume: 0 });
ok(sent.at(-1).cmd_id === "light.off", "0 % turns the light off");
await c.command("volume", { volume: 30 });
await sleep(450);
ok(c.mode === "display" && last.media_title === "Normal controls" && last.volume === 45, "after the idle time: back to screen brightness");
await c.command("select_source", { source: "Ceiling Light" });
ok(c.mode === "light", "picking the light as source also starts light mode");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
