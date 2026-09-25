import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Metrics } from '../utils/metrics.js';
import { isErrorCode, LpApiError } from '../utils/errors.js';

/**
 * Cliente da API somente leitura do WordPress (/wp-json/lp-ai/v1).
 *
 * Em toda chamada vão duas provas: a chave interna (este é o nosso MCP) e o
 * token do usuário (quem está pedindo). O token segue em cabeçalho próprio
 * para não ser descartado pelo Apache nem capturado por outro plugin de JWT.
 */

export interface CallContext {
  token: string;
  tool: string;
  clientIp?: string;
  /** Conexão (claim gid) — usada para lembrar revogação. */
  grantId?: string;
  expiresAt?: number;
}

export interface ApiDeps {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  fetchImpl?: typeof fetch;
  onRevoked?: (grantId: string, expiresAt?: number) => void;
}

export class LicitantePrimeApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: ApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  profile(ctx: CallContext): Promise<Record<string, unknown>> {
    return this.request('GET', '/profile', ctx);
  }

  search(ctx: CallContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/search', ctx, input);
  }

  tender(ctx: CallContext, id: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/tender/${encodeURIComponent(id)}`, ctx);
  }

  items(ctx: CallContext, id: string, page: number, limit: number): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this.request('GET', `/tender/${encodeURIComponent(id)}/items?${query.toString()}`, ctx);
  }

  /** Saúde do WordPress para o /ready. */
  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.deps.config.apiUrl}/health`, { signal: AbortSignal.timeout(4000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request(method: 'GET' | 'POST', path: string, ctx: CallContext, body?: unknown): Promise<Record<string, unknown>> {
    const { config, logger, metrics } = this.deps;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `LicitantePrimeMCP/${config.version}`,
      'X-LP-AI-Internal-Key': config.internalKey,
      'X-LP-AI-Token': ctx.token,
      'X-LP-AI-Tool': ctx.tool,
    };
    if (ctx.clientIp) {
      headers['X-LP-AI-Client-IP'] = ctx.clientIp;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${config.apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      });
    } catch (error) {
      const ms = Date.now() - started;
      metrics.apiCall(ms, false);
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      logger.warn('wp_api_unreachable', { path: path.split('?')[0], tool: ctx.tool, ms, timeout });
      throw new LpApiError(
        'SERVICE_UNAVAILABLE',
        timeout ? 'O Licitante Prime demorou demais para responder.' : 'Não foi possível falar com o Licitante Prime agora.',
        503,
      );
    }

    const ms = Date.now() - started;
    let payload: unknown = null;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    metrics.apiCall(ms, response.ok);
    logger.info('wp_api_call', { path: path.split('?')[0], tool: ctx.tool, status: response.status, ms });

    if (response.ok && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }

    const data = (payload ?? {}) as { error?: unknown; message?: unknown; retry_after?: unknown; reason?: unknown };
    const code = isErrorCode(data.error) ? data.error : response.status === 404 ? 'TENDER_NOT_FOUND' : 'INTERNAL_ERROR';
    const message = typeof data.message === 'string' ? data.message.slice(0, 500) : 'Falha ao consultar o Licitante Prime.';
    const retryAfter = typeof data.retry_after === 'number' ? data.retry_after : Number(response.headers.get('retry-after')) || undefined;

    if (response.status === 401 && data.reason === 'connection_revoked' && ctx.grantId && this.deps.onRevoked) {
      // Conexão revogada: as próximas requisições HTTP já recebem 401 aqui e o
      // cliente dispara a reautenticação sozinho.
      this.deps.onRevoked(ctx.grantId, ctx.expiresAt);
    }
    throw new LpApiError(code, message, response.status, retryAfter);
  }
}
