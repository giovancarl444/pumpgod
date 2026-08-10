/**
 * Latency is the product here, so it gets measured properly rather than log-and-hope.
 * Samples are kept in a fixed ring so recording stays allocation-free on the hot path.
 */
const CAPACITY = 4096;

class Series {
  private readonly buf = new Float64Array(CAPACITY);
  private idx = 0;
  private filled = 0;

  add(ms: number) {
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % CAPACITY;
    if (this.filled < CAPACITY) this.filled++;
  }

  get count() {
    return this.filled;
  }

  percentiles(): { p50: number; p95: number; p99: number; max: number; mean: number } | undefined {
    if (this.filled === 0) return undefined;
    const sorted = Array.from(this.buf.subarray(0, this.filled)).sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1]!, mean };
  }
}

const series = new Map<string, Series>();

export function record(stage: string, ms: number) {
  let s = series.get(stage);
  if (!s) {
    s = new Series();
    series.set(stage, s);
  }
  s.add(ms);
}

export function snapshot(): Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> {
  const out: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> = {};
  for (const [stage, s] of series) {
    const p = s.percentiles();
    if (!p) continue;
    out[stage] = {
      n: s.count,
      p50: round(p.p50),
      p95: round(p.p95),
      p99: round(p.p99),
      max: round(p.max),
    };
  }
  return out;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

export function formatSnapshot(): string {
  const snap = snapshot();
  const stages = Object.keys(snap);
  if (!stages.length) return 'latency: no samples yet';
  const rows = stages.map((s) => {
    const m = snap[s]!;
    return `  ${s.padEnd(22)} n=${String(m.n).padEnd(6)} p50=${m.p50}ms  p95=${m.p95}ms  p99=${m.p99}ms  max=${m.max}ms`;
  });
  return ['latency:', ...rows].join('\n');
}
