// "Display test": a sensor that cycles through lines of different characters, to find out what a
// sensor widget on the remote can show (plain text, symbols, emoji, the remote's own icon font, long text,
// two lines, a unit) and how quickly it redraws (a counter every 0.5 s). Each line starts with its number,
// so it's easy to say which ones showed properly. Test only: it will be replaced by display sensors.

export const LINE_MS = 4000;
export const COUNT_MS = 500;
export const COUNT_TO = 20;

/** The test lines; `icons` is a few characters of the remote's icon font (or null if it wasn't found). */
export function testLines(icons) {
  return [
    { value: "1 Plain: Vol 37 % · −35.5 dB" },
    { value: "2 Emoji: 💡 🔇 🎬 🔊 ⚠️ 🎵" },
    { value: "3 Symbols: ★ ☀ ⚠ ♪ ♫ ☾ ✓ ✕" },
    { value: "4 Media: ▶ ⏸ ⏯ ⏹ ⏮ ⏭ ⏻" },
    { value: "5 Arrows: → ← ↑ ↓ ⇄ ↩ ⇅" },
    { value: "6 Shapes: ● ○ ■ □ ▲ ▼ ◆ ◎" },
    { value: "7 Bars: ▁▂▃▄▅▆▇█ ░▒▓" },
    { value: icons ? `8 UC icons: ${icons}` : "8 UC icons: (icon font not found)" },
    { value: "9 Accents: é ü ñ ç ø å ß" },
    { value: "10 Long: The quick brown fox jumps over the lazy dog 0123456789 ABCDEFGHIJ" },
    { value: "11 Two lines: first line\nsecond line" },
    { value: "12 Unit: 37", unit: "dB" },
  ];
}

/** Where the cycle is at time `t` (ms since start): { value, unit } — the lines, then a fast counter. */
export function testAt(t, lines) {
  const lineSpan = lines.length * LINE_MS, total = lineSpan + COUNT_TO * COUNT_MS;
  const x = ((t % total) + total) % total;
  if (x < lineSpan) { const l = lines[Math.floor(x / LINE_MS)]; return { value: l.value, unit: l.unit || "" }; }
  return { value: `13 Speed: ${Math.floor((x - lineSpan) / COUNT_MS) + 1} of ${COUNT_TO}`, unit: "" };
}

export class DisplayTest {
  /** update(attrs) pushes { state, value, unit } to the remote; getIcons() resolves to a string or null. */
  constructor({ update, getIcons = async () => null, now = () => Date.now(), warn = () => {} }) {
    this.update = update;
    this.getIcons = getIcons;
    this.now = now;
    this.warn = warn;
    this.lines = testLines(null);
    this.start = now();
    this.last = "";
    this.timer = null;
    this.iconsTried = 0;
  }
  async loadIcons() {
    if (Date.now() - this.iconsTried < 5 * 60 * 1000) return;
    this.iconsTried = Date.now();
    try { const s = await this.getIcons(); if (s) this.lines = testLines(s); } catch (e) { this.warn("display test: icon font:", e.message); }
  }
  tick() {
    const { value, unit } = testAt(this.now() - this.start, this.lines);
    const key = value + "|" + unit;
    if (key === this.last) return false;
    this.last = key;
    this.update({ state: "ON", value, unit });
    return true;
  }
  run() {
    if (this.timer) return;
    this.loadIcons();
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.warn("display test:", e.message); } }, 250);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
