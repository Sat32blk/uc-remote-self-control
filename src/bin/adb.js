// A small ADB client for Android TV "network debugging" (adb over TCP, usually port 5555), written
// from the protocol description so the integration needs no adb program.
//
// What it does: connect, authenticate with this integration's own RSA key (the TV asks once:
// "Allow network debugging?"), and run shell commands. That's all the Android apps feature needs:
// list the apps, open one, and see which one is in front.
//
// Protocol (system/core/adb/protocol.txt): each message is a 24-byte header (command, arg0, arg1,
// data length, data checksum, magic = command ^ 0xffffffff) followed by the data.
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";

const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257, STLS: 0x534c5453 };
const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
const VERSION = 0x01000000;
const MAX_DATA = 256 * 1024;
const AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
// DER prefix of a SHA-1 DigestInfo: adb signs its 20-byte token as if it were a SHA-1 digest
const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");

/** A new key for this integration: { privatePem, publicKey (adb's own format, base64 + " name") }. */
export function makeKey(name = "uc-self-control@" + os.hostname()) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  return { privatePem, publicKey: adbPublicKey(privatePem, name) };
}

const b64urlToBig = (s) => BigInt("0x" + Buffer.from(s, "base64url").toString("hex"));
/** Android's RSAPublicKey struct (mincrypt): word count, n0inv, n and rr as little-endian words, exponent. */
export function adbPublicKey(privatePem, name = "uc-self-control") {
  const jwk = crypto.createPublicKey(privatePem).export({ format: "jwk" });
  const n = b64urlToBig(jwk.n), e = Number(b64urlToBig(jwk.e));
  const words = 64; // 2048 bits
  const M32 = 1n << 32n;
  const n0 = n % M32;
  let inv = n0; // Newton's method: inverse of n0 modulo 2^32 (n is odd)
  for (let i = 0; i < 5; i++) inv = (inv * (2n - ((n0 * inv) % M32) + M32)) % M32;
  const n0inv = (M32 - inv) % M32;
  const rr = (1n << BigInt(words * 32 * 2)) % n;
  const buf = Buffer.alloc(4 + 4 + words * 4 * 2 + 4);
  let o = 0;
  buf.writeUInt32LE(words, o); o += 4;
  buf.writeUInt32LE(Number(n0inv), o); o += 4;
  for (const v of [n, rr]) { let x = v; for (let i = 0; i < words; i++) { buf.writeUInt32LE(Number(x % M32), o); o += 4; x /= M32; } }
  buf.writeUInt32LE(e, o);
  return `${buf.toString("base64")} ${name}`;
}
/** Reads n and e back from adb's public key format (used by the tests' fake TV). */
export function parseAdbPublicKey(text) {
  const buf = Buffer.from(String(text).split(" ")[0], "base64");
  const words = buf.readUInt32LE(0), M32 = 1n << 32n;
  let n = 0n;
  for (let i = words - 1; i >= 0; i--) n = n * M32 + BigInt(buf.readUInt32LE(8 + i * 4));
  return { n, e: buf.readUInt32LE(8 + words * 8) };
}
export function signToken(privatePem, token) {
  return crypto.privateEncrypt({ key: privatePem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_PREFIX, token]));
}

function packet(command, arg0, arg1, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(24);
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  head.writeUInt32LE(command, 0); head.writeUInt32LE(arg0 >>> 0, 4); head.writeUInt32LE(arg1 >>> 0, 8);
  head.writeUInt32LE(data.length, 12); head.writeUInt32LE(sum, 16); head.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([head, data]);
}
/** Splits a byte stream into adb messages; returns [messages, rest]. */
export function readPackets(buf) {
  const out = [];
  while (buf.length >= 24) {
    const len = buf.readUInt32LE(12);
    if (buf.length < 24 + len) break;
    out.push({ command: buf.readUInt32LE(0), arg0: buf.readUInt32LE(4), arg1: buf.readUInt32LE(8), data: buf.subarray(24, 24 + len) });
    buf = buf.subarray(24 + len);
  }
  return [out, buf];
}
export { packet as adbPacket, CMD as ADB };

class AdbError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

/**
 * One TV. connect() resolves when the TV accepted the key; state tells the UI what's going on:
 * "off" | "connecting" | "waiting" (the TV shows "Allow network debugging?") | "ok" | "error".
 */
export class AdbDevice {
  constructor({ host, port = 5555, key, onState = () => {}, log = () => {}, approveMs = 120000, timeoutMs = 8000 }) {
    Object.assign(this, { host, port, key, onState, log, approveMs, timeoutMs });
    this.state = "off"; this.error = ""; this.banner = ""; this.sock = null; this.streams = new Map(); this.nextId = 1; this.connecting = null;
  }
  setState(s, error = "") { this.state = s; this.error = error; try { this.onState(s, error); } catch {} }
  /** "SHIELD Android TV" from the TV's hello message. */
  get model() { return /ro\.product\.model=([^;]+)/.exec(this.banner)?.[1] || ""; }

