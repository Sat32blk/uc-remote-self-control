// Android apps: scan, names, pictures, choices, launching, keys, what's in front, browse and search.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AndroidApps, appName, matchPicture, parseComponents, parseFront } from "../src/bin/androidapps.js";
import { startMockAdbd } from "./mock-adbd.js";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ok(appName("com.netflix.ninja") === "Netflix" && appName("com.example.superplayer.tv") === "Superplayer", "app names: known list, then a tidy package name");
ok(matchPicture("Prime Video", ["amazon-prime-video.png", "plex.png"]) === "amazon-prime-video.png" && matchPicture("Plex", ["plex.png"]) === "plex.png" && matchPicture("Disney+", ["disney-plus.png"]) === "disney-plus.png" && matchPicture("Zzz", ["plex.png"]) === "", "pictures matched by name and aliases");
ok(parseComponents("2 activities found\n  com.netflix.ninja/.MainActivity\n  org.xbmc.kodi/org.xbmc.kodi.Splash\n").map((c) => c.act).join() === "com.netflix.ninja.MainActivity,org.xbmc.kodi.Splash", "components parsed (relative names made full)");
ok(parseFront("  mResumedActivity: ActivityRecord{1 u0 com.plexapp.android/com.plexapp.plex.Main t9}") === "com.plexapp.android", "app in front parsed");

let front = "com.google.android.tvlauncher";
const tv = await startMockAdbd({ approve: "auto", shell: (c) => {
  if (c.startsWith("cmd package query-activities")) return "  com.netflix.ninja/.MainActivity\n  com.plexapp.android/com.plexapp.plex.activities.SplashActivity\n  org.xbmc.kodi/.Splash\n  com.android.tv.settings/.MainSettings\n  com.example.superplayer.tv/.Main\n";
  if (c === "pm list packages -s") return "package:com.android.tv.settings\npackage:com.google.android.tvlauncher\n";
  if (c.startsWith("dumpsys activity")) return `  mResumedActivity: ActivityRecord{abc u0 ${front}/.X t1}\n`;
  if (c.startsWith("am start -n ")) { front = c.slice(12).split("/")[0]; return "Starting: Intent { cmp=... }\n"; }
  if (c.startsWith("monkey")) { front = c.split(" ")[2]; return "Events injected: 1\n"; }
  return "";
} });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-"));
const changes = [];
const aa = new AndroidApps({ dir, picUrl: (d, p) => `http://hub/aa/pic/${d}/${p}`, onChange: (id, a) => changes.push([id, a]) });
const d = aa.add({ name: "SHIELD Theater", host: "127.0.0.1", port: tv.port });
ok(d.id === "shield_theater" && fs.existsSync(path.join(dir, "android_apps.json")), "device added and saved");
let threw = false; try { aa.add({ name: "x", host: "127.0.0.1", port: tv.port }); } catch { threw = true; }
ok(threw, "the same device can't be added twice");

await aa.connect(d.id);
ok(aa.view(d.id).status.state === "ok" && tv.state.prompts === 1 && fs.existsSync(path.join(dir, "android_key.json")), "connected after the TV allowed the key; key kept");
const r = await aa.scan(d.id, ["netflix.png", "plex.png", "kodi.png"]);
ok(r.found === 5 && r.system === 1, "scan: 5 launchable apps, 1 of them a system app");
const byPkg = Object.fromEntries(d.apps.map((a) => [a.pkg, a]));
ok(byPkg["com.netflix.ninja"].name === "Netflix" && byPkg["com.netflix.ninja"].pic === "netflix.png" && byPkg["com.android.tv.settings"].sys, "names and pictures filled in; system app marked");

aa.setApps(d.id, [
  { pkg: "com.plexapp.android", on: true, fav: true, folder: "Movies" },
  { pkg: "com.netflix.ninja", on: true, folder: "Movies" },
  { pkg: "org.xbmc.kodi", on: true, name: "Kodi (local)" },
  { pkg: "com.example.superplayer.tv", on: false }
]);
ok(aa.picked(d).map((a) => a.name).join() === "Plex,Netflix,Kodi (local)", "picked apps in your order, renamed");
const attrs = aa.attrs(d);
ok(attrs.source_list.join() === "Plex,Netflix,Kodi (local)" && attrs.media_artist === "SHIELD Theater", "the entity's input list is the picked apps");

// launch by input list and by browse
ok((await aa.command(d.id, "select_source", { source: "Netflix" })) === 200 && tv.state.commands.some((c) => c === "am start -n com.netflix.ninja/com.netflix.ninja.MainActivity"), "select source · Netflix opens it (am start)");
ok(aa.attrs(d).media_title === "Netflix" && aa.attrs(d).media_image_url === `http://hub/aa/pic/${d.id}/com.netflix.ninja`, "the widget shows the app in front with its picture");
ok((await aa.command(d.id, "play_media", { media_id: "app:org.xbmc.kodi" })) === 200 && front === "org.xbmc.kodi", "play media (from Browse) opens it");
ok((await aa.command(d.id, "cursor_down")) === 200 && tv.state.commands.includes("input keyevent 20"), "D-pad keys go to the TV");
ok((await aa.command(d.id, "select_source", { source: "Nope" })) === 400, "unknown app: bad request");
front = "com.plexapp.android";
await aa.refresh(d.id);
ok(aa.attrs(d).source === "Plex", "the app opened on the TV itself is noticed");

// browse
let b = aa.browse(d.id, {});
ok(b.media.items.map((x) => x.title).join() === "Favorites,Recently used,All apps,Movies", "browse top: Favorites, Recently used, All apps, folders");
b = aa.browse(d.id, { media_id: "all", paging: { page: 1, limit: 2 } });
ok(b.media.items.length === 2 && b.pagination.count === 3 && b.media.items[0].media_class === "app" && b.media.items[0].can_play, "All apps, paged, playable app items");
ok(aa.browse(d.id, { media_id: "all", paging: { page: 2, limit: 2 } }).media.items.length === 1, "second page");
ok(aa.browse(d.id, { media_id: "recent" }).media.items[0].title === "Plex", "Recently used: last one first");
ok(aa.browse(d.id, { media_id: "folder:Movies" }).media.items.map((x) => x.title).join() === "Plex,Netflix", "a folder");
ok(aa.browse(d.id, { media_id: "fav" }).media.items[0].thumbnail === `http://hub/aa/pic/${d.id}/com.plexapp.android`, "items carry their picture");
ok(aa.search(d.id, { query: "net" }).media.map((x) => x.title).join() === "Netflix", "search by name");

// no favorites / recents / folders: the top level is the apps themselves
aa.setApps(d.id, d.apps.map((a) => ({ pkg: a.pkg, on: a.on, fav: false, folder: "" }))); d.recent = [];
ok(aa.browse(d.id, {}).media.items.every((x) => x.media_class === "app"), "nothing to group: browse shows the apps straight away");

// rescan keeps your choices
await aa.scan(d.id, []);
ok(d.apps.find((a) => a.pkg === "org.xbmc.kodi").name === "Kodi (local)" && aa.picked(d).length === 3, "scanning again keeps names and choices");

// a second instance reads the saved file
aa.closeAll(); aa.save(true);
const aa2 = new AndroidApps({ dir });
ok(aa2.devices.length === 1 && aa2.picked(aa2.devices[0]).length === 3, "settings survive a restart");
ok(aa2.remove(d.id) && aa2.devices.length === 0, "device removed");

tv.server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
