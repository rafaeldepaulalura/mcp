import type { AuthInfo, CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import type { CallContext, LicitantePrimeApi } from '../services/licitante-prime-api.js';
import type { Logger } from '../utils/logger.js';
import type { Metrics } from '../utils/metrics.js';
import { LpApiError, toolError } from '../utils/errors.js';

export interface ToolDeps {
  api: LicitantePrimeApi;
  logger: Logger;
  metrics: Metrics;
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
}

/** Dicas de comportamento comuns às quatro ferramentas (MCP tool annotations). */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function callContext(tool: string, auth: AuthInfo): CallContext {
  const extra = auth.extra ?? {};
  return {
    token: auth.token,
    tool,
    clientIp: typeof extra.clientIp === 'string' ? extra.clientIp : undefined,
    grantId: typeof extra.gid === 'string' ? extra.gid : undefined,
    expiresAt: auth.expiresAt,
  };
}

/**
 * Executa uma ferramenta: pega o token validado no HTTP, chama o WordPress e
 * devolve JSON estruturado (structuredContent) + a mesma coisa em texto para
 * clientes que só leem `content`.
 */
export async function runTool(
  name: string,
  deps: ToolDeps,
  ctx: ServerContext,
  call: (callCtx: CallContext) => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  const started = Date.now();
  const auth = ctx.http?.authInfo;
  if (!auth) {
    deps.metrics.toolCall(name, 0, false);
    return toolError('AUTH_REQUIRED', 'Conecte sua conta do Licitante Prime para continuar.');
  }
  try {
    const result = await call(callContext(name, auth));
    deps.metrics.toolCall(name, Date.now() - started, true);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    deps.metrics.toolCall(name, Date.now() - started, false);
    if (error instanceof LpApiError) {
      deps.logger.info('tool_error', { tool: name, code: error.code, status: error.status });
      return toolError(error);
    }
    deps.logger.error('tool_crash', { tool: name, error: error instanceof Error ? error.message : String(error) });
    return toolError('INTERNAL_ERROR', 'Falha temporária. Tente novamente em instantes.');
  }
}
