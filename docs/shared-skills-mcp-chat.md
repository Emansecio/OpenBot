# Skills e MCP compartilhados no chat

**Data:** 2026-08-16  
**Status:** implementado; Skills ativas por padrão e MCP fechado por padrão até configuração explícita.

## Resultado prático

Cada bot criado pelo usuário pode:

- descobrir sozinho uma Skill adequada com `search_skills` e carregar seu conteúdo sob demanda com `use_skill`;
- receber uma Skill escolhida pelo usuário ao digitar `/` no composer e selecionar o chip nativo **Reference a skill**;
- usar o fallback textual `/skill <id> <pedido>`;
- descobrir e chamar ferramentas MCP autorizadas no mesmo loop de tools do chat;
- manter política própria sem duplicar catálogo, runtime Node ou conexões MCP por bot.

O catálogo completo não entra no prompt. O modelo recebe somente duas ferramentas pequenas de descoberta/uso e uma instrução curta para procurar Skills quando a tarefa for especializada. O Markdown carregado é delimitado como conteúdo não confiável, vale somente naquele turno e não é persistido no transcript.

## Catálogo compartilhado

O boot procura `SKILL.md` nesta ordem; o primeiro ID repetido vence:

1. `<projeto>/.agents/skills`;
2. `<projeto>/.codex/skills`;
3. `%USERPROFILE%/.agents/skills`;
4. `%USERPROFILE%/.codex/skills`;
5. `%USERPROFILE%/.codex/skills/.system`;
6. `%USERPROFILE%/.codex/skills/public`.

Somente raízes locais existentes e seguras entram no catálogo. Paths não atravessam a RPC. A leitura rejeita symlink, junction/reparse point, troca do arquivo entre descoberta e leitura, UTF-8 inválido, frontmatter fora do contrato e arquivos acima dos limites. O limite padrão é 512 candidatas e 256 KiB por `SKILL.md`.

Skills ficam habilitadas para bots antigos e novos por compatibilidade. Um bot pode restringi-las:

```json
{
  "integrations": {
    "skills": {
      "enabled": true,
      "disabledIds": ["skill-nao-permitida"]
    }
  }
}
```

Metadados `disable-model-invocation`, `user-invocable` e `auto-select` somente restringem invocação; nunca concedem filesystem, processo, browser, rede ou MCP.

## Encaixe no chat

O renderer já possui o seletor nativo de workflows. `getAgentWorkflows({id})` agora projeta somente as Skills permitidas como IDs `skill:<id>`, sem corpo nem path. A seleção gera o nó Tiptap `workflowReference` e o chip nativo; o backend valida esse nó novamente contra catálogo e política antes de carregar a Skill.

Texto que apenas imita JSON/Tiptap não é interpretado como referência. A mensagem gravada no transcript permanece exatamente a mensagem do usuário, sem copiar o corpo da Skill. No fallback textual, apenas uma resolução confirmada como `text-command` remove `/skill <id>` do prompt enviado ao provider; chip/referência e contexto legado nunca causam essa normalização.

## MCP compartilhado

Existe um único `McpManager` lazy por processo. Ele usa o cliente TypeScript oficial do MCP para transportes Streamable HTTP e stdio. As ferramentas chegam ao provider com nome não ambíguo `mcp__<server>__<tool>` e passam por política do bot em toda listagem e chamada.

O default é deny-all:

```json
{
  "integrations": {
    "mcp": {
      "enabled": true,
      "serverAllowlist": ["meu-servidor"],
      "toolAllowlist": ["meu-servidor/minha-tool"],
      "toolDenylist": []
    }
  }
}
```

Servidor HTTP compartilhado:

```json
{
  "id": "meu-servidor",
  "transport": "http",
  "url": "https://mcp.exemplo.com/mcp",
  "headers": {
    "Authorization": { "secretRef": "mcp/meu-servidor/token" }
  },
  "timeoutMs": 30000,
  "maxResultBytes": 1048576
}
```

Servidor stdio compartilhado:

```json
{
  "id": "local",
  "transport": "stdio",
  "command": "node",
  "args": ["server.mjs"],
  "cwd": "%APPDATA%\\OpenBot\\mcp\\local",
  "env": {
    "TOKEN": { "secretRef": "mcp/local/token" }
  }
}
```

Configuração e segredos passam pelas RPCs `upsertMcpServer`, `setMcpSecret` e `setAgentIntegrationPolicy`. Status/descoberta usam `listMcpServers`, `listMcpTools` e `refreshMcp`. Segredos ficam no keystore e a configuração persiste somente `secretRef`; valores não voltam pela RPC, pelo transcript ou pelos cards.

