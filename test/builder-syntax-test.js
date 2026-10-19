// The builder page's inline script must parse (a syntax error leaves a blank page with no login).
import fs from "node:fs";
const s = fs.readFileSync(new URL("../src/bin/web/builder.html", import.meta.url), "utf8");
const scripts = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let fails = 0;
for (const [i, c] of scripts.entries()) {
  try { new Function(c); console.log(`PASS builder script ${i + 1} parses`); }
  catch (e) { console.log(`FAIL builder script ${i + 1}: ${e.message}`); fails++; }
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
