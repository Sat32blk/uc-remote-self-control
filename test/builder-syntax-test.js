// The builder's and the Page Editor's inline scripts must parse (a syntax error leaves a blank page with no login).
import fs from "node:fs";
let fails = 0;
// The remote refuses an archive whose driver.json version is over 20 characters ("invalid archive").
const drv = JSON.parse(fs.readFileSync(new URL("../src/driver.json", import.meta.url), "utf8"));
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (drv.version.length <= 20 && /^[0-9A-Za-z.+-]+$/.test(drv.version)) console.log(`PASS version "${drv.version}" is ${drv.version.length} characters (the remote allows 20)`);
else { console.log(`FAIL version "${drv.version}" is ${drv.version.length} characters: the remote allows at most 20`); fails++; }
if (pkg.version === drv.version) console.log("PASS package.json and driver.json versions match");
else { console.log(`FAIL package.json ${pkg.version} vs driver.json ${drv.version}`); fails++; }
for (const page of ["builder", "editor"]) {
  const s = fs.readFileSync(new URL(`../src/bin/web/${page}.html`, import.meta.url), "utf8");
  const scripts = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) { console.log(`FAIL ${page}: no script`); fails++; }
  for (const [i, c] of scripts.entries()) {
    try { new Function(c); console.log(`PASS ${page} script ${i + 1} parses`); }
    catch (e) { console.log(`FAIL ${page} script ${i + 1}: ${e.message}`); fails++; }
  }
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
