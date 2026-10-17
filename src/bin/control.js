// "Control" test (0.7.0-test): one media-player entity the remote's volume rocker, touch slider and
// on-screen slider can be pointed at. Its volume is a stand-in for whatever is being controlled:
// normally the screen brightness; after "Control: Light" is pressed, a light (read and set through the
// remote's own entity, e.g. a Home Assistant light). After a few seconds without use it goes back.

const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

export class ControlProxy {
  /**
   * @param {object} o
   * @param {() => any} o.getCore
   * @param {(attrs: object) => void} o.publish   sends media-player attributes to the remote
   * @param {() => number} o.getDisplay            current screen brightness 0..100
   * @param {(pct: number) => Promise<void>} o.setDisplay
   */
  constructor({ getCore, publish, getDisplay, setDisplay, log = () => {}, warn = () => {}, idleMs = 8000, step = 5 }) {
    Object.assign(this, { getCore, publish, getDisplay, setDisplay, log, warn, idleMs, step });
    this.light = null; // { id, name }
    this.mode = "display";
    this.value = 50;
    this.timer = null;
    this.sending = false;
    this.pending = null;
  }

  static SOURCES = { display: "Screen brightness" };

  sources() {
    return [ControlProxy.SOURCES.display, ...(this.light ? [this.light.name] : [])];
  }

  /** Finds a light to test with: the first Home Assistant light, else any light that isn't ours. */
  async findLight(fetchAll) {
    const core = this.getCore();
    if (!core) return;
    try {
      const all = await fetchAll(core, "/entities");
      const lights = all.filter((e) => e.entity_type === "light" && !String(e.entity_id).startsWith("self_control."));
      const pick = lights.find((e) => String(e.entity_id).startsWith("hass.")) || lights[0];
      if (pick) {
        const n = pick.name;
        this.light = { id: pick.entity_id, name: (typeof n === "string" ? n : n?.en || Object.values(n || {})[0]) || pick.entity_id };
        this.log(`control test: light target is "${this.light.name}"`);
      } else this.warn("control test: no light found on the remote");
    } catch (e) {
      this.warn("control test: couldn't list lights:", e.message);
    }
    this.show();
  }

  attrs() {
    const active = this.mode !== "display";
    const name = active ? this.light?.name || "Light" : ControlProxy.SOURCES.display;
    return {
      state: "ON",
      volume: this.value,
      muted: false,
      source: name,
      source_list: this.sources(),
      media_title: active ? `💡 ${name}` : "Normal controls",
      media_artist: active ? `Control active · ${this.value} %` : `${name} · ${this.value} %`,
      media_album: active ? `back to normal after ${Math.round(this.idleMs / 1000)} s without use` : ""
    };
  }

  show() {
    this.publish(this.attrs());
  }

  async readTarget() {
    if (this.mode === "display") return pct(this.getDisplay());
    const core = this.getCore();
    const e = await core.get(`/entities/${encodeURI(this.light.id)}`);
    const a = e?.attributes || {};
    if (a.state === "OFF") return 0;
    return a.brightness === undefined ? this.value : pct((a.brightness / 255) * 100);
  }

  async writeTarget(v) {
    if (this.mode === "display") return this.setDisplay(Math.max(1, v));
    const core = this.getCore();
    const body = v <= 0 ? { cmd_id: "light.off" } : { cmd_id: "light.on", params: { brightness: Math.round((v / 100) * 255) } };
    await core.request("PUT", `/entities/${encodeURI(this.light.id)}/command`, body);
  }

  /** Switches what the controls change and loads its current value. */
  async activate(mode) {
    if (mode === "light" && !this.light) throw new Error("no light found on the remote");
    this.mode = mode;
    try { this.value = await this.readTarget(); } catch (e) { this.warn("control test: read failed:", e.message); }
    this.log(`control test: now controlling ${mode === "display" ? "the screen brightness" : this.light.name} (${this.value} %)`);
    this.show();
    this.arm();
  }

  arm() {
    clearTimeout(this.timer);
    if (this.mode === "display") return;
    this.timer = setTimeout(() => {
      this.activate("display").catch((e) => this.warn("control test:", e.message));
    }, this.idleMs);
  }

  /** Sends the latest value; values arriving while one is being sent replace each other. */
  async set(v) {
    this.value = pct(v);
    this.show();
    this.arm();
    this.pending = this.value;
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.pending !== null) {
        const next = this.pending;
        this.pending = null;
        await this.writeTarget(next);
      }
    } catch (e) {
      this.warn("control test: set failed:", e.message);
    } finally {
      this.sending = false;
    }
  }

  /** Media-player commands from the remote. */
  async command(cmd, params = {}) {
    this.log(`control test: ${cmd} ${JSON.stringify(params)}`);
    switch (cmd) {
      case "volume": return this.set(params.volume);
      case "volume_up": return this.set(this.value + this.step);
      case "volume_down": return this.set(this.value - this.step);
      case "select_source": return this.activate(params.source === ControlProxy.SOURCES.display ? "display" : "light");
      case "on": case "off": case "toggle": case "mute_toggle": case "mute": case "unmute":
        this.show(); return;
      default: throw new Error(`unsupported command ${cmd}`);
    }
  }
}
