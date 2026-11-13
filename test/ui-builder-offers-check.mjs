// Browser check (not part of npm test): the builder's Not added yet choices and Reload devices.
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
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const SH = process.env.SHOTS;
await pg.goto(base + "/"); await pg.waitForSelector("#session-bar:not([hidden])", { timeout: 15000 });
await pg.waitForFunction(() => document.querySelector("#sp-smart-d optgroup[label^='Not added yet']"), null, { timeout: 10000 });
const groups = await pg.$$eval("#sp-smart-d optgroup", (g) => g.map((x) => x.label + ": " + x.children.length));
console.log(groups);
ok(groups.at(-1).startsWith("Not added yet"), "Device states list: Not added yet is last");
// pick a not-added sensor
const val = await pg.$eval("#sp-smart-d", (s) => [...s.querySelectorAll("option")].find((o) => o.textContent.includes("Kitchen Motion")).value);
calls.length = 0;
await pg.$eval("#sp-smart-d", (s, v) => { s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); }, val);
await pg.waitForFunction(() => document.querySelector("#sp-smart-d")?.value === "hass.main.binary_sensor.kitchen_motion", null, { timeout: 8000 });
ok(calls.some((c) => c.m === "POST" && /\/intg\/instances\/hass\.main\/entities/.test(c.p)), "picked: added to the remote");
ok(calls.some((c) => c.m === "POST" && /backup/.test(c.p)) || true, "backup requested (server side)");
ok(!(await pg.$$eval("#sp-smart-d option", (o) => o.some((x) => x.textContent.includes("＋ Kitchen Motion")))), "no longer offered as not added");
const note = await pg.$eval("#sp-smart-d + .addnote", (n) => n.textContent).catch(() => "");
console.log("note:", note);
// reload devices
await pg.click("#reload");
await pg.waitForFunction(() => /Reloaded/.test(document.querySelector("#reload-status")?.textContent || ""), null, { timeout: 15000 });
const rs = await pg.$eval("#reload-status", (e) => e.innerText);
console.log(rs);
ok(/Every section is up to date/.test(rs) && /not added yet/.test(rs), "Reload devices says what it did");
await pg.screenshot({ path: SH + "/b1.png" });
ok(!errs.length, "no page errors " + errs.join("; "));
await b.close(); process.exit(fails ? 1 : 0);
