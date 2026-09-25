import { describe, expect, it, vi } from 'vitest';
import { InvalidTokenError, TokenValidator } from '../src/auth/token-validator.js';
import { silentLogger } from '../src/utils/logger.js';
import { claimsFor, makeKeyPair, signJwt, testConfig } from './helpers.js';

const config = testConfig('https://licitanteprime.example');
const key = makeKeyPair();

function validator(overrides: Partial<ConstructorParameters<typeof TokenValidator>[0]> = {}) {
  return new TokenValidator({
    issuer: config.issuer,
    audiences: config.audiences,
    jwksUrl: config.jwksUrl,
    resourceUrl: config.resourceUrl,
    resourceMetadataUrl: config.resourceMetadataUrl,
    logger: silentLogger,
    staticJwks: [key.jwk],
    ...overrides,
  });
}

describe('TokenValidator', () => {
  it('aceita token válido e devolve AuthInfo', async () => {
    const auth = await validator().verify(signJwt(key, claimsFor(config)));
    expect(auth.clientId).toBe('lpai_test');
    expect(auth.scopes).toContain('lp.tenders.search');
    expect(auth.extra).toMatchObject({ sub: '42', gid: 'a'.repeat(32) });
    expect(auth.resource?.toString()).toBe(config.resourceUrl);
  });

  it('aceita a origem como audiência (metadata na raiz)', async () => {
    const origin = new URL(config.resourceUrl).origin;
    await expect(validator().verify(signJwt(key, claimsFor(config, { aud: origin })))).resolves.toBeTruthy();
  });

  it.each([
    ['assinatura de outra chave', () => signJwt(makeKeyPair('test-kid'), claimsFor(config))],
    ['emissor diferente', () => signJwt(key, claimsFor(config, { iss: 'https://evil.example' }))],
    ['audiência de outro servidor', () => signJwt(key, claimsFor(config, { aud: 'https://outro.example/mcp' }))],
    ['sem gid', () => signJwt(key, claimsFor(config, { gid: undefined }))],
    ['sub não numérico', () => signJwt(key, claimsFor(config, { sub: 'admin' }))],
    ['alg none', () => signJwt(key, claimsFor(config), { alg: 'none' })],
    ['lixo', () => 'abc.def.ghi'],
  ])('recusa: %s', async (_name, make) => {
    await expect(validator().verify(make())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('recusa payload adulterado', async () => {
    const [h, , s] = signJwt(key, claimsFor(config)).split('.');
    const forged = Buffer.from(JSON.stringify(claimsFor(config, { sub: '1' }))).toString('base64url');
    await expect(validator().verify(`${h}.${forged}.${s}`)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('marca token expirado', async () => {
    const now = Math.floor(Date.now() / 1000);
    const error = await validator()
      .verify(signJwt(key, claimsFor(config, { exp: now - 120 })))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidTokenError);
    expect((error as InvalidTokenError).expired).toBe(true);
  });

  it('recusa conexão marcada como revogada', async () => {
    const v = validator();
    v.markRevoked('a'.repeat(32));
    await expect(v.verify(signJwt(key, claimsFor(config)))).rejects.toThrow('revoked');
  });

  it('recarrega a JWKS quando aparece kid novo (chave girada)', async () => {
    const rotated = makeKeyPair('kid-2');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ keys: [rotated.jwk] }), { status: 200 }));
    const v = new TokenValidator({
      issuer: config.issuer,
      audiences: config.audiences,
      jwksUrl: config.jwksUrl,
      resourceUrl: config.resourceUrl,
      resourceMetadataUrl: config.resourceMetadataUrl,
      logger: silentLogger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(v.verify(signJwt(rotated, claimsFor(config)))).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
