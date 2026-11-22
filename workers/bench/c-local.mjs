// Measures the local Worker through wrangler dev. No Cloudflare request is made.
// Real blobs come from C_BLOB_DIR (default /tmp/c-blob-build-v4); only aggregates print.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonChars, commonWeights } from "./char-freq.ts";

const PORT = Number(process.env.C_PORT ?? 8796);
const BLOBS = process.env.C_BLOB_DIR ?? "/tmp/c-blob-build-v4";
const STATE = mkdtempSync(join(tmpdir(), "c-measure-state-"));
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "bench";
const NO_MATCH = "&".repeat(20);
const LONG = weightedText(5000, 2);
const files = readdirSync(BLOBS)
  .filter((name) => name !== "c-manifest.json")
  .map((name) => ({ name, size: statSync(join(BLOBS, name)).size }));
check();

let child = await start();
try {
  const upload = await measure("upload", async () => {
    for (const file of files) await uploadBlob(file);
    return files.length;
  });
  const max = {};
  for (const [kind, file] of Object.entries(pickMax())) {
    if (file === null) continue;
    max[kind] = [];
    for (let i = 0; i < 3; i += 1) {
      max[kind].push(await measure(kind, async () => (await uploadBlob(file)).status));
    }
  }
  const cold = [];
  const warm = [];
  const longCold = [];
  const longWarm = [];
  for (let i = 0; i < 3; i += 1) {
    await stop();
    child = await start();
    cold.push(await measure("coldDm", () => callback(dm("Ubench-measure-user", NO_MATCH)), 500));
    warm.push(await measure("warmDm", () => callback(dm("Ubench-measure-user", NO_MATCH)), 200));
    longCold.push(await measure("longCold", () => callback(dm("Ubench-measure-user", LONG)), 500));
    longWarm.push(await measure("longWarm", () => callback(dm("Ubench-measure-user", LONG)), 500));
  }
  console.log(
    "C_LOCAL",
    JSON.stringify({
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      upload,
      max,
      cold,
      warm,
      longCold,
      longWarm,
    }),
  );
} finally {
  await stop();
  rmSync(STATE, { recursive: true, force: true });
}

function check() {
  try {
    statSync(BLOBS);
  } catch {
    throw new Error(`missing blobs at ${BLOBS}; run npm run blobs first`);
  }
}

function pickMax() {
  const largest = (list) => [...list].sort((a, b) => b.size - a.size)[0] ?? null;
  return {
    aho: largest(files.filter((f) => f.name.startsWith("keyword-aho-"))),
    row: largest(files.filter((f) => f.name.startsWith("keyword-rows-"))),
    log: largest(files.filter((f) => f.name.startsWith("c-logs:"))),
    group: largest(files.filter((f) => f.name.startsWith("c-group:"))),
  };
}

async function start() {
  const proc = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", STATE,
      "--var", `IMPORT_SECRET:${SECRET}`, "--var", "FIXTURE_HEADERS:1"],
    { cwd: new URL("..", import.meta.url).pathname, detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return proc;
    } catch {}
  }
  proc.kill("SIGTERM");
  throw new Error(`wrangler dev did not start: ${stderr.slice(-400)}`);
}

async function stop() {
  if (child === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await sleep(1000);
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await sleep(300);
}

async function measure(_label, fn, settle = 250) {
  const before = await sample();
  const started = performance.now();
  const value = await fn();
  const wallMs = performance.now() - started;
  await sleep(settle);
  const after = await sample();
  return {
    value: value instanceof Response ? value.status : value,
    wallMs: round(wallMs),
    cpuMs: round(after.cpuMs - before.cpuMs),
    rssMB: round(after.rssKb - before.rssKb) / 1024,
  };
}

async function sample() {
  let cpuTicks = 0;
  let rssKb = 0;
  for (const pid of workers()) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      cpuTicks += Number(rest[11]) + Number(rest[12]);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /VmRSS:\s+(\d+) kB/.exec(status);
      if (rss !== null) rssKb += Number(rss[1]);
    } catch {}
  }
  return { cpuMs: (cpuTicks * 1000) / 100, rssKb };
}

function workers() {
  const procs = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  const parent = new Map();
  const comm = new Map();
  for (const pid of procs) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(pid), Number(rest[1]));
      comm.set(Number(pid), stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")));
    } catch {}
  }
  const found = [];
  for (const pid of parent.keys()) {
    let at = pid;
    while (at !== 1 && parent.has(at)) {
      if (at === child.pid) {
        if (comm.get(pid)?.startsWith("workerd")) found.push(pid);
        break;
      }
      at = parent.get(at);
    }
  }
  return found;
}

async function uploadBlob(file) {
  const bytes = readFileSync(join(BLOBS, file.name));
  const key = file.name.endsWith(".json") ? file.name.slice(0, -5) : file.name.slice(0, -4);
  const body = file.name.endsWith(".json")
    ? JSON.stringify({ key, json: JSON.parse(bytes.toString("utf8")) })
    : JSON.stringify({ key, bytes: bytes.toString("base64") });
  return fetch(`${BASE}/import/kv`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-import-secret": SECRET },
    body,
  });
}

async function callback(event) {
  const body = JSON.stringify({ destination: "bench", events: [event] });
  const signature = createHmac("sha256", SECRET).update(body).digest("base64");
  return fetch(`${BASE}/callback/${SECRET}/${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  });
}

function dm(userId, text) {
  return {
    type: "message",
    message: { type: "text", id: "bench", text },
    webhookEventId: "bench",
    deliveryContext: { isRedelivery: false },
    timestamp: 0,
    source: { type: "user", userId },
    mode: "active",
  };
}

function weightedText(length, seed) {
  const total = commonWeights.reduce((sum, weight) => sum + weight, 0);
  const cumulative = [];
  let acc = 0;
  for (const weight of commonWeights) {
    acc += weight;
    cumulative.push(acc);
  }
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let text = "zzsentinel";
  while (text.length < length) {
    const unit = random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= unit) lo = mid + 1;
      else hi = mid;
    }
    text += commonChars[lo] ?? "";
  }
  return text.slice(0, length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(value * 10) / 10;
}
