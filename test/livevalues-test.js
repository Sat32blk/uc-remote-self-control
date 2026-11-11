// Device values kept in memory: events keep them current, the remote is asked far less often.
import http from "node:http";
import { CoreClient } from "../src/bin/core.js";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hits = 0, level = 10;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/entities/")) {
    hits++;
    setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ entity_id: "light.k", attributes: { state: "ON", brightness: level } })); }, 30);
    return;
  }
  if (req.method === "PUT") { res.writeHead(200); return res.end("{}"); }
  if (req.url === "/api/cfg") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"a":1}'); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const core = new CoreClient(`127.0.0.1:${server.address().port}`, { apiKey: "x" });

// without events: reads at the same moment share one request; later reads ask the remote again
let [a, b, c] = await Promise.all([core.get("/entities/light.k"), core.get("/entities/light.k"), core.get("/entities/light.k")]);
ok(hits === 1 && a.attributes.brightness === 10 && c.attributes.brightness === 10, "three reads at once: one request");
a.attributes.brightness = 99;
ok(b.attributes.brightness === 10, "callers get their own copy");
await core.get("/entities/light.k");
ok(hits === 2, "without events: a later read asks the remote again");

// with events: a change event updates the kept copy, no request needed
core.live = () => true;
level = 50;
core.entityEvent("light.k", { brightness: 50 });
await sleep(1100);
let e = await core.get("/entities/light.k");
ok(hits === 2 && e.attributes.brightness === 50 && e.attributes.state === "ON", "with events: value from the event, no request");
core.entityEvent("light.unknown", { state: "ON" });
await core.get("/entities/light.unknown");
ok(hits === 3, "a device never read before is read in full (events only carry what changed)");

// a command to the device: read fresh next time
await core.request("PUT", "/entities/light.k/command", { cmd_id: "on" });
level = 70;
e = await core.get("/entities/light.k");
ok(hits === 4 && e.attributes.brightness === 70, "after a command the device is read fresh");

// just after a command, values kept are reused for 1 s at most
await core.get("/entities/light.k"); // kept
await sleep(1100);
await core.get("/entities/light.k");
ok(hits === 5, "shortly after a command: read again after 1 s even with events");
hits = 4;

// events reconnected: everything is read again
core.clearEntities();
await core.get("/entities/light.k");
ok(hits === 5, "after a reconnect everything is read again");
ok(core.reads.remote === 6 && core.reads.memory >= 2, `counters: ${core.reads.remote} from the remote, ${core.reads.memory} from memory`);

// other paths are never kept
await core.get("/cfg"); await core.get("/cfg");
ok(hits === 5, "other requests are not affected");

server.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
