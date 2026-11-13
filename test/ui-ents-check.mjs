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
await pg.goto(base + process.env.EDITOR_PATH); try { await pg.waitForSelector("button.slider", { timeout: 15000 }); } catch (e) { console.log("ERRS", errs, await pg.$eval("#loading", (x) => x.textContent).catch(() => "")); throw e; }
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const SH = process.env.SHOTS;
await pg.click("#mode-pages"); await pg.click("#sub-ents");
await pg.waitForSelector("#ent-card .entchip");
ok(!(await pg.isVisible("#libcard")), "Entities view replaces the page editing columns");
await pg.screenshot({ path: SH + "/e1.png" });
await pg.click("#ent-add");
await pg.waitForFunction(() => [...document.querySelectorAll(".entpop .grp")].some((g) => g.textContent.startsWith("Not added yet")) && !document.querySelector(".entpop")?.textContent.includes("Asking"), null, { timeout: 8000 });
const grps = await pg.$$eval(".entpop .grp", (g) => g.map((x) => x.textContent));
console.log(grps.join(" | "));
await pg.screenshot({ path: SH + "/e2.png" });
await pg.fill("#ent-q", "kitch");
const hits = await pg.$$eval(".entpop .it", (b) => b.map((x) => x.textContent));
console.log("search kitch:", hits);
ok(hits.some((t) => t.includes("Kitchen Motion")), "search finds the not-added sensor");
await pg.click(".entpop .it.new");
await pg.waitForFunction(() => document.querySelector("#ent-card")?.textContent.includes("was added to the remote"), null, { timeout: 8000 });
ok(calls.some((c) => c.m === "POST" && /\/intg\/instances\/hass\.main\/entities/.test(c.p)), "picked: added to the remote");
const chips = await pg.$$eval("#ent-card .entchip", (c) => c.map((x) => x.className + " :: " + x.textContent));
console.log(chips);
ok(chips.some((t) => t.includes("fresh") && t.includes("Kitchen Motion")), "shown as added on save");
// take out one not in use
const rm = await pg.$$("#ent-card .entchip:not(.used):not(.fresh) button");
if (rm.length) { await rm[0].click(); }
ok(await pg.$("#ent-card .entchip.gone"), "taken out: shown crossed out with a keep button");
ok(!(await pg.isDisabled("#save")), "Save is enabled");
await pg.screenshot({ path: SH + "/e3.png" });
calls.length = 0;
await pg.click("#save"); await pg.waitForTimeout(2500);
const patch = calls.find((c) => c.m === "PATCH" && /^\/activities\/[^/]+$/.test(c.p) && c.b?.options?.entity_ids);
console.log(JSON.stringify(patch?.b?.options?.entity_ids));
ok(patch && patch.b.options.entity_ids.includes("hass.main.binary_sensor.kitchen_motion"), "saved: entity_ids include the new sensor");
await pg.setViewportSize({ width: 390, height: 900 }); await pg.waitForTimeout(300); await pg.screenshot({ path: SH + "/e4.png", fullPage: true });
ok(!errs.length, "no page errors " + errs.join("; "));
await b.close(); process.exit(fails ? 1 : 0);
