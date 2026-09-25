/**
 * Métricas em memória do processo (expostas em /metrics com token).
 * O histórico por usuário e por dia fica no painel do WordPress.
 */
export class Metrics {
  private readonly started = Date.now();
  private requests = 0;
  private readonly statuses = new Map<number, number>();
  private readonly tools = new Map<string, { calls: number; errors: number; totalMs: number }>();
  private readonly api = { calls: 0, errors: 0, totalMs: 0 };
  private results = { searches: 0, total: 0 };

  httpRequest(status: number): void {
    this.requests++;
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
  }

  toolCall(name: string, ms: number, ok: boolean): void {
    const current = this.tools.get(name) ?? { calls: 0, errors: 0, totalMs: 0 };
    current.calls++;
    current.totalMs += ms;
    if (!ok) {
      current.errors++;
    }
    this.tools.set(name, current);
  }

  apiCall(ms: number, ok: boolean): void {
    this.api.calls++;
    this.api.totalMs += ms;
    if (!ok) {
      this.api.errors++;
    }
  }

  searchResults(count: number): void {
    this.results.searches++;
    this.results.total += count;
  }

  snapshot(): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const [name, value] of this.tools) {
      tools[name] = { calls: value.calls, errors: value.errors, avg_ms: value.calls ? Math.round(value.totalMs / value.calls) : 0 };
    }
    return {
      uptime_seconds: Math.round((Date.now() - this.started) / 1000),
      requests_total: this.requests,
      responses_by_status: Object.fromEntries(this.statuses),
      unauthorized_401: this.statuses.get(401) ?? 0,
      forbidden_403: this.statuses.get(403) ?? 0,
      rate_limited_429: this.statuses.get(429) ?? 0,
      tools,
      wordpress_api: { calls: this.api.calls, errors: this.api.errors, avg_ms: this.api.calls ? Math.round(this.api.totalMs / this.api.calls) : 0 },
      avg_results_per_search: this.results.searches ? Math.round((this.results.total / this.results.searches) * 10) / 10 : 0,
    };
  }
}
