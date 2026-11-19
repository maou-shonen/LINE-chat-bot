import { describe, expect, it } from "vitest";
import { renderReply, type RandomOrgRequest, type Rng } from "../src/gacha";

const NOW = new Date(Date.UTC(2023, 10, 14, 22, 13, 20));
const USER = "U_own";

type Script =
  | { op: "uniform"; hex: string }
  | { op: "choice"; index: number }
  | { op: "sample"; indices: number[] };

function floatFromHex(hex: string): number {
  const matched = /^([+-]?)0x([0-9a-f]+)(?:\.([0-9a-f]*))?p([+-]?\d+)$/i.exec(hex);
  if (matched === null) throw new Error(hex);
  const sign = matched[1] === "-" ? -1 : 1;
  const frac = matched[3] ?? "";
  const digits = `${matched[2] ?? ""}${frac}`;
  const exp = Number(matched[4]);
  return sign * Number(BigInt(`0x${digits}`)) * 2 ** (exp - frac.length * 4);
}

function scripted(script: readonly Script[]): { rng: Rng; done: () => void } {
  let cursor = 0;
  const rng: Rng = {
    uniform() {
      const op = script[cursor];
      cursor += 1;
      if (op?.op !== "uniform") throw new Error("expected uniform");
      return floatFromHex(op.hex);
    },
    choice(items) {
      const op = script[cursor];
      cursor += 1;
      if (op?.op !== "choice") throw new Error("expected choice");
      const picked = items[op.index];
      if (picked === undefined) throw new Error("choice index");
      return picked;
    },
    sample(items, k) {
      const op = script[cursor];
      cursor += 1;
      if (op?.op !== "sample" || op.indices.length !== k) throw new Error("expected sample");
      return op.indices.map((index) => {
        const picked = items[index];
        if (picked === undefined) throw new Error("sample index");
        return picked;
      });
    },
  };
  return {
    rng,
    done() {
      if (cursor !== script.length) throw new Error(`unused rng ${script.length - cursor}`);
    },
  };
}

function draw(input: {
  reply: string;
  message: string;
  script?: readonly Script[];
  userId?: string;
  now?: Date;
  randomOrg?: (request: RandomOrgRequest) => string;
}): string[] {
  const played = scripted(input.script ?? []);
  const out = renderReply({
    reply: input.reply,
    message: input.message,
    userId: input.userId ?? USER,
    now: input.now ?? NOW,
    rng: played.rng,
    randomOrg: input.randomOrg,
  });
  played.done();
  return out;
}

