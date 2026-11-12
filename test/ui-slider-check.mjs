// Browser check (not part of npm test): the Page Editor's touch slider choices.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
import { startWebServer } from "../src/bin/web.js";
import { CoreClient } from "../src/bin/core.js";
import { startMockEditorCore, calls } from "./mock-editor-core.js";
import * as MOCK from "./mock-editor-core.js";
const mock = await startMockEditorCore(0);
const addr = "127.0.0.1:" + mock.address().port;
const core = new CoreClient(addr, { apiKey: "k" });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ui-"));
const port = 21500;
startWebServer({ port, pagePath: new URL("../src/bin/web/builder.html", import.meta.url).pathname, editorPath: new URL("../src/bin/web/editor.html", import.meta.url).pathname, dataDir,
  getCore: () => core, makePinClient: (pin) => new CoreClient(addr, { pin }), smart: () => null, controls: () => ({}), settings: {}, loadRulesText: () => ({ text: "{}" }), defaultRulesText: () => "{}",
  saveRules: () => {}, validate: () => [], stateIcons: () => ({}), validateIcons: () => ({ errors: [] }), extras: () => ({}), controlsApi: {}, deviceStates: () => ({}), validateExtras: () => ({ errors: [] }),
  returnSettings: async () => ({}), saveReturn: async () => [], onScreen: () => "uc.main.watch", version: "test", log: () => {}, warn: () => {} });
await new Promise((r) => setTimeout(r, 300));
const base = `http://127.0.0.1:${port}`;
const login = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
const [name, value] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addCookies([{ name, value, url: base }]);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
await pg.addInitScript(() => { try { localStorage.setItem("scb_tour_offer", JSON.stringify({ off: true, seen: {} })); } catch {} });
await pg.goto(base + process.env.EDITOR_PATH); await pg.waitForSelector("button.slider", { timeout: 15000 });
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
await pg.click("button.slider"); await pg.waitForSelector("#slider-sel");
await pg.waitForFunction(() => [...document.querySelectorAll("#slider-sel optgroup")].some((g) => g.label.startsWith("Not added yet")), null, { timeout: 8000 });
const groups = await pg.$$eval("#slider-sel optgroup", (gs) => gs.map((g) => [g.label, [...g.children].map((o) => o.textContent)]));
console.log(JSON.stringify(groups));
ok(groups[0][0] === "In this activity" && groups[0][1].some((t) => t.startsWith("Marantz Receiver · volume")), "this activity's devices first");
ok(groups[1][0].startsWith("On the remote") && groups[1][1].some((t) => t.startsWith("Living Room TV · volume")), "the remote's other devices");
const na = groups.find((g) => g[0].startsWith("Not added yet"));
ok(na && na[1].length === 1 && na[1][0] === "Desk Lamp · brightness (Home Assistant)" || (na && /Desk Lamp · brightness/.test(na[1][0]) && na[1].length === 1), "Not added yet: only what the slider can control: " + JSON.stringify(na));
await pg.selectOption("#slider-sel", { label: na[1][0] });
await pg.waitForFunction(() => document.querySelector("#slider-sel")?.value === "hass.main.light.desk|dim", null, { timeout: 8000 });
ok(calls.some((c) => c.m === "POST" && c.p === "/intg/instances/hass.main/entities"), "picked: added to the remote");
const txt = await pg.$eval("#insp", (e) => e.textContent);
ok(/Desk Lamp was added to the remote/.test(txt), "says what happened");
ok(!(await pg.$$eval("#slider-sel optgroup", (gs) => gs.some((g) => g.label.startsWith("Not added yet")))), "no longer offered as not added");
await pg.screenshot({ path: process.env.SHOT });
// save: the slider and the device reach the activity
calls.length = 0;
await pg.click("#save"); await pg.waitForTimeout(2500);
console.log(await pg.$eval("#savestatus", (e) => e.textContent), JSON.stringify(calls.map((c) => c.m + " " + c.p)));
const a = MOCK.S.activities["uc.main.music"];
ok(a.options.touch_slider?.target?.entity_id === "hass.main.light.desk" && a.options.touch_slider.target.feature === "dim" && a.entity_ids.includes("hass.main.light.desk"), "saved: slider set and device added to the activity " + JSON.stringify(a.options.touch_slider));
ok(!errs.length, "no page errors " + errs.join("; "));
await b.close(); process.exit(fails ? 1 : 0);