  connect() {
    if (this.state === "ok" && this.sock) return Promise.resolve(this);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0), sentSig = false, sentKey = false, settled = false;
      const fail = (msg, code) => { if (settled) return; settled = true; clearTimeout(timer); this.close(); this.setState("error", msg); reject(new AdbError(msg, code)); };
      const ok = () => { if (settled) return; settled = true; clearTimeout(timer); this.setState("ok"); resolve(this); };
      let timer = setTimeout(() => fail(`no answer from ${this.host}:${this.port}`, "timeout"), this.timeoutMs);
      this.setState("connecting");
      const sock = net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      sock.setNoDelay(true);
      sock.on("connect", () => sock.write(packet(CMD.CNXN, VERSION, MAX_DATA, Buffer.from("host::\0"))));
      sock.on("error", (e) => {
        const msg = e.code === "ECONNREFUSED" ? `${this.host}:${this.port} refused the connection: is Network debugging on?` : e.code === "EHOSTUNREACH" || e.code === "ETIMEDOUT" ? `${this.host} can't be reached` : e.message;
        if (!settled) fail(msg, e.code); else { this.setState("error", msg); this.dropStreams(msg); }
      });
      sock.on("close", () => { if (!settled) fail("the TV closed the connection (did it say no?)", "closed"); else if (this.state === "ok") { this.setState("off"); this.dropStreams("connection closed"); } this.sock = null; });
      sock.on("data", (chunk) => {
        let msgs;
        [msgs, buf] = readPackets(Buffer.concat([buf, chunk]));
        for (const m of msgs) {
          if (!settled) {
            if (m.command === CMD.AUTH && m.arg0 === AUTH_TOKEN) {
              if (!sentSig) { sentSig = true; sock.write(packet(CMD.AUTH, AUTH_SIGNATURE, 0, signToken(this.key.privatePem, m.data))); }
              else if (!sentKey) { // our key isn't known yet: offer it; the TV asks the user
                sentKey = true;
                sock.write(packet(CMD.AUTH, AUTH_RSAPUBLICKEY, 0, Buffer.from(this.key.publicKey + "\0")));
                this.setState("waiting");
                clearTimeout(timer);
                timer = setTimeout(() => fail("nobody pressed Allow on the TV", "not-allowed"), this.approveMs);
              }
            } else if (m.command === CMD.CNXN) { this.banner = m.data.toString("utf8"); this.maxData = Math.min(MAX_DATA, m.arg1 || 4096); ok(); }
            else if (m.command === CMD.STLS) fail("this TV wants wireless debugging with a pairing code, which isn't supported yet: turn on Network debugging (ADB over network) instead", "tls");
            continue;
          }
          this.onMessage(m);
        }
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  onMessage(m) {
    const s = this.streams.get(m.arg1);
    if (!s) return;
    if (m.command === CMD.OKAY) { s.remote = m.arg0; s.opened?.(); s.opened = null; }
    else if (m.command === CMD.WRTE) { s.chunks.push(Buffer.from(m.data)); this.sock?.write(packet(CMD.OKAY, s.local, m.arg0)); }
    else if (m.command === CMD.CLSE) {
      if (s.remote) this.sock?.write(packet(CMD.CLSE, s.local, s.remote));
      this.streams.delete(s.local); clearTimeout(s.timer);
      if (!s.remote && !s.chunks.length) s.reject(new AdbError("the TV refused the command", "refused"));
      else s.resolve(Buffer.concat(s.chunks).toString("utf8"));
    }
  }
  dropStreams(why) { for (const s of this.streams.values()) { clearTimeout(s.timer); s.reject(new AdbError(why, "closed")); } this.streams.clear(); }
  /** Runs a shell command on the TV and gives its output. */
  async shell(command, { timeoutMs = 15000 } = {}) {
    await this.connect();
    const local = this.nextId++;
    return new Promise((resolve, reject) => {
      const s = { local, remote: 0, chunks: [], resolve, reject, opened: null };
      s.timer = setTimeout(() => { this.streams.delete(local); reject(new AdbError(`"${command.slice(0, 40)}" took too long`, "timeout")); }, timeoutMs);
      this.streams.set(local, s);
      this.sock.write(packet(CMD.OPEN, local, 0, Buffer.from(`shell:${command}\0`)));
    });
  }
  close() {
    try { this.sock?.destroy(); } catch {}
    this.sock = null;
    this.dropStreams("closed");
    if (this.state === "ok" || this.state === "connecting") this.setState("off");
  }
}
export { NAME as ADB_NAMES };
