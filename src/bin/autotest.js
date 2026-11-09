// Auto Widget test (test build 1.3.7-autotest): one media player entity that shows device A, or device B
// while A's attribute equals a value (e.g. the Shield's source is "Plex"). It copies the shown device's
// attributes, forwards button presses to it, and passes media browsing and search on to it through the core.
// Everything is logged with timings so the test can tell what works and how fast.
import fs from "node:fs";

export const AUTOTEST_ID = "auto_test";
// attributes copied from the shown device to the test entity
const COPY = ["state", "media_title", "media_artist", "media_album", "media_image_url", "media_duration", "media_position",
  "media_position_updated_at", "media_type", "volume", "muted", "source", "source_list", "sound_mode", "sound_mode_list", "repeat", "shuffle"];
// every feature either kind of player may have, so the widget offers them all (fixed when the entity is made)
export const AUTOTEST_FEATURES = ["on_off", "toggle", "volume", "volume_up_down", "mute_toggle", "mute", "unmute", "play_pause", "stop",
  "next", "previous", "fast_forward", "rewind", "repeat", "shuffle", "seek", "media_duration", "media_position", "media_title",
  "media_artist", "media_album", "media_image_url", "media_type", "dpad", "home", "menu", "context_menu", "info", "settings",
  "select_source", "channel_switcher", "play_media", "browse_media", "search_media"];

