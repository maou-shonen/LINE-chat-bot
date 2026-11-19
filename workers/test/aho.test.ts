import { expect, it } from "vitest";
import { ahoHits, buildAho, decodeAho, encodeAho } from "../src/aho";
import { probeNeedles } from "../src/keywords";

it("matches the sliding-window hit set and survives a blob roundtrip", () => {
  const random = mulberry32(11);
  for (let trial = 0; trial < 40; trial += 1) {
    const anchors = randomAnchors(random, 30);
    const message = randomText(random, 80);
    const machine = buildAho(anchors);
    const decoded = decodeAho(encodeAho(machine));
    expect(hitSet(ahoHits(decoded, message))).toEqual(windowHits(anchors, message));
  }
});

function windowHits(anchors: readonly string[], message: string): Set<string> {
  const lengths = [...new Set(anchors.map((anchor) => anchor.length))];
  const known = new Set(anchors);
  return new Set(probeNeedles(message, lengths).filter((needle) => needle === "" || known.has(needle)));
}

function hitSet(hits: readonly string[]): Set<string> {
  return new Set(hits);
}

function randomAnchors(random: () => number, count: number): string[] {
  const anchors: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = 1 + Math.floor(random() * 6);
    let text = "";
    for (let j = 0; j < length; j += 1) text += String.fromCharCode(0x4e00 + Math.floor(random() * 40));
    anchors.push(text);
  }
  return anchors;
}

function randomText(random: () => number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(0x4e00 + Math.floor(random() * 40));
  return text;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
