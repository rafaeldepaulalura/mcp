import { requireScopes, type McpServer } from '@modelcontextprotocol/server';
import { TenderDetailsInput, TenderDetailsOutput } from '../schemas/tender.schema.js';
import { READ_ONLY, runTool, type ToolDeps } from './shared.js';

export function registerTenderDetails(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'detalhes_licitacao',
    {
      title: 'Detalhes da licitação',
      description:
        'Traz os dados completos de UMA licitação do Licitante Prime: objeto inteiro, órgão e CNPJ do órgão, número do edital, modalidade, cidade/UF, ' +
        'prazo de propostas (deadline, ISO 8601 com fuso de Brasília), valor estimado, quantidade de itens, link oficial, link do edital e do sistema de disputa. ' +
        'Use quando o usuário pedir para abrir, detalhar ou ver mais sobre uma licitação já listada (ex.: "mostre a terceira", "abra a da Prefeitura X"). ' +
        'O id é o campo "id" retornado por buscar_licitacoes — não invente ids. Para a lista de itens use buscar_itens.',
      inputSchema: TenderDetailsInput,
      outputSchema: TenderDetailsOutput,
      annotations: { title: 'Detalhes da licitação', ...READ_ONLY },
      icons: deps.icons,
      scopeChallenge: requireScopes('lp.tenders.read'),
    },
    async ({ id }, ctx) => runTool('detalhes_licitacao', deps, ctx, (call) => deps.api.tender(call, String(id))),
  );
}
