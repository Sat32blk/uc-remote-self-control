// Display test sensor (round 3): one character per letter.
import { testFrames, testAt, roundMs, barText, DisplayTest } from "../src/bin/displaytest.js";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const fr = testFrames();
ok(fr.length === 9 && fr.every((x, i) => x.value.startsWith(i + 1 + " ")), "9 numbered frames");
ok(fr.every((x) => x.ms === 6000), "6 s each");
ok(fr[0].value.includes("A■") && fr[1].value.includes("G█"), "letters before characters");
ok(barText(0.6) === "██████░░░░", "bar helper still there");
ok(testAt(roundMs(fr) + 1, fr).value === fr[0].value, "starts over after a round");
let t = 0; const sent = [];
const dt = new DisplayTest({ update: (a) => sent.push(a), now: () => t });
dt.tick(); dt.tick(); t = 6001; dt.tick();
ok(sent.length === 2 && sent[1].value.startsWith("2 "), "pushes only when the text changes");
console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
