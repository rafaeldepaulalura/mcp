import { z } from 'zod';

/**
 * Configuração vinda do ambiente (EasyPanel). Falha na partida se algo
 * obrigatório estiver ausente ou inseguro — melhor não subir do que subir aberto.
 */

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );

const bool = z
  .string()
  .optional()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  MCP_PUBLIC_URL: z.string().url(),
  MCP_RESOURCE_URL: z.string().url().optional(),

  LICITANTE_PRIME_API_URL: z.string().url(),
  OAUTH_ISSUER: z.string().url(),
  OAUTH_JWKS_URL: z.string().url().optional(),
  OAUTH_METADATA_URL: z.string().url().optional(),

  LP_INTERNAL_API_KEY: z.string().min(32, 'LP_INTERNAL_API_KEY precisa de pelo menos 32 caracteres'),

  WP_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000),
  ALLOWED_HOSTS: csv,
  CORS_ALLOWED_ORIGINS: csv,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(120),
  RATE_LIMIT_UNAUTH_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(60),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(4 * 1024 * 1024).default(64 * 1024),
  METRICS_TOKEN: z.string().min(16).optional(),
  OPENAI_APPS_CHALLENGE_TOKEN: z.string().regex(/^[A-Za-z0-9._~-]{8,512}$/).optional(),
  ALLOW_INSECURE_HTTP: bool,
});

export interface AppConfig {
  env: 'production' | 'development' | 'test';
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  publicUrl: string;
  resourceUrl: string;
  /** Audiências aceitas no token: a URI do /mcp e a origem (RFC 9728 na raiz). */
  audiences: string[];
  resourceMetadataUrl: string;
  apiUrl: string;
  issuer: string;
  jwksUrl: string;
  asMetadataUrl: string;
  internalKey: string;
  apiTimeoutMs: number;
  allowedHosts: string[];
  corsOrigins: string[];
  rateLimitPerMinute: number;
  rateLimitUnauthPerMinute: number;
  trustProxyHops: number;
  maxBodyBytes: number;
  metricsToken: string | undefined;
  /** Token da verificação de domínio da OpenAI (publicação no diretório do ChatGPT). */
  openaiChallengeToken: string | undefined;
  scopes: string[];
  version: string;
}

export const SCOPES = ['lp.profile.read', 'lp.tenders.search', 'lp.tenders.read', 'lp.items.read'] as const;

/** Forma canônica (RFC 8707): esquema/host minúsculos, sem barra final, sem fragmento. */
export function canonicalUri(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '1.0.0'): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const e = parsed.data;

  const publicUrl = canonicalUri(e.MCP_PUBLIC_URL);
  const resourceUrl = canonicalUri(e.MCP_RESOURCE_URL ?? `${publicUrl}/mcp`);
  const issuer = e.OAUTH_ISSUER.replace(/\/+$/, '');
  const apiUrl = e.LICITANTE_PRIME_API_URL.replace(/\/+$/, '');

  if (e.NODE_ENV === 'production' && !e.ALLOW_INSECURE_HTTP) {
    for (const [name, value] of Object.entries({ MCP_PUBLIC_URL: publicUrl, OAUTH_ISSUER: issuer, LICITANTE_PRIME_API_URL: apiUrl })) {
      if (!value.startsWith('https://')) {
        throw new Error(`${name} precisa ser HTTPS em produção.`);
      }
    }
  }

  const resource = new URL(resourceUrl);
  const origin = `${resource.protocol}//${resource.host}`;
  const resourcePath = resource.pathname.replace(/\/+$/, '');
  const allowedHosts = e.ALLOWED_HOSTS.length > 0 ? e.ALLOWED_HOSTS : [new URL(publicUrl).hostname];

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    publicUrl,
    resourceUrl,
    audiences: Array.from(new Set([resourceUrl, origin])),
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${resourcePath}`,
    apiUrl,
    issuer,
    jwksUrl: e.OAUTH_JWKS_URL ?? `${apiUrl}/oauth/jwks`,
    asMetadataUrl: e.OAUTH_METADATA_URL ?? `${issuer}/.well-known/oauth-authorization-server`,
    internalKey: e.LP_INTERNAL_API_KEY,
    apiTimeoutMs: e.WP_API_TIMEOUT_MS,
    allowedHosts: allowedHosts.map((host) => host.toLowerCase()),
    corsOrigins: e.CORS_ALLOWED_ORIGINS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    rateLimitUnauthPerMinute: e.RATE_LIMIT_UNAUTH_PER_MINUTE,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    maxBodyBytes: e.MAX_BODY_BYTES,
    metricsToken: e.METRICS_TOKEN,
    openaiChallengeToken: e.OPENAI_APPS_CHALLENGE_TOKEN,
    scopes: [...SCOPES],
    version,
  };
}
