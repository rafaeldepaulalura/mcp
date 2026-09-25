# Servidor MCP — Licitante Prime AI

Node 22 + TypeScript + SDK oficial MCP v2 (`@modelcontextprotocol/server`,
spec 2026-07-28, compatível com clientes que ainda usam `initialize`).
Guia completo: [../README.md](../README.md).

```bash
cp .env.example .env      # preencha
npm ci
npm test                  # 43 testes (unidade + HTTP real com WordPress falso)
npm run build && npm start
```

## Estrutura
```
src/
  index.ts                  partida e desligamento limpo
  app.ts                    monta as peças (usado também pelos testes)
  server.ts                 HTTP: /mcp, /.well-known/*, /health, /ready, /metrics
  mcp.ts                    McpServer + instruções + handler sem sessão
  config.ts                 variáveis de ambiente (falha na partida se inseguro)
  auth/token-validator.ts   JWT EdDSA pela JWKS do WordPress
  auth/oauth.ts             metadata do recurso (RFC 9728) e desafios 401
  services/licitante-prime-api.ts  cliente da API lp-ai/v1
  schemas/                  zod: entradas e saídas das ferramentas
  tools/                    buscar_licitacoes, detalhes_licitacao, buscar_itens, meu_perfil
  utils/                    erros padronizados, log JSON com máscara, métricas, rate limit
```

## Segurança
- Token validado localmente (assinatura, `iss`, `aud` = este servidor, `exp`); o
  WordPress revalida conexão e assinatura em toda chamada.
- Nunca repassa o token do cliente para outro serviço além do WordPress emissor.
- `Host` e `Origin` validados; CORS só para origens listadas.
- Logs sem token, chave ou senha.
