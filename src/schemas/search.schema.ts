import { z } from 'zod';

/**
 * Entrada de buscar_licitacoes. Validação aqui é a primeira barreira; o
 * WordPress valida de novo (nunca confia no MCP para regra de negócio).
 */

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;

export const MODALITIES = [
  'Pregão - Eletrônico',
  'Dispensa de Licitação',
  'Concorrência - Eletrônica',
  'Pregão - Presencial',
  'Inexigibilidade',
  'Concurso',
  'Concorrência - Presencial',
  'Credenciamento',
  'Leilão - Presencial',
  'Leilão - Eletrônico',
] as const;

export const SearchInput = z
  .object({
    query: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Palavras-chave do produto/serviço (ex.: "pneu caminhão"). Palavras no mesmo trecho são todas obrigatórias; separe ALTERNATIVAS por vírgula (ex.: "pneu, câmara de ar, recapagem"). Use termos curtos como aparecem em editais, sem frases longas. A busca já considera singular/plural e procura também nos itens. Vazio = licitações mais próximas do prazo.',
      ),
    ufs: z
      .array(z.enum(UFS))
      .max(27)
      .optional()
      .describe('Siglas dos estados, ex.: ["SP", "MG"]. Omitir = Brasil inteiro.'),
    cities: z
      .array(z.string().min(2).max(120))
      .max(20)
      .optional()
      .describe('Municípios, ex.: ["Campinas"]. Pode usar "Cidade/UF". Combine com ufs quando souber o estado.'),
    status: z
      .enum(['open', 'closed', 'any'])
      .optional()
      .describe('open (padrão) = prazo de propostas de hoje em diante; closed = já encerradas nos últimos meses; any = ambos.'),
    modalities: z
      .array(z.enum(MODALITIES))
      .max(10)
      .optional()
      .describe('Filtra por modalidade. Omitir = todas.'),
    min_deadline_days: z
      .number()
      .int()
      .min(0)
      .max(730)
      .optional()
      .describe('Prazo de propostas daqui a pelo menos N dias (ex.: 3 para ter tempo de preparar a proposta).'),
    max_deadline_days: z
      .number()
      .int()
      .min(0)
      .max(730)
      .optional()
      .describe('Prazo de propostas em no máximo N dias (ex.: 7 = próxima semana).'),
    min_estimated_value: z.number().min(0).max(1e13).optional().describe('Valor estimado mínimo em reais.'),
    max_estimated_value: z.number().min(0).max(1e13).optional().describe('Valor estimado máximo em reais.'),
    organization: z
      .string()
      .max(120)
      .optional()
      .describe('Parte do nome do órgão comprador, ex.: "Secretaria de Saúde" ou "Prefeitura de Campinas". A busca por palavra-chave não olha o nome do órgão; use este campo para isso.'),
    exclude_terms: z
      .string()
      .max(200)
      .optional()
      .describe('Termos para EXCLUIR, separados por vírgula (ex.: "locação, manutenção").'),
    search_items: z
      .boolean()
      .optional()
      .describe('true (padrão) procura no objeto e nos itens do edital; false só no objeto.'),
    sort: z
      .enum(['deadline_asc', 'deadline_desc', 'value_desc', 'value_asc'])
      .optional()
      .describe('Ordenação: deadline_asc (padrão, prazos mais próximos primeiro), deadline_desc, value_desc ou value_asc. Com várias palavras-chave o motor pode misturar a ordem por relevância.'),
    limit: z.number().int().min(1).max(50).optional().describe('Resultados por página (1 a 50, padrão 20).'),
    cursor: z
      .string()
      .max(4096)
      .optional()
      .describe('Para a PRÓXIMA PÁGINA: envie só o next_cursor da resposta anterior (os demais filtros são ignorados).'),
  });

export type SearchInputType = z.infer<typeof SearchInput>;

const TenderSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    object: z.string(),
    organization: z.string().nullable(),
    city: z.string().nullable(),
    uf: z.string().nullable(),
    portal: z.string().nullable(),
    modality: z.string().nullable(),
    deadline: z.string().nullable(),
    days_until_deadline: z.number().nullable(),
    status: z.string(),
    estimated_value: z.number().nullable(),
    deserted_risk: z.boolean(),
    collected_at: z.string().nullable(),
    url: z.string().nullable(),
    licitante_prime_url: z.string().nullable(),
  })
  .passthrough();

export const SearchOutput = z
  .object({
    total: z.number(),
    returned: z.number(),
    page: z.number(),
    limit: z.number(),
    results: z.array(TenderSummary),
    next_cursor: z.string().nullable(),
    applied_filters: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    meta: z.record(z.string(), z.unknown()),
  })
  .passthrough();
