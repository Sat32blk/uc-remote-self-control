// "Display test": a sensor that cycles through numbered test frames, to find out what a sensor widget on
// the remote can show and how fast it redraws. Test only: it will be replaced by display sensors.
//
// Round 1 (1.2.10): plain text, emoji, symbols, media, arrows, shapes, the remote's icon font, accents,
// long text, a "\n" line break and a unit all showed; the bar characters looked off; a counter every
// 0.5 s redraws live.
// Round 2 (1.2.11): the whole 46-character ruler showed ("j"), scrolling text was smooth, bars made of
// █ ░ ■ □ ● ○ showed "crates" (missing-character boxes) after the first character.
// Round 2 (1.2.11) tested: how many characters fit (ruler, wide and narrow letters) per widget size, the bar
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

/** All frames of one round: [{ value, ms }]. Round 3 (1.2.12): one character per letter, so the user can
 *  say which letters have a "crate" (the font's missing-character box) after them. */
export function testFrames() {
  const f = [];
  const line = (value, ms = 6000) => f.push({ value, ms });
  line("1  A■ B□ C● D○ E▲ F▼");
  line("2  G█ H░ I▒ J▓ K▌ L▐");
  line("3  M▰ N▱ O▮ P▯ Q━ R─");
  line("4  S▁ T▄ U▆ V▪ W▫ X◼ Y◻");
  line("5  a■■■ b●●● c○○○ d□□□");
  line("6  e⬛⬛⬜⬜ f⚫⚫⚪⚪");
  line("7  g🟩🟩🟩⬜⬜ h🟢🟢🟢⚪⚪");
  line("8  i🟦🟦🟦⬛⬛ j🔵🔵🔵⚫⚫");
  line("9  k[####------] l|||||·····");
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
