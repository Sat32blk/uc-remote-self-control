// Diagnostic: listens to the remote's own WebSocket Core-API events and keeps the recent ones that
// concern activities. Used to find out whether the remote reports anything when ↩ reopens an activity
// that is still on (its REST state doesn't change, so polling can't see it). Only records; acts on nothing.
import WebSocket from "ws";

const MAX = 40;

export class CoreEvents {
  constructor({ address, apiKey, log = () => {}, warn = () => {} }) {
    Object.assign(this, { address, apiKey, log, warn });
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
    const text = JSON.stringify(m.msg_data ?? {});
    // keep events about activities (and anything that looks like UI / navigation)
    if (!/activity|uc\.main\.|"ui|page/i.test(text + (m.msg || "") + (m.cat || ""))) return;
    this.events.unshift({ at: new Date().toISOString(), msg: m.msg, cat: m.cat, data: text.slice(0, 400) });
    if (this.events.length > MAX) this.events.length = MAX;
  }

  status() {
    return { state: this.state, error: this.error, events: this.events };
  }
}
