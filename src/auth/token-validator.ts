import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Logger } from '../utils/logger.js';

/**
 * Valida localmente o access token emitido pelo WordPress (JWT EdDSA, RFC 9068):
 * assinatura pela JWKS pública, emissor, audiência (este servidor MCP),
 * validade. A conexão revogada e a assinatura do usuário são conferidas pelo
 * WordPress em cada chamada de ferramenta — aqui só barramos token inválido
 * antes de gastar uma ida ao WordPress.
 */

export class InvalidTokenError extends Error {
  constructor(
    message: string,
    public readonly expired = false,
  ) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface TokenValidatorOptions {
  issuer: string;
  audiences: string[];
  jwksUrl: string;
  resourceUrl: string;
  resourceMetadataUrl: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Chaves fixas (testes ou ambiente sem acesso à JWKS). */
  staticJwks?: Jwk[];
  leewaySeconds?: number;
  jwksTtlMs?: number;
}

export interface TokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  gid: string;
  client_id: string;
  scope: string;
}

export class TokenValidator {
  private keys = new Map<string, KeyObject>();
  private loadedAt = 0;
  private lastRefreshAttempt = 0;
  private inflight: Promise<void> | null = null;
  /** Conexões que o WordPress já disse estarem revogadas (até o token expirar). */
  private readonly revoked = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly leeway: number;
  private readonly ttl: number;

  constructor(private readonly opts: TokenValidatorOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.leeway = opts.leewaySeconds ?? 30;
    this.ttl = opts.jwksTtlMs ?? 10 * 60_000;
    if (opts.staticJwks) {
      this.setKeys(opts.staticJwks);
      this.loadedAt = Number.MAX_SAFE_INTEGER;
    }
  }

  get hasKeys(): boolean {
    return this.keys.size > 0;
  }

  async verify(token: string): Promise<AuthInfo> {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 4096) {
      throw new InvalidTokenError('Malformed access token');
    }
    const [h, p, s] = parts as [string, string, string];
    const header = decodeJson(h);
    const claims = decodeJson(p) as Partial<TokenClaims> | null;
    if (!header || !claims) {
      throw new InvalidTokenError('Malformed access token');
    }
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
      throw new InvalidTokenError('Unsupported token algorithm');
    }

    const key = await this.keyFor(header.kid);
    const signature = Buffer.from(s, 'base64url');
    const valid = key !== undefined && signature.length === 64 && cryptoVerify(null, Buffer.from(`${h}.${p}`), key, signature);
    if (!valid) {
      throw new InvalidTokenError('Invalid token signature');
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.opts.issuer) {
      throw new InvalidTokenError('Token issued by another authorization server');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((aud) => typeof aud === 'string' && this.opts.audiences.includes(aud))) {
      throw new InvalidTokenError('Token audience is not this MCP server');
    }
    if (typeof claims.exp !== 'number' || claims.exp < now - this.leeway) {
      throw new InvalidTokenError('The access token expired', true);
    }
    if (typeof claims.nbf === 'number' && claims.nbf > now + this.leeway) {
      throw new InvalidTokenError('Token not yet valid');
    }
    if (typeof claims.sub !== 'string' || !/^\d+$/.test(claims.sub) || typeof claims.gid !== 'string' || typeof claims.client_id !== 'string') {
      throw new InvalidTokenError('Malformed access token');
    }
    if (this.isRevoked(claims.gid)) {
      throw new InvalidTokenError('Connection revoked');
    }

    return {
      token,
      clientId: claims.client_id,
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
      expiresAt: claims.exp,
      resource: new URL(this.opts.resourceUrl),
      resourceMetadataUrl: this.opts.resourceMetadataUrl,
      extra: { sub: claims.sub, gid: claims.gid },
    };
  }

  /** O WordPress respondeu que a conexão foi revogada: recusa o token aqui até ele expirar. */
  markRevoked(gid: string, expiresAt?: number): void {
    const until = (expiresAt ?? Math.floor(Date.now() / 1000) + 3600) * 1000;
    this.revoked.set(gid, until);
    if (this.revoked.size > 10_000) {
      const oldest = this.revoked.keys().next().value;
      if (oldest !== undefined) {
        this.revoked.delete(oldest);
      }
    }
  }

  private isRevoked(gid: string): boolean {
    const until = this.revoked.get(gid);
    if (until === undefined) {
      return false;
    }
    if (until < Date.now()) {
      this.revoked.delete(gid);
      return false;
    }
    return true;
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const stale = Date.now() - this.loadedAt > this.ttl;
    if (!this.keys.has(kid) || stale) {
      // kid desconhecido = chave girada no WordPress. Recarrega no máximo a cada 30 s.
      if (stale || Date.now() - this.lastRefreshAttempt > 30_000) {
        await this.refresh().catch((error: unknown) => {
          this.opts.logger.warn('jwks_refresh_failed', { error: error instanceof Error ? error.message : String(error) });
        });
      }
    }
    return this.keys.get(kid);
  }

  async refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.lastRefreshAttempt = Date.now();
    this.inflight = (async () => {
      const response = await this.fetchImpl(this.opts.jwksUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        throw new Error(`JWKS HTTP ${response.status}`);
      }
      const body = (await response.json()) as { keys?: Jwk[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw new Error('JWKS sem chaves');
      }
      this.setKeys(body.keys);
      this.loadedAt = Date.now();
      this.opts.logger.info('jwks_loaded', { keys: this.keys.size });
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private setKeys(jwks: Jwk[]): void {
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks) {
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.kid !== 'string') {
        continue;
      }
      next.set(jwk.kid, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
    }
    if (next.size > 0) {
      this.keys = next;
    }
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
