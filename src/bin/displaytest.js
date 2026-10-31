// "Display test": a sensor that cycles through numbered test frames, to find out what a sensor widget on
// the remote can show and how fast it redraws. Test only: it will be replaced by display sensors.
//
// Round 1 (1.2.10): plain text, emoji, symbols, media, arrows, shapes, the remote's icon font, accents,
// long text, a "\n" line break and a unit all showed; the bar characters looked off; a counter every
// 0.5 s redraws live.
// Round 2 (1.2.11): how many characters fit (ruler, wide and narrow letters) per widget size, the bar
// styles, a moving bar (0.3 s and 0.2 s steps), and scrolling text (one character every 0.3 s).

const RULER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const SCROLL = "The quick brown fox jumps over the lazy dog · ";

/** A bar of `n` cells for f (0..1): "block" █░, or "smooth" with eighths. */
export function barText(f, n = 10, style = "block") {
  f = Math.max(0, Math.min(1, f));
  if (style === "smooth") {
    const e = Math.round(f * n * 8), full = Math.floor(e / 8), part = e % 8;
    return ("█".repeat(full) + (part ? "▏▎▍▌▋▊▉"[part - 1] : "")).padEnd(n, " ").slice(0, n);
  }
  const on = Math.round(f * n);
  return "█".repeat(on) + "░".repeat(n - on);
}

/** All frames of one round: [{ value, ms }]. `icons` (the remote's icon font characters) isn't used in round 2. */
export function testFrames() {
  const f = [];
  const line = (value, ms = 4000) => f.push({ value, ms });
  line(`1 Ruler: ${RULER}`, 8000);
  line("2 Wide: WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", 6000);
  line("3 Narrow: iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii", 6000);
  line(`4 Blocks ${barText(0.6)} 60 %`);
  line(`5 Smooth ${barText(0.65, 10, "smooth")} 65 %`);
  line("6 Squares ■■■■■■□□□□");
  line("7 Dots ●●●●●●○○○○");
  line("8 Line ━━━━━━━━────");
  line("9 One char ▁ ▂ ▃ ▄ ▅ ▆ ▇ █");
  line(`10 📺 ${barText(0.6, 8)} 60 %`);
  for (let i = 0; i <= 20; i++) f.push({ value: `11 ${barText(i / 20)} ${i * 5} %`, ms: 300 });
  for (let i = 0; i <= 40; i++) f.push({ value: `12 ${barText(i / 40, 10, "smooth")} ${Math.round(i * 2.5)} %`, ms: 200 });
  const chars = Array.from(SCROLL);
  for (let k = 0; k < 40; k++) {
    const r = chars.slice(k % chars.length).concat(chars.slice(0, k % chars.length), chars).slice(0, 20).join("");
    f.push({ value: `13 ${r}`, ms: k === 0 ? 1500 : 300 });
  }
  // other bar characters (round 1: ▁▂▃▄▅▆▇█ ░▒▓ "looked off")
  line("14 ▰▰▰▰▰▰▱▱▱▱ 60 %");
  line("15 ▮▮▮▮▮▮▯▯▯▯ 60 %");
  line("16 [######----] 60 %");
  line("17 ||||||······ 60 %");
  // several lines (round 1: two lines and long text worked)
  line("18 Three lines\nsecond line\nthird line", 6000);
  line("19 Four lines\nsecond line\nthird line\nfourth line", 6000);
  line("20 Long: Now playing Nina Simone, Feeling Good, from the album I Put a Spell on You (1965), track 7 of 11, on the living room speakers", 8000);
  line("21 Big\n62 %", 6000);
  return f;
}
export const roundMs = (frames) => frames.reduce((a, x) => a + x.ms, 0);

/** The frame at time t (ms since start). */
export function testAt(t, frames) {
  const total = roundMs(frames);
  let x = ((t % total) + total) % total;
  for (const fr of frames) { if (x < fr.ms) return { value: fr.value, unit: "" }; x -= fr.ms; }
  return { value: frames[0].value, unit: "" };
}

export class DisplayTest {
  /** update(attrs) pushes { state, value, unit } to the remote. */
  constructor({ update, now = () => Date.now(), warn = () => {} }) {
    this.update = update;
    this.now = now;
    this.warn = warn;
    this.frames = testFrames();
    this.start = now();
    this.last = "";
    this.timer = null;
  }
  tick() {
    const { value, unit } = testAt(this.now() - this.start, this.frames);
    if (value === this.last) return false;
    this.last = value;
    this.update({ state: "ON", value, unit });
    return true;
  }
  run() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.warn("display test:", e.message); } }, 50);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
