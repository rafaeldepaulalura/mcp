import type { AppConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';

/**
 * Descoberta OAuth do lado do servidor de recurso (RFC 9728) e desafios
 * WWW-Authenticate (RFC 6750). O servidor de autorização é o WordPress.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

/**
 * Documento para cada caminho. O `resource` precisa ser o identificador cujo
 * caminho gerou a URL (RFC 9728 §3.3): na raiz vale a origem, em /mcp vale /mcp.
 */
export function protectedResourceMetadata(config: AppConfig, path: string): ProtectedResourceMetadata | null {
  const resource = new URL(config.resourceUrl);
  const origin = `${resource.protocol}//${resource.host}`;
  const resourcePath = resource.pathname.replace(/\/+$/, '');
  const base = '/.well-known/oauth-protected-resource';
  let value: string | null = null;
  if (path === base || path === `${base}/`) {
    value = origin;
  } else if (resourcePath !== '' && path === `${base}${resourcePath}`) {
    value = config.resourceUrl;
  }
  if (value === null) {
    return null;
  }
  return {
    resource: value,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopes,
    bearer_methods_supported: ['header'],
    resource_name: 'Licitante Prime AI',
    resource_documentation: config.issuer,
  };
}

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '')}"`;
}

/** 401: sem token ou token inválido/expirado. */
export function unauthorizedChallenge(config: AppConfig, error?: { code: 'invalid_token'; description: string }): string {
  const parts = [`resource_metadata=${quote(config.resourceMetadataUrl)}`, `scope=${quote(config.scopes.join(' '))}`];
  if (error) {
    parts.unshift(`error=${quote(error.code)}`, `error_description=${quote(error.description.replace(/[^\x20-\x7E]/g, ''))}`);
  }
  return `Bearer ${parts.join(', ')}`;
}

/**
 * Cópia da metadata do servidor de autorização, servida também na origem do MCP
 * para clientes da spec 2025-03-26 (que procuravam o AS na origem do servidor).
 * Clientes atuais usam a metadata do recurso e vão direto ao WordPress.
 */
export class AuthorizationServerMetadataMirror {
  private document: Record<string, unknown> | null = null;
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<Record<string, unknown> | null> {
    if (Date.now() - this.fetchedAt > 10 * 60_000) {
      await this.refresh().catch((error: unknown) => {
        this.logger.warn('as_metadata_refresh_failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }
    return this.document;
  }

  async refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = (async () => {
      this.fetchedAt = Date.now();
      const response = await this.fetchImpl(this.config.asMetadataUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body.issuer !== this.config.issuer) {
        throw new Error(`issuer da metadata (${String(body.issuer)}) difere de OAUTH_ISSUER (${this.config.issuer})`);
      }
      this.document = body;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
