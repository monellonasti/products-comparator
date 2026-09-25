// Minimal in-process metrics exposed in Prometheus text format at /metrics (token protected).
// Histograms keep a bounded reservoir to report p50/p95/p99 without extra dependencies.

class Reservoir {
  private values: number[] = [];
  count = 0;
  sum = 0;
  private size: number;
  constructor(size = 1000) {
    this.size = size;
  }
  add(v: number) {
    this.count++;
    this.sum += v;
    if (this.values.length < this.size) this.values.push(v);
    else this.values[Math.floor(Math.random() * this.count) % this.size] = v;
  }
  quantile(q: number) {
    if (!this.values.length) return 0;
    const s = [...this.values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }
}

const counters = new Map<string, number>();
const histograms = new Map<string, Reservoir>();

export const metrics = {
  inc(name: string, by = 1) {
    counters.set(name, (counters.get(name) ?? 0) + by);
  },
  observe(name: string, value: number) {
    let h = histograms.get(name);
    if (!h) histograms.set(name, (h = new Reservoir()));
    h.add(value);
  },
  snapshot() {
    return {
      counters: Object.fromEntries(counters),
      histograms: Object.fromEntries(
        [...histograms].map(([k, h]) => [k, { count: h.count, p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99) }]),
      ),
    };
  },
  render(gauges: Record<string, number>): string {
    const lines: string[] = [];
    for (const [k, v] of counters) lines.push(`# TYPE ${k} counter`, `${k} ${v}`);
    for (const [k, h] of histograms) {
      lines.push(`# TYPE ${k} summary`);
      for (const q of [0.5, 0.95, 0.99]) lines.push(`${k}{quantile="${q}"} ${h.quantile(q)}`);
      lines.push(`${k}_sum ${h.sum}`, `${k}_count ${h.count}`);
    }
    for (const [k, v] of Object.entries(gauges)) lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return `${lines.join('\n')}\n`;
  },
};
