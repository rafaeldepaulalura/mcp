/**
 * Janela fixa em memória. Protege o WordPress de enxurrada antes mesmo de a
 * requisição sair daqui; o limite autoritativo por usuário é o do WordPress.
 * Com mais de uma réplica, cada uma conta separado (aceitável como primeira barreira).
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }

  hit(key: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return { allowed: bucket.count <= this.limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  private sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
