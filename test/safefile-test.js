// Safe saving: atomic writes, .bak kept, damaged or missing files fall back to the backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, readText, writeJson, writeText, exists, remove } from "../src/bin/safefile.js";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safefile-"));
const f = path.join(dir, "sub", "x.json");
console.warn = () => {};

let threw = false;
try { readJson(f); } catch { threw = true; }
ok(threw && !exists(f), "missing file throws");

writeJson(f, { a: 1 });
ok(readJson(f).a === 1 && !fs.existsSync(f + ".bak") && !fs.existsSync(f + ".tmp"), "first save: no backup, no temp file");
writeJson(f, { a: 2 }, 2);
ok(readJson(f).a === 2 && JSON.parse(fs.readFileSync(f + ".bak", "utf8")).a === 1, "second save keeps the previous version as .bak");

fs.writeFileSync(f, '{"a": 3, "half'); // a half-written file from an older version
ok(readJson(f).a === 1, "damaged file falls back to the backup");
writeJson(f, { a: 4 });
ok(readJson(f).a === 4 && JSON.parse(fs.readFileSync(f + ".bak", "utf8")).a === 1, "saving after a damaged file works and keeps the good backup");
writeJson(f, { a: 4 });

fs.writeFileSync(f, ""); // an empty file is never copied over a good backup
writeText(f, '{"a":5}');
ok(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).a === 4 && readJson(f).a === 5, "an empty file does not replace the backup");

fs.rmSync(f);
ok(readText(f) === '{"a":4}' && exists(f), "deleted file falls back to the backup");

remove(f);
threw = false;
try { readJson(f); } catch { threw = true; }
ok(threw && !exists(f), "remove() deletes the file and its backup");

const g = path.join(dir, "y.json");
fs.writeFileSync(g, "{broken");
threw = false;
try { readJson(g); } catch { threw = true; }
ok(threw && fs.readdirSync(dir).some((n) => n.startsWith("y.json.damaged-")), "a damaged file with no backup is kept as a .damaged copy");

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
