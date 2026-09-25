import { readFileSync } from 'node:fs';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { buildApp } from './app.js';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env, packageVersion());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const logger = createLogger(config.logLevel);
  const { server, mcp, validator, asMirror } = buildApp(config, logger);

  // Pré-carrega a JWKS e a metadata; se o WordPress estiver fora, tenta de novo sob demanda.
  await Promise.allSettled([validator.refresh(), asMirror.refresh()]).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(index === 0 ? 'jwks_initial_load_failed' : 'as_metadata_initial_load_failed', { error: String(result.reason) });
      }
    });
  });

  server.listen(config.port, config.host, () => {
    logger.info('listening', { port: config.port, resource: config.resourceUrl, issuer: config.issuer, version: config.version });
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info('shutdown', { signal });
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    server.close(() => {
      void mcp.close().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', { error: String(reason) }));
}

void main();
