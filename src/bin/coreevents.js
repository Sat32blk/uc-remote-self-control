// Listens to the remote's own WebSocket Core-API events. Tested on a Remote 3 (2026-10-19): opening an
// activity, even one that is already on (e.g. with ↩), makes the core send an entity_change for it with
// state "ON" (after "RUNNING" steps if it re-runs its start sequence). REST polling can't see that, so
// these events tell the return tracker which activity was opened. Recent activity events are kept for
// the builder's test panel.
import WebSocket from "ws";

const MAX = 40;

export class CoreEvents {
  constructor({ address, apiKey, onActivity = () => {}, log = () => {}, warn = () => {} }) {
    Object.assign(this, { address, apiKey, onActivity, log, warn });
    this.events = [];
    this.ws = null;
    this.state = "off";
    this.error = null;
    this.retry = null;
    this.wanted = false;
  }

  start() {
    this.wanted = true;
    if (this.ws) return;
    clearTimeout(this.retry);
    const url = `ws://${this.address || "127.0.0.1"}/ws`;
    let ws;
    try {
      ws = new WebSocket(url, { headers: { "API-KEY": this.apiKey, Authorization: `Bearer ${this.apiKey}` }, handshakeTimeout: 5000 });
    } catch (e) {
      this.fail(e.message);
      return;
    }
    this.ws = ws;
    this.state = "connecting";
    ws.on("open", () => {
      this.state = "connected";
      this.error = null;
      ws.send(JSON.stringify({ kind: "req", id: 1, msg: "subscribe_events", msg_data: { channels: ["all"] } }));
    });
    ws.on("message", (raw) => this.onMessage(raw));
    ws.on("error", (e) => { this.error = e.message; });
    ws.on("close", () => {
      this.ws = null;
      this.state = "off";
      if (this.wanted) this.retry = setTimeout(() => this.start(), 30000);
    });
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.state = "off";
  }

  fail(msg) {
    this.error = msg;
    this.ws = null;
    this.state = "off";
    if (this.wanted) this.retry = setTimeout(() => this.start(), 30000);
  }

  onMessage(raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.kind === "resp" && m.id === 1) {
      if (m.code && m.code >= 300) this.error = `subscribing failed (${m.code})`;
      return;
    }
    if (m.kind !== "event") return;
    const d = m.msg_data || {};
    const state = d.new_state?.attributes?.state;
    // an activity reported as ON = it was opened (started, or reopened while already on)
    if (m.msg === "entity_change" && d.entity_type === "activity" && d.entity_id && String(state || "").toUpperCase() === "ON") {
      try { this.onActivity(d.entity_id); } catch (e) { this.warn("events: " + e.message); }
    }
    if (d.entity_type !== "activity") return; // keep the panel to activities
    const text = JSON.stringify(d);
    this.events.unshift({ at: new Date().toISOString(), msg: m.msg, cat: m.cat, data: text.slice(0, 400) });
    if (this.events.length > MAX) this.events.length = MAX;
  }

  status() {
    return { state: this.state, error: this.error, events: this.events };
  }
}
