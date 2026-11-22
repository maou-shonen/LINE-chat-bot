export interface AhoMachine {
  off: Uint32Array;
  chars: Uint16Array;
  next: Uint32Array;
  fail: Uint32Array;
  outHead: Int32Array;
  outLens: Uint16Array;
  outNext: Int32Array;
}

const KEY_STRIDE = 65536;

export function buildAho(anchors: Iterable<string>): AhoMachine {
  const build = startAhoBuild(anchors);
  while (!stepAhoBuild(build, 1e9)) {
    // one full build
  }
  const machine = build.machine;
  if (machine === null) throw new Error("aho build did not finish");
  return machine;
}

export interface AhoBuild {
  anchors: string[];
  at: number;
  kids: number[][];
  own: number[];
  edge: Map<number, number>;
  phase: "insert" | "fail" | "out" | "pack";
  fail: Uint32Array;
  queue: number[];
  head: number;
  outHead: Int32Array;
  lens: number[];
  outNext: number[];
  packAt: number;
  edgeCount: number;
  off: Uint32Array;
  chars: Uint16Array;
  next: Uint32Array;
  machine: AhoMachine | null;
}

export function startAhoBuild(anchors: Iterable<string>): AhoBuild {
  return {
    anchors: [...anchors],
    at: 0,
    kids: [[]],
    own: [0],
    edge: new Map(),
    phase: "insert",
    fail: new Uint32Array(0),
    queue: [],
    head: 0,
    outHead: new Int32Array(0),
    lens: [],
    outNext: [],
    packAt: 0,
    edgeCount: 0,
    off: new Uint32Array(0),
    chars: new Uint16Array(0),
    next: new Uint32Array(0),
    machine: null,
  };
}

export function stepAhoBuild(build: AhoBuild, budgetMs: number): boolean {
  const start = performance.now();
  if (build.phase === "insert") insertAnchors(build, start, budgetMs);
  if (build.phase === "fail" && performance.now() - start < budgetMs) linkFails(build, start, budgetMs);
  if (build.phase === "out" && performance.now() - start < budgetMs) linkOutputs(build, start, budgetMs);
  if (build.phase === "pack" && performance.now() - start < budgetMs) packMachine(build, start, budgetMs);
  return build.machine !== null;
}

function insertAnchors(build: AhoBuild, start: number, budgetMs: number): void {
  const { kids, own, edge, anchors } = build;
  while (build.at < anchors.length && performance.now() - start < budgetMs) {
    const anchor = anchors[build.at] ?? "";
    build.at += 1;
    if (anchor === "") continue;
    let state = 0;
    for (let i = 0; i < anchor.length; i += 1) {
      const code = anchor.charCodeAt(i);
      const key = state * KEY_STRIDE + code;
      let next = edge.get(key);
      if (next === undefined) {
        next = kids.length;
        edge.set(key, next);
        kids[state]?.push(code);
        kids.push([]);
        own.push(0);
      }
      state = next;
    }
    own[state] = anchor.length;
  }
  if (build.at < anchors.length) return;
  const count = kids.length;
  build.fail = new Uint32Array(count);
  build.outHead = new Int32Array(count);
  build.outHead.fill(-1);
  for (const code of kids[0] ?? []) build.queue.push(edge.get(code) ?? 0);
  build.phase = "fail";
}

function linkFails(build: AhoBuild, start: number, budgetMs: number): void {
  const { kids, edge, fail, queue } = build;
  while (build.head < queue.length && performance.now() - start < budgetMs) {
    const state = queue[build.head] ?? 0;
    build.head += 1;
    for (const code of kids[state] ?? []) {
      const next = edge.get(state * KEY_STRIDE + code) ?? 0;
      queue.push(next);
      let link = fail[state] ?? 0;
      while (link !== 0 && !edge.has(link * KEY_STRIDE + code)) link = fail[link] ?? 0;
      const landed = edge.get(link * KEY_STRIDE + code);
      fail[next] = landed === undefined ? 0 : landed;
    }
  }
  if (build.head < queue.length) return;
  build.head = 0;
  build.phase = "out";
}

function linkOutputs(build: AhoBuild, start: number, budgetMs: number): void {
  const { own, fail, queue, outHead, lens, outNext } = build;
  while (build.head < queue.length && performance.now() - start < budgetMs) {
    const state = queue[build.head] ?? 0;
    build.head += 1;
    const length = own[state] ?? 0;
    if (length > 0) {
      outHead[state] = lens.length;
      lens.push(length);
      outNext.push(outHead[fail[state] ?? 0] ?? -1);
    } else {
      outHead[state] = outHead[fail[state] ?? 0] ?? -1;
    }
  }
  if (build.head < queue.length) return;
  let edges = 0;
  for (const list of build.kids) edges += list.length;
  const count = build.kids.length;
  build.edgeCount = edges;
  build.off = new Uint32Array(count + 1);
  build.chars = new Uint16Array(edges);
  build.next = new Uint32Array(edges);
  build.packAt = 0;
  build.head = 0;
  build.phase = "pack";
}

