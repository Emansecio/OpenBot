# OpenBot — Skills e MCP compartilhados no chat

> **Status:** aprovado pela solicitação explícita do usuário em 16/08/2026; execução autônoma, sem gates intermediários.
> **Objetivo:** cada bot pode descobrir e usar Skills e ferramentas MCP sozinho, enquanto o usuário também pode referenciar uma Skill pelo seletor `/` nativo do composer.

## Resultado esperado

- Um catálogo de Skills é carregado uma vez por processo a partir de raízes locais aprovadas, com metadados leves e conteúdo sob demanda.
- Todo bot recebe as ferramentas internas `search_skills` e `use_skill`; o modelo escolhe quando consultá-las sem exigir comando do usuário.
- `getAgentWorkflows` projeta as Skills habilitadas no contrato que a interface já usa. Digitar `/` mostra a lista nativa “Reference a skill” e insere o chip nativo no composer.
- Uma referência explícita enviada pelo composer é resolvida no servidor e a Skill é anexada ao contexto daquele turno de forma determinística.
- Servidores MCP são compartilhados por um único `McpManager`, mas as ferramentas projetadas para o modelo respeitam a política do bot.
- Chamadas MCP entram no mesmo loop, lifecycle, transcript e cartões de tool-call já usados pelas ferramentas locais.

## Arquitetura

### Catálogo de Skills

`SkillCatalog` recebe raízes aprovadas na inicialização. A precedência implementada é projeto `.agents`, projeto `.codex`, perfil `.agents`, perfil `.codex` e os agrupadores conhecidos `.codex/skills/.system` e `.codex/skills/public`. O scan de cada raiz lê apenas diretórios imediatos e o frontmatter de `SKILL.md`; colisões de `id` mantêm a origem de maior precedência.

Cada entrada pública contém somente `id`, `name`, `description` e `source`. Caminho absoluto e corpo Markdown não cruzam RPC. `read(id)` relê e valida o arquivo apenas quando a Skill for usada.

Validações obrigatórias: `lstat`/`realpath`, contenção na raiz canônica, rejeição de junction/symlink/reparse point no caminho, UTF-8 válido, tamanho máximo, número máximo de entradas, frontmatter estrito e IDs normalizados. A Skill é conteúdo não confiável: ela orienta o modelo, mas não amplia permissões, tools, filesystem ou rede.

### Descoberta autônoma

O prompt do bot recebe somente uma instrução curta explicando que Skills existem e que deve chamar `search_skills` quando uma tarefa puder se beneficiar delas. A lista completa não é injetada no prompt.

- `search_skills({query, limit?})`: busca determinística sobre nome/descrição e retorna metadados.
- `use_skill({id})`: retorna o Markdown validado e delimitado como instrução não confiável.

As duas operações passam por um executor de tools extensível no `runToolLoop`. Operações desconhecidas continuam falhando fechadas; ferramentas de filesystem/browser/process continuam obrigatoriamente no `LocalExecutionBroker`.

### Invocação explícita no chat

A UI existente trata Skills como `SandWorkflow`: `getAgentWorkflows({id})` retorna as Skills habilitadas para o bot com IDs `skill:<id>`. O nó Tiptap `workflowReference` preserva esse ID no `richText` e desenha o chip nativo.

Ao receber `sendPrompt`, o backend interpreta o `richText` como JSON Tiptap, percorre apenas nós `type: "workflowReference"`, valida `attrs.id` contra o catálogo/política do bot e inclui o conteúdo das Skills antes da mensagem do usuário. Texto comum que imita JSON ou `/skill` não ganha privilégios. Como fallback acessível, `/skill <id> <pedido>` no início do texto também é aceito e normalizado.

### MCP compartilhado

`McpManager` mantém no máximo uma conexão lazy por servidor configurado. O SDK oficial `@modelcontextprotocol/client` implementa Streamable HTTP e stdio. A conexão só nasce na primeira listagem/chamada e é encerrada no shutdown.

Configuração compartilhada:

- HTTP: `id`, `transport: "http"`, `url`, headers por referências de segredo.
- stdio: `id`, `transport: "stdio"`, executável, argumentos literais, cwd aprovado e ambiente por referências de segredo.
- política por bot: MCP habilitado, allowlist de servidores e denylist/allowlist de tools.

As tools chegam ao provider como `mcp__<serverId>__<toolName>`. O executor recupera o schema diretamente do servidor, revalida a política no instante da chamada e impõe timeout e limite de resultado.

Segurança: sem shell; sem comando concatenado; executável absoluto ou allowlist explícita; cwd contido; ambiente mínimo; HTTPS por padrão e HTTP apenas em loopback; hostname resolvido antes da conexão; bloqueio de metadata, link-local, multicast, loopback remoto e rede privada para endpoints não aprovados; redirects revalidados; segredos ficam na keystore e nunca aparecem em config, catálogo, transcript ou erro.

### Configuração e compatibilidade

`OpenBotConfig.version` permanece 1. Os novos campos raiz são opcionais e recebem defaults seguros na leitura:

- `mcpServers`: definições compartilhadas sem segredos;
- `LocalAgent.integrations`: overrides de Skills e MCP.

Configs antigas continuam válidas. Novas configurações são validadas integralmente antes da escrita atômica.

### Interface

- O seletor `/`, lista, busca por nome, navegação por teclado e chip são os componentes nativos já presentes.
- A listagem é por bot: itens desabilitados não aparecem.
- Chamadas autônomas e MCP usam os cartões/lifecycle de tools, com nomes legíveis. A invocação explícita permanece representada pelo chip nativo do composer.
- Status, refresh e configuração são expostos pelas RPCs locais; detalhes técnicos não poluem o composer.

## Falhas e limites

- Catálogo inválido não impede o chat: entradas defeituosas ficam omitidas e o status informa a quantidade rejeitada.
- Falha de um MCP não derruba outros servidores nem remove as Skills.
- Cancelamento aborta chamadas em curso e fecha um stdio travado quando necessário.
- Limites por turno, bytes e timeout protegem contexto e máquina.
- Não há VM nem processo permanente por bot. O runtime Node, catálogo e conexões MCP são compartilhados; workspace, navegador, transcript e políticas continuam por bot.

## Aceite

1. Bot encontra e usa uma Skill sem `/` em teste provider-driven.
2. Usuário digita `/`, escolhe uma Skill, vê o chip nativo e o turno recebe exatamente aquela Skill.
3. Dois bots com políticas diferentes não veem nem executam a Skill/MCP negado ao outro.
4. MCP HTTP e stdio listam e chamam uma tool via SDK oficial; cancelamento e timeout são comprovados.
5. Traversal, junction/symlink, arquivo grande/UTF-8 inválido, SSRF e comando shell são rejeitados.
6. Conteúdo/segredo/caminho absoluto não aparece no catálogo ou transcript fora do resultado necessário.
7. Testes focados, typecheck, suíte completa, build e E2E do composer ficam verdes.
