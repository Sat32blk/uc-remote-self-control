// Browser check (not part of npm test): the Page Editor's Android apps section.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
import { startWebServer } from "../src/bin/web.js";
import { CoreClient } from "../src/bin/core.js";
import { startMockEditorCore, calls } from "./mock-editor-core.js";
import * as MOCK from "./mock-editor-core.js";
import { AndroidApps } from "../src/bin/androidapps.js";
import { startMockAdbd } from "./mock-adbd.js";
const mock = await startMockEditorCore(0);
const addr = "127.0.0.1:" + mock.address().port;
const core = new CoreClient(addr, { apiKey: "k" });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ui-"));
const port = 21510;
let front = "x";
const tv = await startMockAdbd({ approve: "manual", model: "SHIELD Android TV", shell: (c) => {
  if (c.startsWith("cmd package query-activities")) return ["com.netflix.ninja/.Main", "com.google.android.youtube.tv/.Main", "com.plexapp.android/.Splash", "org.xbmc.kodi/.Splash", "com.android.tv.settings/.Main", "com.valvesoftware.steamlink/.Main"].map((x) => "  " + x).join("\n");
  if (c === "pm list packages -s") return "package:com.android.tv.settings\n";
  if (c.startsWith("am start")) { front = c; return "Starting\n"; }
  return "";
} });
const aa = new AndroidApps({ dir: dataDir });
const androidApi = {
  view: () => ({ ...aa.view(), entityPrefix: "self_control.main." }),
  add: (b) => aa.view(aa.add(b).id), remove: (b) => { aa.remove(b.id); return aa.view(); }, connect: (b) => aa.connect(b.id),
  scan: async (b) => ({ ...(await aa.scan(b.id, ["netflix.png", "youtube.png"])), device: aa.view(b.id) }),
  setApps: (b) => { aa.setApps(b.id, b.apps); return aa.view(b.id); }, launch: (b) => aa.launch(b.id, b.pkg),
  publish: async (b) => { const d = aa.dev(b.id); d.added = true; aa.save(true); const ent = "self_control.main." + aa.entityId(d);
    if (!MOCK.S.entities.some((e) => e.entity_id === ent)) MOCK.S.entities.push({ entity_id: ent, entity_type: "media_player", integration_id: "self_control.main", name: { en: d.name + " apps" }, features: ["select_source", "browse_media"], attributes: { state: "ON", source_list: aa.picked(d).map((a) => a.name) } });
    return { entity: ent, added: true, device: aa.view(d.id) }; },
  picture: async () => null
};
startWebServer({ androidApi, port, pagePath: new URL("../src/bin/web/builder.html", import.meta.url).pathname, editorPath: new URL("../src/bin/web/editor.html", import.meta.url).pathname, dataDir,
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
const SH = process.env.SHOTS || (await import("node:os")).tmpdir();
await pg.goto(base + "/editor"); await pg.waitForSelector("button.slider", { timeout: 15000 });
await pg.click("#mode-dev"); await pg.waitForTimeout(500);
await pg.click("text=Android apps"); await pg.waitForSelector(".aa");
ok(await pg.isVisible("text=No TVs yet."), "Android apps section opens, no TVs yet");
await pg.fill('.aa input[aria-label="Name"]', "SHIELD Theater");
await pg.fill('.aa input[aria-label="Address"]', `127.0.0.1:${tv.port}`);
await pg.click("text=＋ Add device");
await pg.waitForSelector("text=Waiting for you on the TV", { timeout: 8000 });
ok(/Allow network debugging\?/.test(await pg.$eval(".aa-steps", (e) => e.textContent)), "waiting: tells you what to press on the TV");
await pg.screenshot({ path: SH + "/a1.png" });
tv.state.approveNow();
await pg.waitForSelector(".aa-grid", { timeout: 8000 });
const names = await pg.$$eval(".aa-app .aa-name", (x) => x.map((i) => i.value));
console.log(names);
ok(names.includes("Netflix") && names.includes("Steam Link") && !names.includes("Settings"), "scanned: apps listed by name, system apps hidden");
await pg.check('input[aria-label="Pick Netflix"]'); await pg.check('input[aria-label="Pick YouTube"]'); await pg.check('input[aria-label="Pick Plex"]');
await pg.click('button[aria-label="Favorite Netflix"]');
await pg.fill('input[aria-label="Folder of Plex"]', "Movies"); await pg.press('input[aria-label="Folder of Plex"]', "Tab");
await pg.click('.aa-app:has(input[aria-label="Pick Plex"]) .aa-try');
await pg.waitForFunction(() => /opened on/.test(document.querySelector(".aa-dev")?.textContent || ""), null, { timeout: 5000 });
ok(/am start -n com\.plexapp\.android/.test(front), "Try it opens the app on the TV");
await pg.screenshot({ path: SH + "/a2.png", fullPage: true });
await pg.click("text=Add to the remote");
await pg.waitForFunction(() => /is on the remote with 3 apps/.test(document.querySelector(".aa-dev")?.textContent || ""), null, { timeout: 15000 });
const d = aa.devices[0];
ok(aa.picked(d).map((a) => a.name).join() === "Netflix,YouTube,Plex" && d.apps.find((a) => a.pkg === "com.netflix.ninja").fav && d.apps.find((a) => a.pkg === "com.plexapp.android").folder === "Movies" && d.added, "saved: picks, favorite, folder; on the remote");
await pg.screenshot({ path: SH + "/a3.png" });
// no page maker, no picture picker, no add-to-activity: the entity is edited here
ok(!(await pg.$('input[placeholder="picture…"]')), "no picture picker");
await pg.click("text=Change apps");
ok(!(await pg.$("text=Make it")) && !(await pg.$('select[aria-label="Activity to add the apps to"]')), "no apps page maker, no add-to-activity");
await pg.uncheck('input[aria-label="Pick YouTube"]'); await pg.check('input[aria-label="Pick Kodi"]');
ok((await pg.$$('.aa-bar button')).length === 1, "one save button");
await pg.click("text=Save and update the remote");
await pg.waitForFunction(() => /is on the remote with 3 apps/.test(document.querySelector(".aa-dev")?.textContent || ""), null, { timeout: 5000 });
ok(aa.picked(d).map((a) => a.name).join() === "Netflix,Plex,Kodi", "apps added and removed after it's on the remote: " + aa.picked(d).map((a) => a.name).join());
ok(aa.attrs(d).source_list.join() === "Netflix,Plex,Kodi", "the entity's app list follows");
await pg.screenshot({ path: SH + "/a4.png", fullPage: true });
ok(!errs.length, "no page errors " + errs.join("; "));
await b.close(); tv.server.close(); process.exit(fails ? 1 : 0);
