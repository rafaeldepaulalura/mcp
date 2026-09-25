import { z } from 'zod';

/** Aceita "184523" ou 184523: alguns clientes mandam o id como número. */
const TenderId = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,18}$/, 'Use o "id" numérico retornado por buscar_licitacoes.'),
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ])
  .describe('O campo "id" de um resultado de buscar_licitacoes (ex.: "184523").');

export const TenderDetailsInput = z.object({ id: TenderId });

export const TenderItemsInput = z
  .object({
    tender_id: TenderId,
    page: z.number().int().min(1).max(1000).optional().describe('Página de itens (padrão 1). Use next_page da resposta anterior.'),
    limit: z.number().int().min(1).max(100).optional().describe('Itens por página (1 a 100, padrão 50).'),
  });

export const TenderDetailsOutput = z
  .object({
    id: z.string(),
    title: z.string(),
    object: z.string(),
    organization: z.string().nullable(),
    organization_cnpj: z.string().nullable(),
    number: z.string().nullable(),
    city: z.string().nullable(),
    uf: z.string().nullable(),
    portal: z.string().nullable(),
    modality: z.string().nullable(),
    deadline: z.string().nullable(),
    days_until_deadline: z.number().nullable(),
    status: z.string(),
    estimated_value: z.number().nullable(),
    items_count: z.number(),
    url: z.string().nullable(),
    edital_url: z.string().nullable(),
    licitante_prime_url: z.string().nullable(),
  })
  .passthrough();

export const TenderItemsOutput = z
  .object({
    tender_id: z.string(),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    returned: z.number(),
    next_page: z.number().nullable(),
    items: z.array(
      z
        .object({
          item_number: z.string().nullable(),
          description: z.string(),
          quantity: z.number().nullable(),
          unit: z.string().nullable(),
          estimated_unit_value: z.number().nullable(),
          estimated_total_value: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const ProfileOutput = z
  .object({
    user_id: z.number(),
    name: z.string().nullable(),
    plan: z.string().nullable(),
    active: z.boolean(),
    status: z.string(),
    permissions: z.object({ search: z.boolean(), tender_details: z.boolean(), items: z.boolean() }).passthrough(),
  })
  .passthrough();
