import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { silentLogger } from '../src/utils/logger.js';
import type { AppConfig } from '../src/config.js';
import {
  claimsFor,
  close,
  INITIALIZE_PARAMS,
  INTERNAL_KEY,
  listen,
  makeKeyPair,
  readRpc,
  rpc,
  signJwt,
  startFakeWp,
  testConfig,
  type FakeWpCall,
} from './helpers.js';

const key = makeKeyPair();
const SEARCH_RESULT = {
  total: 1,
  returned: 1,
  page: 1,
  limit: 20,
  results: [
    {
      id: '123',
      title: 'Pregão - Eletrônico nº 90012/2026',
      object: 'Aquisição de pneus para caminhões',
      organization: 'Prefeitura de Campinas',
      city: 'Campinas',
      uf: 'SP',
      portal: 'Compras.gov.br',
      modality: 'Pregão - Eletrônico',
      deadline: '2026-10-02T09:00:00-03:00',
      days_until_deadline: 7,
      status: 'open',
      estimated_value: null,
      deserted_risk: false,
      collected_at: '2026-09-20T10:00:00-03:00',
      url: 'https://pncp.gov.br/app/editais/1',
      licitante_prime_url: null,
    },
  ],
  next_cursor: null,
  applied_filters: { query: 'pneu' },
  warnings: [],
  meta: { engine: 'meilisearch', took_ms: 12 },
};

let wpBehavior: (call: FakeWpCall) => { status: number; body: unknown } = () => ({ status: 200, body: SEARCH_RESULT });