## Limites de segurança

- MCP HTTP exige HTTPS, exceto loopback HTTP; bloqueia credenciais na URL, IPs privados/reservados, metadata cloud e redirects.
- O hostname é validado e o endereço aprovado é fixado no socket por dispatcher Undici dedicado; redirects são rejeitados e uma nova sessão exige nova validação. Isso fecha o intervalo de DNS rebinding entre resolução e conexão.
- MCP stdio não usa shell, recebe ambiente mínimo, aceita somente comando nomeado seguro ou caminho exato aprovado e usa o `cwd` real validado dentro da raiz MCP gerenciada.
- Timeout, abort, quantidade de servidores, `Content-Length`, stream de resposta e resultado final têm bounds; conexão tardia é fechada e falha de um servidor não remove Skills nem derruba os demais servidores ou o chat.
- Policies são reavaliadas por bot em cada turno. Deny sempre vence allow.
- Servidores stateful podem usar `sessionScope: "agent"`, separando conexão e cache por bot e fechando-os na remoção do agente. Campo omitido ou `shared` preserva uma sessão lazy compartilhada para servidores stateless.

Limite residual: Node recebe `cwd` do subprocesso como path, não como handle. O manager canonicaliza novamente imediatamente antes do spawn e usa somente o segundo path real dentro da raiz gerenciada, mas permanece uma janela teórica entre essa segunda verificação e a syscall. Não há bypass prático comprovado nos testes; eliminar inteiramente essa janela exigiria um launcher nativo que aceite handle de diretório.

## Peso e isolamento

A criação de um bot continua leve. Ela grava configuração/home/políticas e, sob demanda, uma partição de browser. Não cria VM, distro WSL, catálogo de Skills, host Electron, processo MCP ou runtime Node dedicado. Esses componentes são compartilhados e lazy; transcript, workspace, browser e autorizações continuam separados por bot. `sessionScope: "agent"` cria apenas a sessão MCP necessária quando aquele bot usa o servidor; não cria infraestrutura permanente por bot.

## Evidência automatizada

- catálogo, precedence e hardening de paths;
- uso autônomo e explícito, política por bot e parser Tiptap;
- projeção no `getAgentWorkflows` nativo sem corpo/path;
- manager MCP HTTP/stdio, política, timeout, abort, limites e cleanup;
- transportes reais MCP Streamable HTTP e stdio com cliente e servidor do SDK oficial;
- DNS pinado, limite pré-parse do stream HTTP, ambiente mínimo stdio, rollback de configuração e isolamento de falha por servidor;
- RPC de configuração/segredo sem vazamento;
- bootstrap completo com provider fake comprovando ferramentas disponíveis, Skill delimitada no request e transcript limpo;
- gate Electron/CDP real: `/` abriu `sand-workflow-listbox`, a seleção virou `sand-workflow-chip`, o contexto chegou ao backend e exatamente uma resposta apareceu no painel principal; renderer terminou ocioso e sem erros de console/runtime;
- suíte completa, typecheck, build e smoke local verdes no fechamento de 2026-08-16.

Resultado acumulado após o polimento: `765` testes na suíte completa (`1` skipped), além dos gates focados de Skills/MCP; typecheck e build verdes.

No perfil real do usuário, o catálogo encontrou 105 Skills válidas nas raízes compartilhadas em aproximadamente 228 ms no primeiro scan medido. Esse custo ocorre por catálogo compartilhado, não a cada bot. O estado real continua com zero bots; há uma definição MCP compartilhada configurada e, coerentemente com o default seguro, nenhum bot habilitado enquanto o roster estiver vazio.

## Auditoria de dependências

O Electron foi atualizado para `41.10.5`, substituindo a cadeia vulnerável de `extract-zip` por `@electron-internal/extract-zip`. `npm audit --omit=dev` encerrou com zero vulnerabilidades.

Evidência visual final preservada em `logs/e2e-desktop/run-20260816-010416-17344/`: `cdp-report.json`, `skill-menu.png`, `skill-chip.png` e `skill.png`. O runner terminou `GREEN`, comprovou exatamente uma resposta final, removeu a raiz temporária e confirmou processos e portas ausentes.

Design e plano executado:

- [`superpowers/specs/2026-08-16-shared-skills-mcp-chat-design.md`](superpowers/specs/2026-08-16-shared-skills-mcp-chat-design.md)
- [`superpowers/plans/2026-08-16-shared-skills-mcp-chat-plan.md`](superpowers/plans/2026-08-16-shared-skills-mcp-chat-plan.md)
