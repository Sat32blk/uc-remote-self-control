// A fake Android TV for the tests: speaks enough of adb over TCP (CNXN, AUTH, OPEN shell, WRTE, CLSE)
// and checks the integration's RSA signature the way the TV does.
import net from "node:net";
import crypto from "node:crypto";
import { adbPacket as packet, ADB, readPackets, parseAdbPublicKey } from "../src/bin/adb.js";

const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
/** RSA PKCS#1 v1.5 check of an adb AUTH signature against a public key in adb's format. */
export function verify(pubText, token, sig) {
  const { n, e } = parseAdbPublicKey(pubText);
  const s = BigInt("0x" + Buffer.from(sig).toString("hex"));
  const m = modPow(s, BigInt(e), n);
  const em = Buffer.from(m.toString(16).padStart(512, "0"), "hex"); // 256 bytes
  const t = Buffer.concat([SHA1_PREFIX, token]);
  const want = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.alloc(256 - 3 - t.length, 0xff), Buffer.from([0x00]), t]);
  return em.equals(want);
}

/**
 * opts: { port, allowed: Set<publicKey> (keys already allowed), approve: "auto" | "never" | "manual",
 *         shell: (cmd) => string, model }
 * Returns { server, state: { prompts, commands, approveNow() } }.
 */
export function startMockAdbd(opts = {}) {
  const st = { prompts: 0, commands: [], allowed: opts.allowed || new Set(), waiting: [], connections: 0 };
  st.approveNow = () => { for (const w of st.waiting.splice(0)) w(); };
  const server = net.createServer((sock) => {
    st.connections++;
    let buf = Buffer.alloc(0), token = crypto.randomBytes(20), authed = false, pending = null;
    const streams = new Map(); let nextId = 100;
    const hello = () => { authed = true; sock.write(packet(ADB.CNXN, 0x01000000, 4096, Buffer.from(`device::ro.product.name=fake;ro.product.model=${opts.model || "Fake Android TV"};ro.product.device=fake;`))); };
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      let msgs; [msgs, buf] = readPackets(Buffer.concat([buf, chunk]));
      for (const m of msgs) {
        if (m.command === ADB.CNXN) { token = crypto.randomBytes(20); sock.write(packet(ADB.AUTH, 1, 0, token)); continue; }
        if (m.command === ADB.AUTH && m.arg0 === 2) {
          const okKey = [...st.allowed].find((k) => verify(k, token, m.data));
          if (okKey) hello(); else { token = crypto.randomBytes(20); sock.write(packet(ADB.AUTH, 1, 0, token)); }
          continue;
        }
        if (m.command === ADB.AUTH && m.arg0 === 3) {
          const key = m.data.toString("utf8").replace(/\0$/, "");
          st.prompts++;
          const accept = () => { st.allowed.add(key); if (!sock.destroyed) hello(); };
          if (opts.approve === "auto") setTimeout(accept, 50); else if (opts.approve === "manual") st.waiting.push(accept);
          continue;
        }
        if (!authed) continue;
        if (m.command === ADB.OPEN) {
          const svc = m.data.toString("utf8").replace(/\0$/, "");
          if (!svc.startsWith("shell:")) { sock.write(packet(ADB.CLSE, 0, m.arg0)); continue; }
          const cmd = svc.slice(6), id = nextId++;
          st.commands.push(cmd);
          streams.set(id, m.arg0);
          sock.write(packet(ADB.OKAY, id, m.arg0));
          const out = Buffer.from(String(opts.shell ? opts.shell(cmd) : ""));
          // send in pieces, like a real TV
          for (let i = 0; i < out.length; i += 1000) sock.write(packet(ADB.WRTE, id, m.arg0, out.subarray(i, i + 1000)));
          sock.write(packet(ADB.CLSE, id, m.arg0));
          continue;
        }
      }
    });
  });
  return new Promise((r) => server.listen(opts.port || 0, "127.0.0.1", () => r({ server, state: st, port: server.address().port })));
}
