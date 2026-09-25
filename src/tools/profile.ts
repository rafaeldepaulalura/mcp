import { requireScopes, type McpServer } from '@modelcontextprotocol/server';
import { ProfileOutput } from '../schemas/tender.schema.js';
import { READ_ONLY, runTool, type ToolDeps } from './shared.js';

export function registerProfile(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'meu_perfil',
    {
      title: 'Meu perfil no Licitante Prime',
      description:
        'Mostra a conta do Licitante Prime conectada: nome, plano, se a assinatura está ativa e o que a conexão permite (pesquisar, ver detalhes, ver itens). ' +
        'Use quando o usuário perguntar se está conectado, qual o plano, ou quando outra ferramenta devolver erro de acesso. Não traz dados sensíveis.',
      outputSchema: ProfileOutput,
      annotations: { title: 'Meu perfil', ...READ_ONLY },
      icons: deps.icons,
      scopeChallenge: requireScopes('lp.profile.read'),
    },
    async (ctx) => runTool('meu_perfil', deps, ctx, (call) => deps.api.profile(call)),
  );
}
