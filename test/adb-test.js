// The built-in adb client against a fake TV: key format, allow prompt, signature, shell output.
import { makeKey, AdbDevice, parseAdbPublicKey } from "../src/bin/adb.js";
import { startMockAdbd, verify } from "./mock-adbd.js";
import crypto from "node:crypto";
import { signToken } from "../src/bin/adb.js";

let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

const key = makeKey("test@hub");
const { n, e } = parseAdbPublicKey(key.publicKey);
const jwk = crypto.createPublicKey(key.privatePem).export({ format: "jwk" });
ok(n === BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex")) && e === 65537, "public key in adb's format holds the right modulus and exponent");
ok(key.publicKey.endsWith(" test@hub"), "public key carries a name");
{ // the two Montgomery values the TV uses: n0inv = -1/n mod 2^32, rr = (2^2048)^2 mod n
  const raw = Buffer.from(key.publicKey.split(" ")[0], "base64"), M32 = 1n << 32n;
  const n0inv = BigInt(raw.readUInt32LE(4));
  let rr = 0n; for (let i = 63; i >= 0; i--) rr = rr * M32 + BigInt(raw.readUInt32LE(8 + 256 + i * 4));
  ok(raw.length === 524 && raw.readUInt32LE(0) === 64, "key struct: 64 words, 524 bytes");
  ok(((n0inv * (n % M32)) + 1n) % M32 === 0n, "n0inv is -1/n mod 2^32");
  ok(rr === (1n << 4096n) % n, "rr is (2^2048)^2 mod n");
}
const tok = crypto.randomBytes(20);
ok(verify(key.publicKey, tok, signToken(key.privatePem, tok)), "signature checks out the way the TV checks it");
ok(!verify(makeKey().publicKey, tok, signToken(key.privatePem, tok)), "another key's signature doesn't");

// first time: the TV asks, the user allows
const tv = await startMockAdbd({ approve: "manual", model: "SHIELD Android TV", shell: (c) => (c === "echo hi" ? "hi\n" : c.startsWith("big") ? "x".repeat(5000) : "") });
const states = [];
const d = new AdbDevice({ host: "127.0.0.1", port: tv.port, key, onState: (s) => states.push(s), approveMs: 5000 });
const p = d.connect();
await new Promise((r) => setTimeout(r, 300));
ok(d.state === "waiting" && tv.state.prompts === 1, "unknown key: the TV shows the allow prompt, the device waits");
tv.state.approveNow();
await p;
ok(d.state === "ok" && d.model === "SHIELD Android TV", "allowed: connected, model read from the TV");
ok((await d.shell("echo hi")) === "hi\n", "shell command output");
ok((await d.shell("big")).length === 5000, "long output arrives in pieces and is joined");
const [a, b2] = await Promise.all([d.shell("echo hi"), d.shell("big")]);
ok(a === "hi\n" && b2.length === 5000, "two commands at the same time");
d.close();

// next time: the key is known, no prompt
const d2 = new AdbDevice({ host: "127.0.0.1", port: tv.port, key });
await d2.connect();
ok(d2.state === "ok" && tv.state.prompts === 1, "known key: connects without asking again");
d2.close();

// the user says no / never answers
const tv2 = await startMockAdbd({ approve: "never" });
const d3 = new AdbDevice({ host: "127.0.0.1", port: tv2.port, key, approveMs: 400 });
let err = null;
try { await d3.connect(); } catch (x) { err = x; }
ok(err && err.code === "not-allowed" && d3.state === "error", "nobody presses Allow: a clear error " + (err && err.message));

// nothing listening
const d4 = new AdbDevice({ host: "127.0.0.1", port: 1, key, timeoutMs: 2000 });
err = null;
try { await d4.connect(); } catch (x) { err = x; }
ok(err && /refused|reached|answer/.test(err.message), "network debugging off: a clear error " + (err && err.message));

tv.server.close(); tv2.server.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
