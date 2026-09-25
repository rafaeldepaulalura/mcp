import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { validateHostHeader, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AppConfig } from './config.js';
import { protectedResourceMetadata, unauthorizedChallenge, type AuthorizationServerMetadataMirror } from './auth/oauth.js';
import { InvalidTokenError, type TokenValidator } from './auth/token-validator.js';
import type { LicitantePrimeApi } from './services/licitante-prime-api.js';
import type { Logger } from './utils/logger.js';
import type { Metrics } from './utils/metrics.js';
import { FixedWindowLimiter } from './utils/rate-limit.js';

/**
 * Servidor HTTP:
 *   /mcp                                   MCP (Streamable HTTP), exige Bearer token
 *   /.well-known/oauth-protected-resource  metadata do recurso (RFC 9728), raiz e /mcp
 *   /.well-known/oauth-authorization-server cópia da metadata do WordPress (clientes antigos)
 *   /health  /ready  /metrics
 */

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  validator: TokenValidator;
  api: LicitantePrimeApi;
  asMirror: AuthorizationServerMetadataMirror;
  mcp: McpHttpHandler;
}

const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID';
const CORS_EXPOSE_HEADERS = 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Retry-After';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload).toString(), ...headers });
  res.end(payload);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function clientIp(req: IncomingMessage, trustHops: number): string {
  const remote = req.socket.remoteAddress ?? '0.0.0.0';
  const header = req.headers['x-forwarded-for'];
  if (trustHops < 1 || typeof header !== 'string' || header.trim() === '') {
    return remote;
  }
  const list = header.split(',').map((part) => part.trim()).filter(Boolean);
  const index = list.length - trustHops;
  return index >= 0 && list[index] ? list[index] : remote;
}

export function createHttpServer(deps: ServerDeps): Server {
  const { config, logger, metrics, validator, api, asMirror } = deps;
  const nodeHandler = toNodeHandler(deps.mcp, {
    maxRequestBodySize: config.maxBodyBytes,
    onerror: (error) => logger.error('mcp_adapter_error', { error: error.message }),
  });
  const unauthLimiter = new FixedWindowLimiter(config.rateLimitUnauthPerMinute);
  const tokenLimiter = new FixedWindowLimiter(config.rateLimitPerMinute);
  const allowedHosts = config.env === 'production' ? config.allowedHosts : [...config.allowedHosts, 'localhost', '127.0.0.1', '[::1]'];

  let readyCache: { at: number; body: Record<string, unknown>; ok: boolean } | null = null;

  const ready = async (res: ServerResponse): Promise<void> => {
    if (!readyCache || Date.now() - readyCache.at > 10_000) {
      const jwks = validator.hasKeys || (await validator.refresh().then(() => true, () => false));
      const wordpress = await api.health();
      const ok = jwks && wordpress;
      readyCache = { at: Date.now(), ok, body: { status: ok ? 'ok' : 'unavailable', checks: { jwks, wordpress } } };
    }
    sendJson(res, readyCache.ok ? 200 : 503, readyCache.body);
  };

  const wellKnown = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Mcp-Protocol-Version' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });
      return;
    }
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      const doc = protectedResourceMetadata(config, path);
      if (doc) {
        sendJson(res, 200, doc, headers);
        return;
      }
    }
    if (path === '/.well-known/oauth-authorization-server') {
      const doc = await asMirror.get();
      if (doc) {
        sendJson(res, 200, doc, headers);
        return;
      }
    }
    sendJson(res, 404, { error: 'not_found' });
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = validateHostHeader(req.headers.host, allowedHosts);
    if (!host.ok) {
      sendJson(res, 403, { error: 'invalid_host' });
      return;
    }

    // Navegador só com origem liberada (proteção contra DNS rebinding/CSRF).
    // ChatGPT, Claude e Gemini chamam servidor-a-servidor, sem Origin.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (origin !== '') {
      if (!config.corsOrigins.includes(origin)) {
        sendJson(res, 403, { error: 'origin_not_allowed' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS', 'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS, 'Access-Control-Max-Age': '600' });
      res.end();
      return;
    }

    const ip = clientIp(req, config.trustProxyHops);
    const authorization = req.headers.authorization ?? '';
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(authorization);
    if (!match?.[1]) {
      const limited = unauthLimiter.hit(`ip:${ip}`);
      if (!limited.allowed) {
        sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(limited.retryAfter) });
        return;
      }
      sendJson(res, 401, { error: 'invalid_token', error_description: 'Authorization required' }, { 'WWW-Authenticate': unauthorizedChallenge(config) });
      return;
    }

    let auth: AuthInfo;
    try {
      auth = await validator.verify(match[1]);
    } catch (error) {
      const limited = unauthLimiter.hit(`ip:${ip}`);
      if (!limited.allowed) {
        sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(limited.retryAfter) });
        return;
      }
      const description = error instanceof InvalidTokenError ? error.message : 'Invalid access token';
      logger.info('token_rejected', { reason: description, ip });
      sendJson(res, 401, { error: 'invalid_token', error_description: description }, {
        'WWW-Authenticate': unauthorizedChallenge(config, { code: 'invalid_token', description }),
      });
      return;
    }

    const grantKey = typeof auth.extra?.gid === 'string' ? auth.extra.gid : auth.clientId;
    const limited = tokenLimiter.hit(`grant:${grantKey}`);
    if (!limited.allowed) {
      sendJson(res, 429, { error: 'rate_limited', error_description: 'Muitas requisições. Aguarde alguns segundos.' }, { 'Retry-After': String(limited.retryAfter) });
      return;
    }

    auth.extra = { ...(auth.extra ?? {}), clientIp: ip };
    (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    await nodeHandler(req as IncomingMessage & { auth?: AuthInfo }, res);
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (() => {
      try {
        return new URL(req.url ?? '/', 'http://internal').pathname;
      } catch {
        return '/';
      }
    })();

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (config.env === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    res.on('finish', () => {
      metrics.httpRequest(res.statusCode);
      if (path !== '/health') {
        logger.info('http', { method: req.method, path, status: res.statusCode, ms: Date.now() - started });
      }
    });

    const route = async (): Promise<void> => {
      if (path === '/health') {
        sendJson(res, 200, { status: 'ok' });
      } else if (path === '/ready') {
        await ready(res);
      } else if (path.startsWith('/.well-known/')) {
        await wellKnown(req, res, path);
      } else if (path === '/metrics') {
        const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!config.metricsToken || !safeEqual(given, config.metricsToken)) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        sendJson(res, 200, metrics.snapshot());
      } else if (path === '/mcp' || path === '/mcp/') {
        await mcp(req, res);
      } else {
        sendJson(res, 404, { error: 'not_found' });
      }
    };

    route().catch((error: unknown) => {
      logger.error('http_unhandled', { path, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: 'server_error' });
    });
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000;
  server.on('close', () => {
    unauthLimiter.stop();
    tokenLimiter.stop();
  });
  return server;
}
