import type { AppConfig } from './config.js';
import type { Logger } from './utils/logger.js';
import { Metrics } from './utils/metrics.js';
import { TokenValidator } from './auth/token-validator.js';
import { AuthorizationServerMetadataMirror } from './auth/oauth.js';
import { LicitantePrimeApi } from './services/licitante-prime-api.js';
import { createHandler } from './mcp.js';
import { createHttpServer } from './server.js';

/** Monta todas as peças (usado pelo index.ts e pelos testes de integração). */
export function buildApp(config: AppConfig, logger: Logger, fetchImpl: typeof fetch = fetch) {
  const metrics = new Metrics();
  const validator = new TokenValidator({
    issuer: config.issuer,
    audiences: config.audiences,
    jwksUrl: config.jwksUrl,
    resourceUrl: config.resourceUrl,
    resourceMetadataUrl: config.resourceMetadataUrl,
    logger,
    fetchImpl,
  });
  const api = new LicitantePrimeApi({
    config,
    logger,
    metrics,
    fetchImpl,
    onRevoked: (grantId, expiresAt) => validator.markRevoked(grantId, expiresAt),
  });
  const asMirror = new AuthorizationServerMetadataMirror(config, logger, fetchImpl);
  const mcp = createHandler({ api, logger, metrics }, config);
  const server = createHttpServer({ config, logger, metrics, validator, api, asMirror, mcp });
  return { server, mcp, validator, asMirror, metrics };
}