describe('servidor MCP (HTTP real + WordPress falso)', () => {
  let wp: Awaited<ReturnType<typeof startFakeWp>>;
  let app: ReturnType<typeof buildApp>;
  let base: string;
  let config: AppConfig;
  let token: string;

  beforeAll(async () => {
    wp = await startFakeWp(key, (call) => wpBehavior(call));
    config = testConfig(wp.url, { RATE_LIMIT_PER_MINUTE: '30', CORS_ALLOWED_ORIGINS: 'http://localhost:6274' });
    app = buildApp(config, silentLogger);
    await app.validator.refresh();
    base = await listen(app.server);
    token = signJwt(key, claimsFor(config));
  });

  afterAll(async () => {
    await close(app.server);
    await app.mcp.close();
    await close(wp.server);
  });

  it('health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('ready confere JWKS e WordPress', async () => {
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { jwks: true, wordpress: true } });
  });

  it('metadata do recurso em /mcp e na raiz (RFC 9728)', async () => {
    const atPath = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(atPath).toMatchObject({ resource: config.resourceUrl, authorization_servers: [config.issuer] });
    expect(atPath.scopes_supported).toContain('lp.tenders.search');
    const atRoot = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as any;
    expect(atRoot.resource).toBe(new URL(config.resourceUrl).origin);
  });

  it('espelha a metadata do servidor de autorização', async () => {
    const doc = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(doc.issuer).toBe(config.issuer);
  });

  it('sem token → 401 com WWW-Authenticate apontando para a metadata', async () => {
    const res = await rpc(base, null, 'initialize', INITIALIZE_PARAMS);
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(`resource_metadata="${config.resourceMetadataUrl}"`);
    expect(challenge).toContain('scope="lp.profile.read');
  });

  it('token inválido → 401 invalid_token', async () => {
    const res = await rpc(base, 'abc.def.ghi', 'initialize', INITIALIZE_PARAMS);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('token de outra audiência → 401', async () => {
    const other = signJwt(key, claimsFor(config, { aud: 'https://outro.example/mcp' }));
    expect((await rpc(base, other, 'initialize', INITIALIZE_PARAMS)).status).toBe(401);
  });

  it('origem de navegador não autorizada → 403', async () => {
    const res = await rpc(base, token, 'initialize', INITIALIZE_PARAMS, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('initialize (cliente 2025) devolve instruções e capacidade de tools', async () => {
    const res = await rpc(base, token, 'initialize', INITIALIZE_PARAMS);
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect(body.result.serverInfo.name).toBe('licitante-prime');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain('buscar_licitacoes');
  });

  it('tools/list: exatamente as 4 ferramentas, somente leitura', async () => {
    const body = await readRpc(await rpc(base, token, 'tools/list'));
    const tools = body.result.tools as Array<{ name: string; annotations: Record<string, boolean>; inputSchema: any }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['buscar_itens', 'buscar_licitacoes', 'detalhes_licitacao', 'meu_perfil']);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
    const search = tools.find((t) => t.name === 'buscar_licitacoes')!;
    expect(search.inputSchema.properties.limit.maximum).toBe(50);
    expect(search.inputSchema.properties.ufs.items.enum).toContain('SP');
  });

  it('buscar_licitacoes chama o WordPress com chave interna e token, e devolve dados estruturados', async () => {
    wpBehavior = () => ({ status: 200, body: SEARCH_RESULT });
    const before = wp.calls.length;
    const body = await readRpc(await rpc(base, token, 'tools/call', { name: 'buscar_licitacoes', arguments: { query: 'pneu caminhão', ufs: ['SP'] } }));
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.total).toBe(1);
    expect(body.result.structuredContent.results[0].estimated_value).toBeNull();
    expect(JSON.parse(body.result.content[0].text).results[0].id).toBe('123');
    const call = wp.calls[before]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/search');
    expect(call.headers['x-lp-ai-internal-key']).toBe(INTERNAL_KEY);
    expect(call.headers['x-lp-ai-token']).toBe(token);
    expect(call.headers['x-lp-ai-tool']).toBe('buscar_licitacoes');
    expect(call.headers['x-lp-ai-client-ip']).toBe('127.0.0.1');
    expect(JSON.parse(call.body)).toMatchObject({ query: 'pneu caminhão', ufs: ['SP'] });
  });

  it('limit acima de 50 é recusado sem chamar o WordPress', async () => {
    const before = wp.calls.length;
    const body = await readRpc(await rpc(base, token, 'tools/call', { name: 'buscar_licitacoes', arguments: { query: 'x', limit: 51 } }));
    expect(body.result?.isError ?? Boolean(body.error)).toBe(true);
    expect(wp.calls.length).toBe(before);
  });

  it('ID inválido é recusado sem chamar o WordPress', async () => {
    const before = wp.calls.length;
    const body = await readRpc(await rpc(base, token, 'tools/call', { name: 'detalhes_licitacao', arguments: { id: "1' OR '1'='1" } }));
    expect(body.result?.isError ?? Boolean(body.error)).toBe(true);
    expect(wp.calls.length).toBe(before);
  });

  it('assinatura inativa vira erro de ferramenta legível', async () => {
    wpBehavior = () => ({ status: 403, body: { error: 'SUBSCRIPTION_INACTIVE', message: 'Sua assinatura do Licitante Prime não está ativa.' } });
    const body = await readRpc(await rpc(base, token, 'tools/call', { name: 'meu_perfil', arguments: {} }));
    expect(body.result.isError).toBe(true);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.error).toBe('SUBSCRIPTION_INACTIVE');
    expect(payload.hint).toContain('assinatura');
  });

  it('detalhes e itens repassam o id', async () => {
    wpBehavior = (call) =>
      call.path.endsWith('/items?page=2&limit=10')
        ? { status: 200, body: { tender_id: '123', total: 12, page: 2, limit: 10, returned: 2, next_page: null, items: [{ item_number: '11', description: 'Pneu', quantity: 4, unit: 'UN', estimated_unit_value: null, estimated_total_value: null }] } }
        : { status: 200, body: { ...SEARCH_RESULT.results[0], number: '90012/2026', organization_cnpj: '00000000000191', items_count: 12, edital_url: null } };
    const detail = await readRpc(await rpc(base, token, 'tools/call', { name: 'detalhes_licitacao', arguments: { id: '123' } }));
    expect(detail.result.structuredContent.items_count).toBe(12);
    const items = await readRpc(await rpc(base, token, 'tools/call', { name: 'buscar_itens', arguments: { tender_id: '123', page: 2, limit: 10 } }));
    expect(items.result.structuredContent.items[0].description).toBe('Pneu');
  });

  it('aceita o id como número (alguns clientes mandam assim)', async () => {
    const before = wp.calls.length;
    const detail = await readRpc(await rpc(base, token, 'tools/call', { name: 'detalhes_licitacao', arguments: { id: 123 } }));
    expect(detail.result.isError).toBeFalsy();
    expect(wp.calls[before]!.path).toBe('/tender/123');
  });

  it('token sem o escopo da ferramenta → 403 insufficient_scope (step-up)', async () => {
    const narrow = signJwt(key, claimsFor(config, { scope: 'lp.profile.read', gid: 'b'.repeat(32) }));
    const res = await rpc(base, narrow, 'tools/call', { name: 'buscar_itens', arguments: { tender_id: '123' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('conexão revogada no WordPress → próximas requisições já recebem 401', async () => {
    const revokedToken = signJwt(key, claimsFor(config, { gid: 'c'.repeat(32) }));
    wpBehavior = () => ({ status: 401, body: { error: 'AUTH_REQUIRED', message: 'Esta conexão foi desconectada.', reason: 'connection_revoked' } });
    const first = await readRpc(await rpc(base, revokedToken, 'tools/call', { name: 'meu_perfil', arguments: {} }));
    expect(first.result.isError).toBe(true);
    const second = await rpc(base, revokedToken, 'tools/list');
    expect(second.status).toBe(401);
  });

  it('sem JWKS acessível não há como validar: falha fechada (401)', async () => {
    const offline = buildApp(testConfig('http://127.0.0.1:9'), silentLogger);
    const offlineBase = await listen(offline.server);
    const res = await rpc(offlineBase, signJwt(key, claimsFor(testConfig('http://127.0.0.1:9'))), 'tools/list');
    expect(res.status).toBe(401);
    await close(offline.server);
    await offline.mcp.close();
  });

  it('API do WordPress fora do ar → SERVICE_UNAVAILABLE sem vazar detalhe', async () => {
    const offlineConfig = testConfig(wp.url, {
      LICITANTE_PRIME_API_URL: 'http://127.0.0.1:9/wp-json/lp-ai/v1',
      OAUTH_JWKS_URL: `${wp.url}/wp-json/lp-ai/v1/oauth/jwks`,
      WP_API_TIMEOUT_MS: '1000',
    });
    const offline = buildApp(offlineConfig, silentLogger);
    const offlineBase = await listen(offline.server);
    const body = await readRpc(await rpc(offlineBase, signJwt(key, claimsFor(offlineConfig)), 'tools/call', { name: 'meu_perfil', arguments: {} }));
    expect(body.result.isError).toBe(true);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.error).toBe('SERVICE_UNAVAILABLE');
    expect(body.result.content[0].text).not.toContain('ECONNREFUSED');
    await close(offline.server);
    await offline.mcp.close();
  });

  it('cliente 2026-07-28 (sem initialize): server/discover e tools/list com envelope _meta', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'vitest-modern', version: '1.0.0' },
    };
    const discover = await rpc(base, token, 'server/discover', { _meta: meta }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' });
    expect(discover.status).toBe(200);
    const discovered = await readRpc(discover);
    expect(JSON.stringify(discovered.result)).toContain('2026-07-28');
    const list = await readRpc(await rpc(base, token, 'tools/list', { _meta: meta }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }));
    expect(list.result.tools).toHaveLength(4);
  });

  it('logo do Licitante Prime em /icon.png, no serverInfo e nas ferramentas', async () => {
    const img = await fetch(`${base}/icon.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(200);
    const init = await readRpc(await rpc(base, token, 'initialize', INITIALIZE_PARAMS));
    expect(init.result.serverInfo.icons[0].src).toBe(`${config.publicUrl}/icon.png`);
    const list = await readRpc(await rpc(base, token, 'tools/list'));
    expect(list.result.tools.every((t: any) => t.icons?.[0]?.src.endsWith('/icon.png'))).toBe(true);
  });

  it('/metrics exige token', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});

describe('limite por conexão', () => {
  it('estoura com 429 e Retry-After', async () => {
    const wp = await startFakeWp(key, () => ({ status: 200, body: SEARCH_RESULT }));
    const config = testConfig(wp.url, { RATE_LIMIT_PER_MINUTE: '3' });
    const app = buildApp(config, silentLogger);
    await app.validator.refresh();
    const base = await listen(app.server);
    const token = signJwt(key, claimsFor(config, { gid: 'd'.repeat(32) }));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await rpc(base, token, 'tools/list')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    await close(app.server);
    await app.mcp.close();
    await close(wp.server);
  });
});
