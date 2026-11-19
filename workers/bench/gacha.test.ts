import { describe, expect, it } from "vitest";
import { renderReply, type Rng } from "../src/gacha";

const NOW = new Date(Date.UTC(2023, 10, 14, 22, 13, 20));
const zeroRng: Rng = {
  uniform: () => 0,
  choice(items) {
    const picked = items[0];
    if (picked === undefined) throw new Error("empty choice");
    return picked;
  },
  sample: (items, k) => items.slice(0, k),
};

function stats(samples: readonly number[]): { p50: number; p95: number; max: number; min: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (percent: number) => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
    return sorted[index] ?? 0;
  };
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1] ?? 0, min: sorted[0] ?? 0 };
}

function timePerCall(run: () => void, batch: number, samples: number): ReturnType<typeof stats> {
  for (let i = 0; i < 3; i++) run();
  const measured: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    for (let n = 0; n < batch; n++) run();
    measured.push((performance.now() - start) / batch);
  }
  return stats(measured);
}

describe("gacha bench", () => {
  it("times a 10000-draw and the common draws inside workerd", () => {
    const body10k = `${"0\n".repeat(10000)}`;
    const body5k = `${"0\n".repeat(5000)}`;
    const body100 = `${"0\n".repeat(100)}`;
    const body10 = `${"0\n".repeat(10)}`;
    const wideReply = Array.from({ length: 20 }, (_, i) => `o${i}%0.5`).join("__");
    const wideBody = `${"10\n".repeat(10000)}`;
    let errors = 0;

    const tenThousand = () => {
      const out = renderReply({
        reply: "a__b",
        message: "cap*10000",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
        randomOrg: () => body10k,
      });
      if (out.length !== 1 || out[0] !== "a x 10000") {
        errors += 1;
        throw new Error("10000 draw did not tally");
      }
    };
    const fiveThousand = () => {
      const out = renderReply({
        reply: "a__b",
        message: "k*5000",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
        randomOrg: () => body5k,
      });
      if (out[0] !== "a x 5000") {
        errors += 1;
        throw new Error("5000 draw did not tally");
      }
    };
    const wide = () => {
      const out = renderReply({
        reply: wideReply,
        message: "k*10000",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
        randomOrg: () => wideBody,
      });
      if (out[0] !== "o19 x 10000") {
        errors += 1;
        throw new Error("wide draw did not reach o19");
      }
    };
    const hundred = () => {
      const out = renderReply({
        reply: "a__b",
        message: "k*100",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
        randomOrg: () => body100,
      });
      if (out[0] !== "a x 100") {
        errors += 1;
        throw new Error("100 draw did not tally");
      }
    };
    const ten = () => {
      const out = renderReply({
        reply: "a__b",
        message: "k*10",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
        randomOrg: () => body10,
      });
      if (out[0] !== "a x 10") {
        errors += 1;
        throw new Error("10 draw did not tally");
      }
    };
    const single = () => {
      const out = renderReply({
        reply: "a__b",
        message: "hi",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
      });
      if (out[0] !== "a") {
        errors += 1;
        throw new Error("single draw did not hit a");
      }
    };
    const weighted = () => {
      const out = renderReply({
        reply: "a%2__b%1",
        message: "hi",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
      });
      if (out[0] !== "a") {
        errors += 1;
        throw new Error("weighted draw did not hit a");
      }
    };
    const pity = () => {
      const out = renderReply({
        reply: "a__*b__**c##保底=1",
        message: "hi",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
      });
      if (out[0] !== "c") {
        errors += 1;
        throw new Error("pity draw did not hit c");
      }
    };
    const seeded = () => {
      const out = renderReply({
        reply: "x__y##種子=24",
        message: "hi",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
      });
      if (out[0] !== "x") {
        errors += 1;
        throw new Error("seed draw did not hit x");
      }
    };
    const percent = () => {
      const out = renderReply({
        reply: "p__q##百分比=2",
        message: "hi",
        userId: "U_own",
        now: NOW,
        rng: zeroRng,
      });
      if (out[0] !== "p（0.00％）\nq（100.00％）") {
        errors += 1;
        throw new Error("percent draw mismatch");
      }
    };

    const report = {
      errors,
      tenThousand: timePerCall(tenThousand, 10, 31),
      fiveThousand: timePerCall(fiveThousand, 10, 31),
      wide: timePerCall(wide, 10, 21),
      hundred: timePerCall(hundred, 20, 21),
      ten: timePerCall(ten, 50, 21),
      single: timePerCall(single, 200, 21),
      weighted: timePerCall(weighted, 200, 21),
      pity: timePerCall(pity, 200, 21),
      seeded: timePerCall(seeded, 200, 21),
      percent: timePerCall(percent, 200, 21),
    };
    report.errors = errors;
    console.log(`GACHA_BENCH ${JSON.stringify(report)}`);
    expect(errors).toBe(0);
    expect(report.tenThousand.p95).toBeLessThan(1000);
  });
});
