import { describe, expect, it } from 'vitest';
import { canonicalUri, loadConfig } from '../src/config.js';
import { protectedResourceMetadata, unauthorizedChallenge } from '../src/auth/oauth.js';
import { redact } from '../src/utils/logger.js';

const base = {
  NODE_ENV: 'production',
  MCP_PUBLIC_URL: 'https://mcp.licitanteprime.com.br',
  LICITANTE_PRIME_API_URL: 'https://licitanteprime.com.br/wp-json/lp-ai/v1',
  OAUTH_ISSUER: 'https://licitanteprime.com.br',
  LP_INTERNAL_API_KEY: 'x'.repeat(48),
};

describe('config', () => {
  it('deriva resource, audiências e metadata', () => {
    const config = loadConfig(base);
    expect(config.resourceUrl).toBe('https://mcp.licitanteprime.com.br/mcp');
    expect(config.audiences).toEqual(['https://mcp.licitanteprime.com.br/mcp', 'https://mcp.licitanteprime.com.br']);
    expect(config.resourceMetadataUrl).toBe('https://mcp.licitanteprime.com.br/.well-known/oauth-protected-resource/mcp');
    expect(config.jwksUrl).toBe('https://licitanteprime.com.br/wp-json/lp-ai/v1/oauth/jwks');
    expect(config.allowedHosts).toEqual(['mcp.licitanteprime.com.br']);
  });

  it('exige HTTPS em produção', () => {
    expect(() => loadConfig({ ...base, OAUTH_ISSUER: 'http://licitanteprime.com.br' })).toThrow('HTTPS');
  });

  it('exige chave interna forte', () => {
    expect(() => loadConfig({ ...base, LP_INTERNAL_API_KEY: 'curta' })).toThrow('LP_INTERNAL_API_KEY');
  });

  it('URI canônica', () => {
    expect(canonicalUri('HTTPS://MCP.Example.com:443/mcp/')).toBe('https://mcp.example.com/mcp');
  });

  it('metadata só nos caminhos previstos', () => {
    const config = loadConfig(base);
    expect(protectedResourceMetadata(config, '/.well-known/oauth-protected-resource/outro')).toBeNull();
    expect(protectedResourceMetadata(config, '/.well-known/oauth-protected-resource/mcp')?.resource).toBe(config.resourceUrl);
  });

  it('desafio 401 só com ASCII e aspas seguras', () => {
    const config = loadConfig(base);
    const header = unauthorizedChallenge(config, { code: 'invalid_token', description: 'Conexão "revogada"' });
    expect(header).toMatch(/^Bearer error="invalid_token", error_description="Conexo revogada"/);
  });

  it('logger mascara segredos', () => {
    expect(redact({ token: 'abc', nested: { Authorization: 'Bearer x', ok: 1 } })).toEqual({ token: '[redacted]', nested: { Authorization: '[redacted]', ok: 1 } });
  });
});