describe("renderReply", () => {
  it("matches the gacha steps in fixtures/suite.json", () => {
    const zeros = `${"0\n".repeat(10000)}`;
    const cases: Array<{ name: string; reply: string; message: string; script?: Script[]; body?: string; expect: string[]; url?: string }> = [
      {
        name: "weight_draw",
        reply: "a%2__b%1",
        message: "wtp",
        script: [{ op: "uniform", hex: "0x1.9cc4575a93046p-2" }],
        expect: ["a"],
      },
      {
        name: "multidraw_2",
        reply: "v1__v2__v3",
        message: "mdraw2*2",
        body: "1\n2\n",
        url: "https://www.random.org/integers/?num=2&min=0&max=3&col=1&base=10&format=plain&rnd=new",
        expect: ["v1 x 1\nv2 x 1"],
      },
      {
        name: "pity_draw",
        reply: "a__*b__**c##保底=1",
        message: "pity1",
        script: [
          { op: "uniform", hex: "0x1.9cc4575a93046p-2" },
          { op: "choice", index: 0 },
        ],
        expect: ["c"],
      },
      {
        name: "seed_draw",
        reply: "x__y##種子=24",
        message: "seed1",
        expect: ["x"],
      },
      {
        name: "percent_draw",
        reply: "p__q##百分比=2",
        message: "pct",
        script: [
          { op: "sample", indices: [0, 1] },
          { op: "uniform", hex: "0x1.981c45df95700p+4" },
        ],
        expect: ["p（25.51％）\nq（74.49％）"],
      },
      {
        name: "learn_plus_draw",
        reply: "extra__base",
        message: "wt2",
        script: [{ op: "uniform", hex: "0x1.132d8f91b7584p-2" }],
        expect: ["extra"],
      },
      {
        name: "draw_underscore",
        reply: "aa__bb",
        message: "rnd",
        script: [{ op: "uniform", hex: "0x1.132d8f91b7584p-2" }],
        expect: ["aa"],
      },
      {
        name: "split_draw",
        reply: "k1||k2",
        message: "md",
        expect: ["k1", "k2"],
      },
      {
        name: "draw_cap_10000",
        reply: "a__b",
        message: "cap*10000",
        body: zeros,
        url: "https://www.random.org/integers/?num=10000&min=0&max=2&col=1&base=10&format=plain&rnd=new",
        expect: ["a x 10000"],
      },
      {
        name: "draw_cap_10001",
        reply: "a__b",
        message: "cap*10001",
        body: zeros,
        url: "https://www.random.org/integers/?num=10000&min=0&max=2&col=1&base=10&format=plain&rnd=new",
        expect: ["a x 10000"],
      },
      {
        name: "draw_cap_0",
        reply: "a__b",
        message: "cap*0",
        script: [{ op: "uniform", hex: "0x1.236eb0b63c5abp+0" }],
        expect: ["b"],
      },
    ];

    for (const row of cases) {
      const urls: string[] = [];
      const out = draw({
        reply: row.reply,
        message: row.message,
        script: row.script,
        randomOrg:
          row.body === undefined
            ? undefined
            : (request) => {
                urls.push(request.url);
                expect(request.timeoutMs).toBe(3000);
                return row.body ?? "";
              },
      });
      expect(out, row.name).toEqual(row.expect);
      expect(urls, row.name).toEqual(row.url === undefined ? [] : [row.url]);
    }
  });

  it("picks c from the seeded four-item pool, and a different day or hour changes it", () => {
    expect(draw({ reply: "a__b__c__d##種子=24", message: "s" })).toEqual(["c"]);
    expect(
      draw({
        reply: "a__b__c__d##種子=1",
        message: "s",
      }),
    ).toEqual(["a"]);
    expect(
      draw({
        reply: "a__b__c__d##種子=24",
        message: "s",
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    ).toEqual(["a"]);
    expect(draw({ reply: "a__b__c__d##種子=24", message: "s", userId: "None" })).toEqual(["b"]);
  });

  it("uses float modulo when a weight was written with %", () => {
    expect(draw({ reply: "a%0.5__b%1.5##種子=24", message: "s" })).toEqual(["a"]);
  });

  it("keeps a repeated label's earlier weight in the total, so a roll can miss", () => {
    expect(draw({ reply: "a%3__a%1", message: "x", script: [{ op: "uniform", hex: "0x1.0p+1" }] })).toEqual(
      [],
    );
  });

  it("does not split percentage text on ||, but does split a drawn label", () => {
    expect(
      draw({
        reply: "a||b__c##百分比=1",
        message: "x",
        script: [{ op: "sample", indices: [0] }],
      }),
    ).toEqual(["a||b（100.00％）"]);
    expect(draw({ reply: "a||b__c", message: "x", script: [{ op: "uniform", hex: "0x0p+0" }] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops the ## tail when the reply is not a draw", () => {
    expect(draw({ reply: "hello##種子=24", message: "s" })).toEqual(["hello"]);
    expect(draw({ reply: "a||b||c", message: "s" })).toEqual(["a", "b", "c"]);
  });

  it("caps image bubbles at five and lists text before images", () => {
    const first = "https://example.com/0.jpg";
    const urls = [0, 1, 2, 3, 4, 5].map((i) => `https://example.com/${i}.jpg`);
    expect(
      draw({
        reply: urls.join("__"),
        message: "k*6",
        randomOrg: () => "0\n0\n0\n0\n0\n0\n",
      }),
    ).toEqual([first, first, first, first, first]);
    expect(
      draw({
        reply: "a__https://example.com/a.jpg",
        message: "k*2",
        randomOrg: () => "0\n2\n",
      }),
    ).toEqual(["a x 1", "https://example.com/a.jpg"]);
    expect(
      draw({
        reply: "https://example.com/a.jpg__b",
        message: "x",
        script: [{ op: "uniform", hex: "0x0p+0" }],
      }),
    ).toEqual(["https://example.com/a.jpg"]);
  });

  it("falls back to uniform when random.org fails, and still parses a good body", () => {
    const fallback = [{ op: "uniform" as const, hex: "0x0p+0" }, { op: "uniform" as const, hex: "0x1.8p+0" }];
    expect(draw({ reply: "a__b", message: "k*2", script: fallback, randomOrg: () => "Error: no\n" })).toEqual([
      "a x 1\nb x 1",
    ]);
    expect(
      draw({
        reply: "a__b",
        message: "k*2",
        script: fallback,
        randomOrg: () => "<!DOCTYPE html>",
      }),
    ).toEqual(["a x 1\nb x 1"]);
    expect(
      draw({
        reply: "a__b",
        message: "k*2",
        script: fallback,
        randomOrg: () => {
          throw new Error("net");
        },
      }),
    ).toEqual(["a x 1\nb x 1"]);
    expect(draw({ reply: "a__b", message: "k*2", randomOrg: () => "0\n1\n" })).toEqual(["a x 2"]);
  });

  it("throws when random.org returns too few numbers", () => {
    expect(() => draw({ reply: "a__b", message: "k*2", randomOrg: () => "0\n" })).toThrow(/missing roll/);
  });

  it("treats a fullwidth count as a draw count and rejects a superscript count", () => {
    expect(draw({ reply: "a__b", message: "k*\uff12", randomOrg: () => "0\n0\n" })).toEqual(["a x 2"]);
    expect(() => draw({ reply: "a__b", message: "k*\u00b2", script: [{ op: "uniform", hex: "0x0p+0" }] })).toThrow(
      /invalid int/,
    );
  });

  it("reads underscore and exponent weights", () => {
    expect(
      draw({ reply: "a%1_0__b%1", message: "x", script: [{ op: "uniform", hex: "0x1.5p+3" }] }),
    ).toEqual(["b"]);
    expect(draw({ reply: "a%1e2__b%1", message: "x", script: [{ op: "uniform", hex: "0x1.9p+5" }] })).toEqual([
      "a",
    ]);
  });

  it("truncates a float weight total in the random.org max", () => {
    const urls: string[] = [];
    draw({
      reply: "a%1.9__b%1",
      message: "k*2",
      randomOrg: (request) => {
        urls.push(request.url);
        return "0\n0\n";
      },
    });
    expect(urls).toEqual([
      "https://www.random.org/integers/?num=2&min=0&max=2&col=1&base=10&format=plain&rnd=new",
    ]);
  });

  it("applies pity across draws and leaves the default of 10 alone for one miss", () => {
    expect(
      draw({
        reply: "a__*b__**c##保底=2",
        message: "k*2",
        script: [{ op: "choice", index: 0 }],
        randomOrg: () => "0\n0\n",
      }),
    ).toEqual(["a x 1\nc x 1"]);
    expect(draw({ reply: "a__*b__**c", message: "s", script: [{ op: "uniform", hex: "0x0p+0" }] })).toEqual([
      "a",
    ]);
    expect(
      draw({
        reply: "a__*b__**c##保底=0",
        message: "s",
        script: [
          { op: "uniform", hex: "0x0p+0" },
          { op: "choice", index: 0 },
        ],
      }),
    ).toEqual(["c"]);
  });

  it("calls random.org before a bad 保底 value throws", () => {
    let called = 0;
    expect(() =>
      draw({
        reply: "a__b##保底=nope",
        message: "k*2",
        randomOrg: () => {
          called += 1;
          return "0\n0\n";
        },
      }),
    ).toThrow(/invalid int/);
    expect(called).toBe(1);
  });

  it("skips empty __ segments", () => {
    expect(draw({ reply: "a____b", message: "s", script: [{ op: "uniform", hex: "0x1.8p+0" }] })).toEqual(["b"]);
  });
});
