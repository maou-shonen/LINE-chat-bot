import { afterEach, describe, expect, it, vi } from "vitest";
import { PhaseTimer } from "../src/phases";

describe("phase timing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays silent when disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const phases = new PhaseTimer(false);
    phases.start("get");
    phases.end("get");
    phases.count("rows", 3);
    phases.flush("test");
    expect(log).not.toHaveBeenCalled();
  });

  it("logs only fixed names and numbers when enabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const phases = new PhaseTimer(true);
    phases.start("get");
    phases.end("get");
    phases.count("rows", 3);
    phases.flush("test");
    const line = log.mock.calls[0] ?? [];
    expect(line[0]).toBe("phase");
    const payload = JSON.parse(String(line[1])) as Record<string, unknown>;
    expect(payload.op).toBe("test");
    expect(payload.rows).toBe(3);
    expect(typeof payload.get).toBe("number");
    for (const [key, value] of Object.entries(payload)) {
      if (key === "op") continue;
      expect(typeof value).toBe("number");
    }
  });
});
