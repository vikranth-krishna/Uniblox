// Small logging and metrics helpers so the service can be watched without
// pulling in a framework. Both are meant to be swapped for pino and
// prom-client (or an OpenTelemetry exporter) when this grows.

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// One JSON object per line, easy to ship to any log collector.
export const jsonLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), message, ...fields })),
};

export const silentLogger: Logger = { info: () => {}, error: () => {} };

export class Metrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string | number> = {}): void {
    const key = `${name}${formatLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  // Prometheus text exposition format.
  render(): string {
    return [...this.counters.entries()].sort().map(([key, value]) => `${key} ${value}`).join("\n") + "\n";
  }
}

function formatLabels(labels: Record<string, string | number>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${String(v).replaceAll('"', "'")}"`).join(",")}}`;
}