export class AutoTest {
  constructor({ file, publish, getCore, now = () => Date.now() }) {
    this.file = file;
    this.publish = publish;
    this.getCore = getCore;
    this.now = now;
    this.cfg = { a: "", b: "", attr: "source", value: "Plex", hold: 3 };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(file, "utf8"))); } catch {}
    this.values = new Map(); // entity id -> attributes
    this.shown = "a";
    this.holdUntil = 0;
    this.lines = [];
    this.lastSent = "";
    this.readAt = 0;
  }

  get enabled() { return !!(this.cfg.a && this.cfg.b); }
  target() { return this.shown === "b" ? this.cfg.b : this.cfg.a; }
  log(text) {
    const t = new Date(this.now());
    this.lines.unshift({ at: t.toISOString(), text });
    this.lines.length = Math.min(this.lines.length, 150);
  }

  status() {
    const a = this.values.get(this.cfg.a) || {}, b = this.values.get(this.cfg.b) || {};
    const brief = (x) => ({ state: x.state, source: x.source, title: x.media_title, artist: x.media_artist, position: x.media_position, duration: x.media_duration, art: x.media_image_url ? `${String(x.media_image_url).slice(0, 22)}… (${String(x.media_image_url).length} chars)` : "" });
    return { config: this.cfg, shown: this.shown, target: this.target(), a: brief(a), b: brief(b), log: this.lines };
  }

  save(cfg) {
    const c = {
      a: String(cfg.a || "").trim(), b: String(cfg.b || "").trim(),
      attr: String(cfg.attr || "source").trim() || "source", value: String(cfg.value ?? ""),
      hold: Math.max(0, Math.min(60, Number(cfg.hold) || 0))
    };
    if (c.a && c.a === c.b) return { ok: false, errors: ["pick two different players"] };
    this.cfg = c;
    try { fs.writeFileSync(this.file, JSON.stringify(c, null, 2)); } catch {}
    this.values.clear();
    this.lastSent = "";
    this.readAt = 0;
    this.log(`settings saved: shows ${c.a || "?"}, switches to ${c.b || "?"} while ${c.attr} = "${c.value}" (back after ${c.hold} s)`);
    return { ok: true };
  }

  /** Reads both devices (once a second at most); the remote's events fill in between. */
  async read(force = false) {
    const core = this.getCore();
    if (!core || !this.enabled || (!force && this.now() - this.readAt < 1000)) return;
    this.readAt = this.now();
    for (const id of [this.cfg.a, this.cfg.b]) {
      try { const e = await core.get(`/entities/${encodeURI(id)}`); if (e) this.values.set(id, { ...(e.attributes || {}) }); } catch (e) { /* keep the old values */ }
    }
    this.evaluate("read");
  }

  /** An entity_change event from the remote. */
  event(id, attrs) {
    if (!this.enabled || !attrs || (id !== this.cfg.a && id !== this.cfg.b)) return;
    const at = this.now();
    const before = this.values.get(id) || {};
    this.values.set(id, { ...before, ...attrs });
    if (id === this.cfg.a && this.cfg.attr in attrs && before[this.cfg.attr] !== attrs[this.cfg.attr]) this.log(`event: ${id === this.cfg.a ? "A" : "B"} ${this.cfg.attr} → "${attrs[this.cfg.attr]}"`);
    if (id === this.cfg.b && "state" in attrs && before.state !== attrs.state) this.log(`event: B state → ${attrs.state}`);
    this.evaluate("event", at);
  }

  evaluate(why, at = this.now()) {
    if (!this.enabled) return;
    const a = this.values.get(this.cfg.a) || {};
    const isTrue = String(a[this.cfg.attr] ?? "") === this.cfg.value;
    let want = isTrue ? "b" : "a";
    if (isTrue) this.holdUntil = 0;
    else if (this.shown === "b") {
      if (!this.holdUntil) { this.holdUntil = this.now() + this.cfg.hold * 1000; this.log(`condition no longer true · back to A in ${this.cfg.hold} s`); }
      if (this.now() < this.holdUntil) want = "b";
    }
    if (want !== this.shown) {
      this.shown = want;
      this.holdUntil = 0;
      this.log(`switch → shows ${want === "b" ? "B" : "A"} (${this.target()}) · after a ${why}${why === "event" ? `, ${this.now() - at} ms after the event` : ""}`);
    }
    this.push();
  }

  /** Publishes the shown device's attributes when they changed. */
  push() {
    const src = this.values.get(this.target()) || {};
    const out = {};
    for (const k of COPY) if (src[k] !== undefined) out[k] = src[k];
    if (!out.state) out.state = "UNKNOWN";
    const sig = JSON.stringify(out);
    if (sig === this.lastSent) return;
    const t0 = this.now();
    this.lastSent = sig;
    this.publish(out);
    const art = out.media_image_url ? ` · artwork ${String(out.media_image_url).length} chars` : "";
    this.log(`published ${out.state}${out.media_title ? ` "${String(out.media_title).slice(0, 40)}"` : ""}${art} (${this.now() - t0} ms)`);
  }

  tick() {
    if (this.holdUntil && this.now() >= this.holdUntil) this.evaluate("timer");
    this.read().catch(() => {});
  }

  /** A button pressed on the test widget: sent to the device it shows. */
  async command(cmdId, params) {
    const core = this.getCore();
    const id = this.target();
    if (!core || !id) return { ok: false, error: "not set up" };
    const cmd = cmdId.includes(".") ? cmdId : `media_player.${cmdId}`;
    const t0 = this.now();
    try {
      await core.request("PUT", `/entities/${encodeURI(id)}/command`, { cmd_id: cmd, ...(params && Object.keys(params).length ? { params } : {}) });
      this.log(`button ${cmdId}${params ? " " + JSON.stringify(params).slice(0, 60) : ""} → ${this.shown === "b" ? "B" : "A"} ok (${this.now() - t0} ms)`);
      return { ok: true };
    } catch (e) {
      this.log(`button ${cmdId} → ${this.shown === "b" ? "B" : "A"} FAILED: ${e.message.slice(0, 120)}`);
      return { ok: false, error: e.message, status: e.status };
    }
  }

  /** Media browsing asked of the test widget: asked of the shown device through the core. */
  /** Browsing goes to the shown device, or to B when A shows (A, e.g. the Shield's Android TV player, can't browse). */
  browseTarget() { return this.shown === "b" ? this.cfg.b : this.cfg.b || this.cfg.a; }
  async browse(opts = {}) {
    const core = this.getCore();
    const id = this.browseTarget();
    const q = new URLSearchParams();
    if (opts.media_id !== undefined && opts.media_id !== null) q.set("media_id", opts.media_id);
    if (opts.media_type !== undefined && opts.media_type !== null) q.set("media_type", opts.media_type);
    if (opts.stable_ids) q.set("stable_ids", "true");
    q.set("page", String(opts.paging?.page || 1));
    q.set("limit", String(opts.paging?.limit || 10));
    const t0 = this.now();
    try {
      const r = await core.getPaged(`/entities/${encodeURI(id)}/media/browse?${q}`);
      const items = r.data?.media?.items?.length ?? 0;
      this.log(`browse ${opts.media_id ? `"${String(opts.media_id).slice(0, 40)}"` : "(top)"} on B: "${r.data?.media?.title || ""}", ${items} items, total ${r.count ?? "?"} (${this.now() - t0} ms)`);
      return { media: r.data?.media, pagination: { page: r.page ?? Number(q.get("page")), limit: r.limit ?? Number(q.get("limit")), count: r.count ?? items } };
    } catch (e) {
      this.log(`browse on B FAILED: ${e.message.slice(0, 160)}`);
      return e.status || 500;
    }
  }

  async search(opts = {}) {
    const core = this.getCore();
    const id = this.browseTarget();
    const q = new URLSearchParams({ query: String(opts.query || "") });
    if (opts.media_id) q.set("media_id", opts.media_id);
    if (opts.media_type) q.set("media_type", opts.media_type);
    q.set("page", String(opts.paging?.page || 1));
    q.set("limit", String(opts.paging?.limit || 10));
    const t0 = this.now();
    try {
      const r = await core.getPaged(`/entities/${encodeURI(id)}/media/search?${q}`);
      const list = Array.isArray(r.data) ? r.data : r.data?.media || [];
      this.log(`search "${String(opts.query || "").slice(0, 30)}" on B: ${list.length} results (${this.now() - t0} ms)`);
      return { media: list, pagination: { page: r.page ?? 1, limit: r.limit ?? list.length, count: r.count ?? list.length } };
    } catch (e) {
      this.log(`search on B FAILED: ${e.message.slice(0, 160)}`);
      return e.status || 500;
    }
  }
}
