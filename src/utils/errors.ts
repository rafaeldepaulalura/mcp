import type { CallToolResult } from '@modelcontextprotocol/server';

/** Códigos padronizados, iguais aos da API do WordPress. */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'TOKEN_EXPIRED',
  'SUBSCRIPTION_INACTIVE',
  'PERMISSION_DENIED',
  'INVALID_QUERY',
  'TENDER_NOT_FOUND',
  'MEILISEARCH_ERROR',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class LpApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'LpApiError';
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** O que dizer ao usuário (a IA repassa) em cada erro. Sem detalhe interno. */
const HINTS: Partial<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: 'Peça ao usuário para reconectar o Licitante Prime nas configurações de conectores/aplicativos.',
  TOKEN_EXPIRED: 'A conexão expirou; o aplicativo deve renovar o acesso automaticamente. Se persistir, reconecte o Licitante Prime.',
  SUBSCRIPTION_INACTIVE: 'O usuário precisa de uma assinatura ativa do Licitante Prime (licitanteprime.com.br).',
  PERMISSION_DENIED: 'A conta ou a conexão não tem permissão para esta operação.',
  INVALID_QUERY: 'Corrija os parâmetros e tente de novo.',
  TENDER_NOT_FOUND: 'Confira o id — use exatamente o campo "id" retornado por buscar_licitacoes.',
  RATE_LIMITED: 'Aguarde alguns segundos antes de nova consulta e evite repetir a mesma busca.',
  SERVICE_UNAVAILABLE: 'O Licitante Prime está temporariamente indisponível. Tente mais tarde.',
  INTERNAL_ERROR: 'Falha temporária. Tente novamente em instantes.',
};

/** Resultado de ferramenta com erro (isError), com texto e estrutura. */
export function toolError(error: LpApiError | ErrorCode, message?: string): CallToolResult {
  const code = typeof error === 'string' ? error : error.code;
  const text = typeof error === 'string' ? (message ?? code) : error.message;
  const payload: Record<string, unknown> = { error: code, message: text };
  const hint = HINTS[code];
  if (hint) {
    payload.hint = hint;
  }
  if (typeof error !== 'string' && error.retryAfter) {
    payload.retry_after_seconds = error.retryAfter;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}
