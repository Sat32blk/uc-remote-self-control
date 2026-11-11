// Runs every test file, several at a time (each test uses its own ports and temporary folders).
// node test/run-all.js            all tests
// node test/run-all.js smart pages only the files whose name contains one of these words
// TEST_JOBS=1 node test/run-all.js  one at a time
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRST = "builder-syntax-test.js"; // quick check of the builder page: if it fails, nothing else runs
const words = process.argv.slice(2);
const files = fs.readdirSync(HERE).filter((f) => f.endsWith("-test.js") && f !== FIRST && (!words.length || words.some((w) => f.includes(w)))).sort();
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || 4); // the tests mostly wait, so more than the CPU count is fine

function run(file) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { cwd: path.join(HERE, ".."), env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { out += "\n(timed out after 10 min)"; child.kill("SIGKILL"); }, 600000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ file, code, out, secs: ((Date.now() - t0) / 1000).toFixed(1) }); });
  });
}

// the driver tests start src/bin/driver.js, which needs a driver.json beside it: one fresh copy for all
const binJson = path.join(HERE, "..", "src", "bin", "driver.json");
fs.copyFileSync(path.join(HERE, "..", "src", "driver.json"), binJson);
process.on("exit", () => fs.rmSync(binJson, { force: true }));

const t0 = Date.now();
const results = [];
const report = (r) => {
  results.push(r);
  const fails = r.out.split("\n").filter((l) => l.startsWith("FAIL"));
  console.log(`${r.code === 0 ? "ok  " : "FAIL"} ${r.file} (${r.secs} s)`);
  if (r.code !== 0) console.log((fails.length ? fails : r.out.trim().split("\n").slice(-15)).map((l) => "     " + l).join("\n"));
};

if (!words.length || FIRST.includes(words[0])) {
  const r = await run(FIRST);
  report(r);
  if (r.code !== 0) process.exit(1);
}
const queue = [...files];
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) report(await run(queue.shift())); }));

const failed = results.filter((r) => r.code !== 0);
if (process.env.TEST_VERBOSE) for (const r of results) console.log(`\n==== ${r.file}\n${r.out}`);
console.log(`\n${results.length - failed.length} of ${results.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(0)} s (${jobs} at a time)`);
process.exit(failed.length ? 1 : 0);
