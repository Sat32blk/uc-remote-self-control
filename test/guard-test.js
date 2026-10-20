// Safety guards: state icons write a page at most once per interval, and pause (instead of overwriting)
// when someone else changed the page; the write counter; the "remove everything" clean-up.
process.env.UC_SELF_PAGE_WRITE_MS = "400";
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { StateIcons } = await import("../src/bin/stateicons.js");
const { CoreClient, writeStats } = await import("../src/bin/core.js");
const http = await import("node:http");

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a tiny fake remote behind a real CoreClient (so the write tracking in core.js is used)
const ACT = "uc.main.watch", DEV = "media.tv";
const state = { dev: "OFF" };
let page = { page_id: "p1", name: "Main", items: [{ type: "text", text: "Power", location: { x: 0, y: 0 }, size: { width: 1, height: 1 } }, { type: "text", text: "Other", location: { x: 1, y: 0 } }] };
let pageWrites = 0;
const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === `/api/activities/${ACT}/ui/pages` && req.method === "GET") return send([JSON.parse(JSON.stringify(page))]);
    if (req.url === `/api/activities/${ACT}/ui/pages/p1` && req.method === "PATCH") { pageWrites++; page.items = JSON.parse(body).items; return send(page); }
    if (req.url === `/api/entities/${DEV}`) return send({ entity_id: DEV, attributes: { state: state.dev } });
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => srv.listen(18124, r));
const core = new CoreClient("127.0.0.1:18124", { apiKey: "k" });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
const si = new StateIcons({ getCore: () => core, file: path.join(dir, "state_icons.json"), log: () => {}, warn: () => {} });
const r = await si.replace([{ id: "pw", name: "Power", activity: ACT, location: { x: 0, y: 0 }, entity: DEV, attr: "state", states: [{ value: "ON", icon: null, text: "ON!" }] }]);
ok(!r.errors.length, "state icon saved");
const text = () => page.items[0].text;

// ---- at most one write per interval ----
state.dev = "ON"; await si.refresh();
ok(text() === "ON!", "first change written");
const n = pageWrites;
state.dev = "OFF"; await si.refresh();
ok(pageWrites === n && text() === "ON!", "a second change within 400 ms waits (no write)");
await sleep(450);
await si.refresh();
ok(pageWrites === n + 1 && text() === "Power", "after the interval the change is written");
ok(writeStats().lastHour >= 2, "the write counter counts page writes: " + writeStats().lastHour);

// ---- someone else changed the page: pause, don't overwrite ----
page.items[1].text = "Edited in the web configurator";
await sleep(450);
state.dev = "ON"; await si.refresh();
ok(text() === "Power" && page.items[1].text === "Edited in the web configurator", "page changed outside: nothing overwritten");
ok(/paused/.test(si.list()[0].status.error || ""), "the state icon shows it's paused: " + si.list()[0].status.error);
await sleep(450);
await si.refresh();
ok(text() === "Power", "stays paused");
await si.replace(si.icons.map(({ page_id, default: d, ...b }) => b));
ok(text() === "ON!" && !si.list()[0].status.error, "saving the state icons again resumes them");

srv.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