function packMachine(build: AhoBuild, start: number, budgetMs: number): void {
  const { kids, edge, off, chars, next } = build;
  const count = kids.length;
  while (build.head < count && performance.now() - start < budgetMs) {
    const state = build.head;
    build.head += 1;
    const list = kids[state] ?? [];
    list.sort((left, right) => left - right);
    off[state] = build.packAt;
    for (const code of list) {
      chars[build.packAt] = code;
      next[build.packAt] = edge.get(state * KEY_STRIDE + code) ?? 0;
      build.packAt += 1;
    }
  }
  if (build.head < count) return;
  off[count] = build.packAt;
  build.machine = {
    off,
    chars,
    next,
    fail: build.fail,
    outHead: build.outHead,
    outLens: Uint16Array.from(build.lens),
    outNext: Int32Array.from(build.outNext),
  };
}

export function ahoHits(machine: AhoMachine, message: string): string[] {
  const hits = [""];
  if (message === "" || machine.fail.length <= 1) return hits;
  const found = new Set<string>();
  let state = 0;
  for (let i = 0; i < message.length; i += 1) {
    const code = message.charCodeAt(i);
    for (;;) {
      const next = findEdge(machine, state, code);
      if (next !== -1 || state === 0) {
        if (next !== -1) state = next;
        break;
      }
      state = machine.fail[state] ?? 0;
    }
    let out = machine.outHead[state] ?? -1;
    while (out !== -1) {
      const length = machine.outLens[out] ?? 0;
      const text = message.slice(i + 1 - length, i + 1);
      if (!found.has(text)) {
        found.add(text);
        hits.push(text);
      }
      out = machine.outNext[out] ?? -1;
    }
  }
  return hits;
}

export function encodeAho(machine: AhoMachine): Uint8Array {
  const states = machine.fail.length;
  const edges = machine.chars.length;
  const outs = machine.outLens.length;
  const parts = [
    u32(machine.off),
    u16(machine.chars),
    u32(machine.next),
    u32(machine.fail),
    i32(machine.outHead),
    u16(machine.outLens),
    i32(machine.outNext),
  ];
  let body = 0;
  for (const part of parts) body += part.length + ((4 - (part.length & 3)) & 3);
  const bytes = new Uint8Array(16 + body);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, states, true);
  view.setUint32(4, edges, true);
  view.setUint32(8, outs, true);
  view.setUint32(12, 1, true);
  let at = 16;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length + ((4 - (part.length & 3)) & 3);
  }
  return bytes;
}

export function decodeAho(bytes: Uint8Array): AhoMachine {
  if (bytes.length < 16) throw new TypeError("aho blob is short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const states = view.getUint32(0, true);
  const edges = view.getUint32(4, true);
  const outs = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 1) throw new TypeError("aho blob version");
  if (states < 1 || states > 5_000_000 || edges > 5_000_000 || outs > 5_000_000) {
    throw new TypeError("aho blob size");
  }
  let at = 16;
  const off = takeU32(bytes, at, states + 1);
  at = align(at + (states + 1) * 4);
  const chars = takeU16(bytes, at, edges);
  at = align(at + edges * 2);
  const next = takeU32(bytes, at, edges);
  at = align(at + edges * 4);
  const fail = takeU32(bytes, at, states);
  at = align(at + states * 4);
  const outHead = takeI32(bytes, at, states);
  at = align(at + states * 4);
  const outLens = takeU16(bytes, at, outs);
  at = align(at + outs * 2);
  const outNext = takeI32(bytes, at, outs);
  if (align(at + outs * 4) !== bytes.length) throw new TypeError("aho blob length");
  if ((off[states] ?? 0) !== edges) throw new TypeError("aho edge count");
  return { off, chars, next, fail, outHead, outLens, outNext };
}

function findEdge(machine: AhoMachine, state: number, code: number): number {
  let lo = machine.off[state] ?? 0;
  let hi = machine.off[state + 1] ?? lo;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const found = machine.chars[mid] ?? 0;
    if (found === code) return machine.next[mid] ?? 0;
    if (found < code) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function align(offset: number): number {
  return offset + ((4 - (offset & 3)) & 3);
}

function u32(values: Uint32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function u16(values: Uint16Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function i32(values: Int32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function takeU32(bytes: Uint8Array, offset: number, length: number): Uint32Array {
  const at = bytes.byteOffset + offset;
  if (at % 4 === 0) return new Uint32Array(bytes.buffer, at, length);
  const out = new Uint32Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < length; i += 1) out[i] = view.getUint32(offset + i * 4, true);
  return out;
}

function takeI32(bytes: Uint8Array, offset: number, length: number): Int32Array {
  const at = bytes.byteOffset + offset;
  if (at % 4 === 0) return new Int32Array(bytes.buffer, at, length);
  const out = new Int32Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < length; i += 1) out[i] = view.getInt32(offset + i * 4, true);
  return out;
}

function takeU16(bytes: Uint8Array, offset: number, length: number): Uint16Array {
  const at = bytes.byteOffset + offset;
  if (at % 2 === 0) return new Uint16Array(bytes.buffer, at, length);
  const out = new Uint16Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < length; i += 1) out[i] = view.getUint16(offset + i * 2, true);
  return out;
}
