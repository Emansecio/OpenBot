# Bot Isolation Hardening Design

**Status:** aprovado pelo pedido de implementação de 17/08/2026.

## Objetivo

Fechar o bypass de quota do modo Developer, reduzir segredos herdados pelo host de navegador, permitir sessões MCP stateful separadas por bot e documentar com precisão as fronteiras de confiança do OpenBot. A solução deve preservar o runtime WSL2 compartilhado e os componentes lazy existentes.

## Decisões

### Quota do `process.run`

O workspace NTFS continua montado gravável no sandbox. O backend mede a quota antes de adquirir o lease, monitora o uso durante a execução e mede novamente ao terminar. Exceder bytes, arquivos ou entradas aborta a execução, libera o cgroup e retorna `quota_exceeded`. Falha ao inventariar o workspace também falha fechada como indisponibilidade do runtime.

Essa guarda impede que `process.run` ignore silenciosamente a quota das ferramentas estruturadas. Ela não é uma quota transacional do filesystem: NTFS/DrvFs não fornece quota atômica por diretório para bots executados sob a mesma conta. As escritas produzidas antes do encerramento não são revertidas automaticamente.

Alternativas rejeitadas:

- workspace somente leitura: quebraria builds e testes que geram artefatos;
- imagem/VHD por bot: adicionaria custo persistente e complexidade fora do desenho leve;
- overlay com commit completo: tornaria cada comando caro e exigiria uma nova camada de merge/rollback.

### Ambiente do browser host

O launcher deixa de copiar `process.env`. Ele monta uma allowlist de variáveis operacionais do sistema e acrescenta somente os valores `OPENBOT_BROWSER_*` necessários ao protocolo autenticado. Variáveis de provider, tokens e segredos arbitrários não chegam ao processo Electron auxiliar.

### Escopo de sessão MCP

Cada servidor aceita `sessionScope: "shared" | "agent"`.

- omitido ou `shared`: mantém uma conexão e cache de metadados compartilhados;
- `agent`: mantém conexão e cache separados por `serverId + agentId` e encerra os recursos quando o bot é removido.

Políticas de tools continuam reavaliadas por bot. Trocar/remover um servidor invalida todas as sessões e caches dos dois escopos. A RPC expõe apenas o valor do escopo, nunca segredos.

### Documento de segurança

`SECURITY.md` será a fonte curta e operacional para:

- modelo de ameaça pessoal/local;
- fronteiras reais de filesystem, runtime, browser, MCP, Skills e credenciais;
- componentes compartilhados;
- garantias fail-closed e riscos residuais;
- escolha segura de `sessionScope`;
- comandos de verificação e canal para relato local.

O README apontará para esse documento.

## Critérios de aceite

1. `process.run` não inicia acima da quota e é interrompido quando cruza a quota durante o lease.
2. O browser host recebe variáveis operacionais e `OPENBOT_BROWSER_*`, mas não recebe chaves/tokens arbitrários do pai.
3. Dois bots em servidor MCP `agent` criam sessões diferentes; em `shared`, reutilizam uma sessão.
4. Remoção do bot fecha apenas os recursos MCP pertencentes a ele.
5. Configuração e RPC validam/persistem o novo escopo sem expor segredos.
6. `SECURITY.md` é descoberto pelo README e não exagera garantias.
7. Testes focados, typecheck, build, suíte serial e smokes relevantes ficam verdes.
