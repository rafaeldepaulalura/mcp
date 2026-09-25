import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig, type AppConfig } from '../src/config.js';

export const INTERNAL_KEY = 'k'.repeat(40);

export interface KeyPair {
  privateKey: KeyObject;
  jwk: { kty: string; crv: string; x: string; kid: string; alg: string; use: string };
}

export function makeKeyPair(kid = 'test-kid'): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exported = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: exported.x, kid, alg: 'EdDSA', use: 'sig' } };
}

export function signJwt(key: KeyPair, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt', kid: key.jwk.kid, ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = sign(null, Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

export function claimsFor(config: AppConfig, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: config.issuer,
    sub: '42',
    aud: config.resourceUrl,
    client_id: 'lpai_test',
    scope: 'lp.profile.read lp.tenders.search lp.tenders.read lp.items.read',
    gid: 'a'.repeat(32),
    iat: now,
    nbf: now - 5,
    exp: now + 600,
    jti: 'jti-1',
    ...overrides,
  };
}

export interface FakeWpCall {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type FakeWpHandler = (call: FakeWpCall) => { status: number; body: unknown; headers?: Record<string, string> };

/** WordPress falso: JWKS, metadata e a API lp-ai/v1. */
export async function startFakeWp(key: KeyPair, handler: FakeWpHandler): Promise<{ server: Server; url: string; calls: FakeWpCall[] }> {
  const calls: FakeWpCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const path = req.url ?? '/';
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      let status = 200;
      let payload: unknown;
      let headers: Record<string, string> = {};
      if (path === '/wp-json/lp-ai/v1/oauth/jwks') {
        payload = { keys: [key.jwk] };
      } else if (path === '/.well-known/oauth-authorization-server') {
        payload = { issuer: origin, authorization_endpoint: `${origin}/lp-ai/oauth/authorize`, token_endpoint: `${origin}/wp-json/lp-ai/v1/oauth/token` };
      } else if (path === '/wp-json/lp-ai/v1/health') {
        payload = { status: 'ok' };
      } else {
        const call = { method: req.method ?? 'GET', path: path.replace('/wp-json/lp-ai/v1', ''), headers: req.headers, body };
        calls.push(call);
        const out = handler(call);
        status = out.status;
        payload = out.body;
        headers = out.headers ?? {};
      }
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, calls };
}

export function testConfig(wpUrl: string, extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://127.0.0.1',
    LICITANTE_PRIME_API_URL: `${wpUrl}/wp-json/lp-ai/v1`,
    OAUTH_ISSUER: wpUrl,
    LP_INTERNAL_API_KEY: INTERNAL_KEY,
    LOG_LEVEL: 'error',
    ...extra,
  });
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Lê resposta MCP em JSON ou SSE (event: message / data: {...}). */
export async function readRpc(response: Response): Promise<any> {
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
    return messages.find((message) => 'result' in message || 'error' in message) ?? messages.at(-1);
  }
  return text ? JSON.parse(text) : null;
}

let rpcId = 0;
export async function rpc(base: string, token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
}

export const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'vitest', version: '1.0.0' },
};
