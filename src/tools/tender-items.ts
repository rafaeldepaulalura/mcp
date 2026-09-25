import { requireScopes, type McpServer } from '@modelcontextprotocol/server';
import { TenderItemsInput, TenderItemsOutput } from '../schemas/tender.schema.js';
import { READ_ONLY, runTool, type ToolDeps } from './shared.js';

export function registerTenderItems(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'buscar_itens',
    {
      title: 'Itens da licitação',
      description:
        'Lista os itens de uma licitação do Licitante Prime: número do item, descrição, quantidade, unidade, valor unitário estimado e valor total estimado. ' +
        'Use quando o usuário perguntar "quais os itens?", "o que estão comprando?", quantidades ou valores por item de uma licitação já listada. ' +
        'tender_id é o campo "id" de buscar_licitacoes. Editais grandes vêm paginados: se next_page não for null, chame de novo com page = next_page. ' +
        'Valores null significam não informados. Algumas fontes publicam os itens com atraso: total 0 pode significar itens ainda não disponíveis.',
      inputSchema: TenderItemsInput,
      outputSchema: TenderItemsOutput,
      annotations: { title: 'Itens da licitação', ...READ_ONLY },
      icons: deps.icons,
      scopeChallenge: requireScopes('lp.items.read'),
    },
    async ({ tender_id, page, limit }, ctx) =>
      runTool('buscar_itens', deps, ctx, (call) => deps.api.items(call, String(tender_id), page ?? 1, limit ?? 50)),
  );
}
