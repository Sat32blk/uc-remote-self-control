// Android apps: finds the apps on Android TV devices over network debugging (adb.js) and offers them
// to the remote as one media player per TV ("<name> apps"): its input list and its Browse screen are
// the apps you picked, and picking one opens it on the TV. The TV's D-pad, Home, Back, play/pause and
// volume keys work too, so the widget's full-screen player is a complete remote for the TV.
//
// Config (android_apps.json): { devices: [{ id, name, host, port, apps: [{ pkg, act, name, pic, folder,
// fav, on, sys }], recent: [pkg] }] }. The adb key is kept apart in android_key.json.
import path from "node:path";
import { AdbDevice, makeKey } from "./adb.js";
import { readJson, writeText, saveLater } from "./safefile.js";

export const AA_PREFIX = "aa_";
// names of common Android TV apps (the TV doesn't tell its app names over adb without unpacking them)
const KNOWN = {
  "com.netflix.ninja": "Netflix", "com.google.android.youtube.tv": "YouTube", "com.google.android.youtube.tvkids": "YouTube Kids", "com.google.android.youtube.tvmusic": "YouTube Music",
  "com.plexapp.android": "Plex", "com.plexapp.mediaserver.smb": "Plex Media Server", "com.disney.disneyplus": "Disney+", "com.amazon.amazonvideo.livingroom": "Prime Video",
  "com.wbd.stream": "Max", "com.hbo.hbonow": "HBO Max", "com.hulu.livingroomplus": "Hulu", "com.spotify.tv.android": "Spotify", "org.xbmc.kodi": "Kodi",
  "com.valvesoftware.steamlink": "Steam Link", "tv.twitch.android.app": "Twitch", "tv.twitch.android.viewer": "Twitch", "com.tubitv": "Tubi", "tv.pluto.android": "Pluto TV",
  "com.crunchyroll.crunchyroid": "Crunchyroll", "com.teamsmart.videomanager.tv": "SmartTube", "com.liskovsoft.smarttubetv": "SmartTube", "com.apple.atve.androidtv.appletv": "Apple TV",
  "com.apple.android.music": "Apple Music", "com.peacocktv.peacockandroid": "Peacock", "com.cbs.ott": "Paramount+", "com.espn.score_center": "ESPN", "com.nvidia.geforcenow": "GeForce NOW",
  "com.nvidia.tegrazone3": "NVIDIA Games", "com.android.tv.settings": "Settings", "com.android.vending": "Google Play Store", "com.google.android.tvrecommendations": "Recommendations",
  "com.google.android.play.games": "Google Play Games", "com.google.android.videos": "Google TV", "com.google.android.apps.tv.launcherx": "Google TV Home", "com.sling": "Sling TV",
  "com.fubo.firetv.screen": "fuboTV", "com.philo.philo.google": "Philo", "com.vudu.android.app": "Vudu", "com.channelsapp.channels": "Channels", "com.amazon.avod": "Prime Video",
  "com.emby.embyatv": "Emby", "org.jellyfin.androidtv": "Jellyfin", "com.mxtech.videoplayer.ad": "MX Player", "org.videolan.vlc": "VLC", "com.dazn": "DAZN",
  "com.pandora.android.atv": "Pandora", "com.sonos.acr2": "Sonos", "com.amazon.music.tv": "Amazon Music", "tv.youi.youitv": "YouTube TV", "com.google.android.youtube.tvunplugged": "YouTube TV",
  "com.directv.dtvgo": "DIRECTV", "com.att.tv": "DIRECTV", "com.xfinity.cloudtvr.tenfoot": "Xfinity Stream", "com.frndlytv.android": "Frndly TV", "com.discovery.discoveryplus.androidtv": "discovery+",
  "com.starz.starzplay.android": "Starz", "com.showtime.standalone": "Showtime", "com.mlb.atbat": "MLB", "com.nba.game": "NBA", "com.nfl.nflapp": "NFL", "com.nhl.gc1112.free": "NHL"
};
const SKIP_PARTS = new Set(["com", "org", "net", "tv", "android", "app", "apps", "androidtv", "atv", "leanback", "livingroom", "livingroomplus", "google", "mobile", "ott", "player", "client", "main", "free", "stream"]);
/** A readable name for a package the KNOWN list doesn't have: "com.foo.barplayer.tv" → "Barplayer". */
export function appName(pkg) {
  if (KNOWN[pkg]) return KNOWN[pkg];
  const parts = pkg.split(".").filter((p) => p && !SKIP_PARTS.has(p.toLowerCase()));
  const best = parts.sort((a, b) => b.length - a.length)[0] || pkg.split(".").pop() || pkg;
  return best.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
const norm = (s) => String(s || "").toLowerCase().replace(/\.(png|jpe?g|webp)$/i, "").replace(/[^a-z0-9]+/g, "");
const ALIAS = { "primevideo": ["amazonprimevideo", "prime", "amazonvideo"], "xfinitystream": ["xfin", "xfinity"], "tubi": ["tubicurved"], "disney": ["disneyplus"], "appletv": ["appletvplus"], "paramount": ["paramountplus"], "max": ["hbomax"] };
/** The picture of the remote's library that fits an app's name best (exact, alias, or the name inside the file name). */
export function matchPicture(name, pics) {
  const n = norm(name).replace(/plus$/, ""), byNorm = new Map(pics.map((p) => [norm(p), p]));
  for (const k of [norm(name), n, ...(ALIAS[n] || [])]) if (byNorm.has(k)) return byNorm.get(k);
  const hit = pics.filter((p) => n.length >= 3 && norm(p).includes(n)).sort((a, b) => a.length - b.length)[0];
  return hit || "";
}

// parse what the TV prints
export const parseComponents = (out) => [...String(out).matchAll(/^\s*([A-Za-z][\w.]*)\/([\w.$]+)\s*$/gm)].map((m) => ({ pkg: m[1], act: m[2].startsWith(".") ? m[1] + m[2] : m[2] }));
export const parsePackages = (out) => [...String(out).matchAll(/^package:([\w.]+)\s*$/gm)].map((m) => m[1]);
export const parseFront = (out) => /(?:mResumedActivity|topResumedActivity|ResumedActivity)[^\n]*?\s([A-Za-z][\w.]*)\/[\w.$]+/.exec(String(out))?.[1] || "";

const KEYS = { cursor_up: 19, cursor_down: 20, cursor_left: 21, cursor_right: 22, cursor_enter: 23, back: 4, home: 3, menu: 82, play_pause: 85, stop: 86, next: 87, previous: 88,
  fast_forward: 90, rewind: 89, volume_up: 24, volume_down: 25, mute_toggle: 164, on: 224, off: 223, toggle: 26, info: 165, settings: 176, context_menu: 82, guide: 172, channel_up: 166, channel_down: 167 };
export const AA_FEATURES = ["on_off", "select_source", "play_media", "browse_media", "search_media", "media_title", "media_artist", "media_image_url", "media_type",
  "dpad", "home", "menu", "play_pause", "stop", "next", "previous", "fast_forward", "rewind", "volume_up_down", "mute_toggle", "info", "settings", "context_menu", "guide", "channel_switcher"];

export class AndroidApps {
  /**
   * opts: { dir (config folder), getCore, picUrl: (devId, pkg) => url | "", onChange: (devId, attrs) => {}, log, warn,
   *         adb: (opts) => AdbDevice (tests), pollMs }
   */
  constructor(opts) {
    Object.assign(this, { log: () => {}, warn: () => {}, onChange: () => {}, picUrl: () => "", pollMs: 10000 }, opts);
    this.file = path.join(this.dir, "android_apps.json");
    this.keyFile = path.join(this.dir, "android_key.json");
    this.devices = [];
    this.conn = new Map(); // id -> AdbDevice
    this.front = {}; // id -> package in front
    this.status = {}; // id -> { state, error, model }
    this.later = saveLater(() => this.write());
    this.load();
  }
  load() {
    try { this.devices = (readJson(this.file).devices || []).filter((d) => d && d.id && d.host); } catch { this.devices = []; }
    for (const d of this.devices) { d.apps = d.apps || []; d.recent = d.recent || []; d.port = d.port || 5555; }
  }
  write() { writeText(this.file, JSON.stringify({ devices: this.devices }, null, 2)); }
  save(now = false) { if (now) { this.later.flush(); this.write(); } else this.later.schedule(); }
  key() {
    if (this._key) return this._key;
    try { this._key = readJson(this.keyFile); if (this._key.privatePem && this._key.publicKey) return this._key; } catch {}
    this._key = makeKey("uc-self-control");
    writeText(this.keyFile, JSON.stringify(this._key));
    return this._key;
  }
  dev(id) { return this.devices.find((d) => d.id === id); }
  entityId(d) { return AA_PREFIX + d.id; }
  adb(d) {
    let c = this.conn.get(d.id);
    if (c && (c.host !== d.host || c.port !== d.port)) { c.close(); c = null; }
    if (!c) {
      const make = this.adbFactory || ((o) => new AdbDevice(o));
      c = make({ host: d.host, port: d.port, key: this.key(), onState: (s, err) => { this.status[d.id] = { ...(this.status[d.id] || {}), state: s, error: err, model: c?.model || this.status[d.id]?.model || "" }; this.publish(d); } });
      this.conn.set(d.id, c);
    }
    return c;
  }
  async shell(d, cmd, opts) { return this.adb(d).shell(cmd, opts); }

  // ---- devices ----
  add({ name, host, port = 5555 }) {
    host = String(host || "").trim();
    if (!/^[A-Za-z0-9.\-:]+$/.test(host)) throw new Error("the address looks wrong");
    if (this.devices.some((d) => d.host === host && d.port === port)) throw new Error("that device is already in the list");
    const base = String(name || "Android TV").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "tv";
    let id = base, i = 2;
    while (this.dev(id)) id = `${base}_${i++}`;
    const d = { id, name: String(name || "Android TV").slice(0, 40), host, port: Number(port) || 5555, apps: [], recent: [], added: false };
    this.devices.push(d); this.save(true);
    return d;
  }
  remove(id) {
    const d = this.dev(id); if (!d) return false;
    this.conn.get(id)?.close(); this.conn.delete(id);
    this.devices = this.devices.filter((x) => x !== d); delete this.status[id]; delete this.front[id];
    this.save(true); return true;
  }
  rename(id, name) { const d = this.dev(id); if (!d) return; d.name = String(name || d.name).slice(0, 40); this.save(true); }
  /** Connects (the TV may ask "Allow network debugging?"); resolves when it's allowed. */
  async connect(id) { const d = this.dev(id); if (!d) throw new Error("no such device"); await this.adb(d).connect(); return this.view(id); }

  /** Lists the TV's launchable apps, keeps your names / pictures / choices, matches new ones to pictures. */
  async scan(id, pics = []) {
    const d = this.dev(id); if (!d) throw new Error("no such device");
    // the apps a TV's home screen can open (Android 10+ knows --components; older ones print more with --brief)
    const ask = (flag) => this.shell(d, `cmd package query-activities ${flag} -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER`).catch(() => "");
    let found = parseComponents(await ask("--components"));
    if (!found.length) found = parseComponents(await ask("--brief"));
    if (!found.length) found = parsePackages(await this.shell(d, "pm list packages -3")).map((pkg) => ({ pkg, act: "" }));
    const sys = new Set(parsePackages(await this.shell(d, "pm list packages -s").catch(() => "")));
    const seen = new Set(), had = new Map(d.apps.map((a) => [a.pkg, a]));
    const apps = [];
    for (const f of found) {
      if (seen.has(f.pkg)) continue; seen.add(f.pkg);
      const old = had.get(f.pkg);
      if (old) { apps.push({ ...old, act: f.act || old.act, sys: sys.has(f.pkg), gone: false }); continue; }
      const name = appName(f.pkg);
      apps.push({ pkg: f.pkg, act: f.act, name, pic: matchPicture(name, pics), folder: "", fav: false, on: false, sys: sys.has(f.pkg) });
    }
    // picked apps the TV doesn't list any more: kept (marked) so a page button doesn't silently break
    for (const a of d.apps) if (!seen.has(a.pkg) && a.on) apps.push({ ...a, gone: true });
    d.apps = apps; d.scannedAt = Date.now();
    this.save(true); this.publish(d);
    return { apps, found: found.length, system: [...seen].filter((p) => sys.has(p)).length };
  }
  /** Saves your choices for a device's apps: [{ pkg, name, pic, folder, fav, on }]. */
  setApps(id, list) {
    const d = this.dev(id); if (!d) throw new Error("no such device");
    const by = new Map(list.map((x) => [x.pkg, x]));
    for (const a of d.apps) {
      const x = by.get(a.pkg); if (!x) continue;
      a.on = !!x.on; a.fav = !!x.fav;
      if (typeof x.name === "string" && x.name.trim()) a.name = x.name.trim().slice(0, 40);
      if (typeof x.folder === "string") a.folder = x.folder.trim().slice(0, 30);
      if (typeof x.pic === "string") a.pic = x.pic.slice(0, 120);
    }
    // the order you see is the order on the remote
    const order = list.map((x) => x.pkg);
    d.apps.sort((a, b) => (order.indexOf(a.pkg) + 1 || 1e9) - (order.indexOf(b.pkg) + 1 || 1e9));
    this.save(true); this.publish(d);
    return d;
  }
  picked(d) { return d.apps.filter((a) => a.on && !a.gone); }

  // ---- launching and keys ----
  async launch(id, pkg) {
    const d = this.dev(id); if (!d) throw new Error("no such device");
    const a = d.apps.find((x) => x.pkg === pkg);
    if (!a) throw new Error("that app isn't in the list");
    const out = a.act ? await this.shell(d, `am start -n ${a.act.includes("/") ? a.act : `${a.pkg}/${a.act}`}`) : "";
    if (!a.act || /Error|does not exist|unable to resolve/i.test(out)) await this.shell(d, `monkey -p ${a.pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`);
    this.front[id] = pkg;
    d.recent = [pkg, ...d.recent.filter((p) => p !== pkg)].slice(0, 12);
    this.save(); this.publish(d);
    return true;
  }
  /** Sends a key to the TV (input keyevent). */
  async press(id, cmd) {
    const d = this.dev(id); if (!d) throw new Error("no such device");
    const code = KEYS[cmd]; if (!code) return false;
    await this.shell(d, `input keyevent ${code}`);
    if (cmd === "home" || cmd === "back") setTimeout(() => this.refresh(id).catch(() => {}), 700);
    return true;
  }
  /** Which app is in front now (updates the widget). */
  async refresh(id) {
    const d = this.dev(id); if (!d) return;
    const out = await this.shell(d, "dumpsys activity activities | grep -E 'ResumedActivity'", { timeoutMs: 8000 });
    const pkg = parseFront(out);
    if (pkg && pkg !== this.front[id]) {
      this.front[id] = pkg;
      if (d.apps.some((a) => a.pkg === pkg && a.on)) { d.recent = [pkg, ...d.recent.filter((p) => p !== pkg)].slice(0, 12); this.save(); }
      this.publish(d);
    }
  }
  /** Checks the TVs that are on the remote (every pollMs while the remote is awake; driver calls it). */
  async poll() {
    for (const d of this.devices.filter((x) => x.added)) {
      const c = this.conn.get(d.id);
      if (c && c.state === "waiting") continue;
      try { await this.refresh(d.id); } catch {}
    }
  }
  closeAll() { for (const c of this.conn.values()) c.close(); this.conn.clear(); }

  // ---- what the remote sees ----
  attrs(d) {
    const st = this.status[d.id]?.state, pk = this.front[d.id], app = d.apps.find((a) => a.pkg === pk);
    const name = app?.name || (pk ? appName(pk) : "");
    return {
      state: st === "ok" ? "ON" : st === "error" ? "UNAVAILABLE" : "ON",
      source: name, source_list: this.picked(d).map((a) => a.name),
      media_title: name || d.name, media_artist: d.name, media_type: "app",
      media_image_url: app?.pic ? this.picUrl(d.id, app.pkg) : ""
    };
  }
  publish(d) { try { this.onChange(this.entityId(d), this.attrs(d)); } catch {} }
  /** A remote command for a device's entity (cmdId without the media_player. prefix). */
  async command(id, cmdId, params = {}) {
    const d = this.dev(id); if (!d) return 404;
    try {
      if (cmdId === "select_source") {
        const a = this.picked(d).find((x) => x.name === params?.source) || d.apps.find((x) => x.name === params?.source);
        if (!a) return 400;
        await this.launch(id, a.pkg); return 200;
      }
      if (cmdId === "play_media") {
        const pkg = String(params?.media_id || "").replace(/^app:/, "");
        if (!d.apps.some((a) => a.pkg === pkg)) return 404;
        await this.launch(id, pkg); return 200;
      }
      if (KEYS[cmdId]) { await this.press(id, cmdId); return 200; }
      return 400;
    } catch (e) { this.warn(`android apps: ${d.name} ${cmdId}:`, e.message); return 503; }
  }
  item(d, a) {
    const thumb = a.pic ? this.picUrl(d.id, a.pkg) : "";
    return { media_id: "app:" + a.pkg, title: a.name, subtitle: a.folder || undefined, media_class: "app", media_type: "app", can_play: true, can_browse: false, ...(thumb ? { thumbnail: thumb } : {}) };
  }
  folders(d) { return [...new Set(this.picked(d).map((a) => a.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
  /** Browse: the top shows Favorites, Recently used, All apps and your folders; each opens a list of apps. */
  browse(id, opts = {}) {
    const d = this.dev(id); if (!d) return 404;
    const page = Math.max(1, Number(opts.paging?.page) || 1), limit = Math.max(1, Math.min(100, Number(opts.paging?.limit) || 20));
    const mid = opts.media_id || "root";
    const apps = this.picked(d);
    const dir = (media_id, title, n) => ({ media_id, title, subtitle: `${n} app${n === 1 ? "" : "s"}`, media_class: "directory", media_type: "apps", can_browse: true, can_play: false });
    let title, list;
    if (mid === "root") {
      title = d.name;
      const favs = apps.filter((a) => a.fav), recent = d.recent.map((p) => apps.find((a) => a.pkg === p)).filter(Boolean);
      list = [
        ...(favs.length ? [dir("fav", "Favorites", favs.length)] : []),
        ...(recent.length ? [dir("recent", "Recently used", recent.length)] : []),
        dir("all", "All apps", apps.length),
        ...this.folders(d).map((f) => dir("folder:" + f, f, apps.filter((a) => a.folder === f).length))
      ];
      // with no favorites, recents or folders, show the apps straight away
      if (list.length === 1) { title = d.name; list = apps.map((a) => this.item(d, a)); }
    } else if (mid === "fav") { title = "Favorites"; list = apps.filter((a) => a.fav).map((a) => this.item(d, a)); }
    else if (mid === "recent") { title = "Recently used"; list = d.recent.map((p) => apps.find((a) => a.pkg === p)).filter(Boolean).map((a) => this.item(d, a)); }
    else if (mid === "all") { title = "All apps"; list = [...apps].sort((a, b) => a.name.localeCompare(b.name)).map((a) => this.item(d, a)); }
    else if (mid.startsWith("folder:")) { const f = mid.slice(7); title = f; list = apps.filter((a) => a.folder === f).map((a) => this.item(d, a)); }
    else return 404;
    const slice = list.slice((page - 1) * limit, page * limit);
    return { media: { media_id: mid, title, media_class: "directory", media_type: "apps", can_browse: true, can_play: false, items: slice }, pagination: { page, limit, count: list.length } };
  }
  search(id, opts = {}) {
    const d = this.dev(id); if (!d) return 404;
    const q = norm(opts.query);
    const page = Math.max(1, Number(opts.paging?.page) || 1), limit = Math.max(1, Math.min(100, Number(opts.paging?.limit) || 20));
    const list = this.picked(d).filter((a) => !q || norm(a.name).includes(q) || norm(a.folder).includes(q)).map((a) => this.item(d, a));
    return { media: list.slice((page - 1) * limit, page * limit), pagination: { page, limit, count: list.length } };
  }
  view(id) {
    const one = (d) => ({ ...d, entity: this.entityId(d), status: this.status[d.id] || { state: this.conn.get(d.id)?.state || "off" }, front: this.front[d.id] || "" });
    return id ? one(this.dev(id)) : { devices: this.devices.map(one) };
  }
}
