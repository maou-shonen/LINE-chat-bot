/**
 * Opt-in phase timing. `PHASE_TIMING=1` logs fixed names and numbers only;
 * never message text, ids, or replies. Off by default.
 */
export class PhaseTimer {
  private readonly started = new Map<string, number>();
  private readonly values: Record<string, number> = {};

  constructor(readonly enabled: boolean) {}

  start(name: string): void {
    if (this.enabled) this.started.set(name, performance.now());
  }

  end(name: string): void {
    if (!this.enabled) return;
    const started = this.started.get(name);
    if (started === undefined) return;
    this.started.delete(name);
    this.add(name, performance.now() - started);
  }

  add(name: string, ms: number): void {
    if (this.enabled) this.values[name] = (this.values[name] ?? 0) + ms;
  }

  count(name: string, value = 1): void {
    if (this.enabled) this.values[name] = (this.values[name] ?? 0) + value;
  }

  set(name: string, value: number): void {
    if (this.enabled) this.values[name] = value;
  }

  flush(op: string): void {
    if (!this.enabled) return;
    const out: Record<string, number | string> = { op };
    for (const [name, value] of Object.entries(this.values)) {
      out[name] = Math.round(value * 1000) / 1000;
    }
    console.log("phase", JSON.stringify(out));
  }
}

export const NO_PHASES = new PhaseTimer(false);
