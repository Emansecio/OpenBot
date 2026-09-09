# Auditoria estrutural semântica do OpenBot

**Data:** 18/08/2026  
**Modo:** somente leitura do código de produção; nenhum comportamento foi alterado.  
**Escopo:** system prompt, contexto, Skills, MCP, contratos de ferramentas e fluxo visual do navegador.  
**Status atual:** **GREEN estrutural após remediação** — as sete lacunas confirmadas foram corrigidas e os gates determinísticos estão verdes. A qualidade de decisão de um LLM real continua não avaliada.

## Resumo

Os gates atuais comprovam sequência de tool calls, isolamento, idempotência, cancelamento e persistência. Eles não comprovam que um modelo real recebe informação suficiente e segura para decidir corretamente. A inspeção encontrou sete lacunas confirmadas e uma limitação parcial.

## Achados confirmados

### P2 — A imagem do navegador não chega ao modelo como conteúdo visual

**Evidência:**

- `src/browser/protocol.ts:52-64` representa a captura como PNG em `dataBase64`.
- `src/providers/router.ts:41-53` aceita somente `content: string`; não existe parte multimodal de imagem.
- `src/execution/tool-loop.ts:51` serializa o resultado inteiro com `JSON.stringify`.
- `test/autonomous-execution.integration.test.ts:49-54` usa screenshot com `dataBase64: ""`; o cenário chamado visual comprova apenas o texto `VISUAL-42`.
- `scripts/openbot-browser-host.cjs:958-967` entrega somente `document.body.innerText`, sem árvore de acessibilidade, IDs ou coordenadas de elementos.

**Impacto:** o modelo não enxerga pixels. Em páginas dependentes de layout, canvas, imagem, ícones ou controles sem texto, ele não consegue interpretar a tela nem escolher coordenadas com fundamento. O teste E2E atual comprova browser + texto extraído, não visão multimodal.

**Correção recomendada:** criar um contrato multimodal real nos adapters compatíveis ou fornecer snapshot semântico com elementos acionáveis, bounding boxes e IDs estáveis. Manter fallback textual explícito para providers sem visão e adicionar E2E com informação presente apenas nos pixels.

### P2 — Resultados grandes são truncados em JSON inválido

**Evidência:**

- `src/execution/tool-loop.ts:65-70` corta qualquer string por prefixo e acrescenta um marcador textual.
- `src/execution/tool-loop.ts:190-198` aplica esse corte ao conteúdo entregue ao provider.
- Reprodução local sobre o build atual: entrada de `132159` bytes virou `131072` bytes, `validJson:false`, `tailPreserved:false` e marcador presente.
- Screenshots são incorporados como base64 ao mesmo JSON, aumentando diretamente a chance de cruzar o teto de 128 KiB.

**Impacto:** o modelo pode receber objeto incompleto, perder campos posteriores e não distinguir de forma estruturada o resultado original. Capturas maiores também podem consumir todo o orçamento da rodada e esvaziar resultados seguintes.

**Correção recomendada:** serializar resultados por operação. Remover binários do JSON textual, preservar um envelope JSON válido com `truncated:true`, reservar orçamento por chamada e transportar imagens fora do texto.

### P2 — Conteúdo externo não possui uma fronteira uniforme contra instruções embutidas

**Evidência:**

- `src/main.ts:468-469` declara como não confiáveis somente o corpo de Skills e a saída MCP.
- `src/rpc/attachments.ts:165-175` e `src/rpc/send.ts:1072-1075` inserem texto de documentos diretamente na mensagem do usuário.
- `scripts/openbot-browser-host.cjs:958-967` extrai texto bruto de páginas e ele retorna como tool result.
- `src/mcp/manager.ts:779-784` copia descrições fornecidas pelo servidor MCP diretamente para o schema exposto ao modelo.
- `src/config/store.ts:135` usa `localToolPermission: "always"` como default, permitindo efeitos dentro das fronteiras já autorizadas sem nova confirmação.

**Impacto:** documentos, páginas ou metadados MCP podem conter frases imperativas e disputar a atenção do modelo com a tarefa real. As permissões técnicas continuam limitadas, mas ações autorizadas de browser, workspace ou MCP podem ser desviadas por conteúdo não confiável.

**Correção recomendada:** declarar no system prompt que páginas, anexos, arquivos, resultados e metadados de tools são dados, nunca autoridade. Envelopar cada origem com proveniência inequívoca e exigir que mudanças de objetivo vindas dessas fontes sejam ignoradas ou confirmadas pelo usuário.

### P2 — O limite de contexto usa quantidade de mensagens, não orçamento do modelo

**Evidência:**

- `src/rpc/send.ts:363` e `src/rpc/send.ts:1105-1115` limitam o histórico a 80 mensagens.
- `src/rpc/send.ts:1355-1361` valida apenas que o prompt não esteja vazio; não há teto de bytes ou tokens.
- `src/rpc/attachments.ts:5-8` permite até 4 MiB agregados de anexos extraídos.
- `src/config/models.ts` não registra janelas de contexto, e `contextWindow` de `src/shared/contracts.ts:353` não participa da montagem do request.

**Impacto:** 80 mensagens ou anexos dentro dos limites locais ainda podem exceder a janela do provider, provocar rejeição, custo desnecessário ou perda não controlada de contexto. O comportamento varia por modelo e endpoint OpenAI-compatible.

**Correção recomendada:** definir orçamento por provider/modelo, contabilizar system prompt + schemas + histórico + anexos + reserva de saída e aplicar truncamento/sumarização determinísticos por fronteira de turno.

### P3 — A busca automática de Skills é literal e perde pedidos naturais

**Evidência:**

- `src/skills/dispatcher.ts:18-24` descreve busca por tarefa, nome ou descrição.
- `src/skills/catalog.ts:616-625` usa um único `includes(normalizedQuery)` sobre ID, nome e descrição; não tokeniza nem ranqueia.
- Reprodução no catálogo real: `project audit` encontrou `local-project-auditor`, enquanto `audit this local project for real bugs` não encontrou a mesma Skill.
- `test/autonomous-execution.integration.test.ts:94-99` usa apenas a palavra exata `research`.

**Impacto:** a seleção autônoma depende de o modelo adivinhar uma substring contígua presente no catálogo. Pedidos naturais completos podem retornar lista vazia mesmo com Skill adequada instalada.

**Correção recomendada:** tokenizar a consulta, considerar ID/nome/descrição/triggers com pesos, ranquear deterministicamente e orientar o modelo a usar poucas palavras-chave. Adicionar casos naturais e sinônimos aos testes.

### P3 — O contrato de interação do navegador não cobre páginas comuns por completo

**Evidência:**

- `src/browser/protocol.ts:12-31` oferece open, navigate, snapshot, click por coordenadas, type no foco, upload, screenshot, close e handoff.
- Não existem scroll, tecla/atalho, seleção, foco por alvo ou ação por elemento.
- `scripts/openbot-browser-host.cjs:437-459` confirma click somente por coordenadas e digitação somente no elemento já focado.

**Impacto:** o bot não consegue operar de forma determinística controles fora do viewport, enviar Enter/Tab/Escape, escolher opções ou localizar elementos sem conhecer coordenadas. Isso reduz a navegação prática mesmo após resolver o transporte visual.

**Correção recomendada:** adicionar snapshot de elementos acionáveis e operações limitadas `click_element`, `scroll`, `press_key` e `select`, todas validadas no host.

### P3 — O system prompt afirma privacidade/localidade além do que a arquitetura garante

**Evidência:**

- `src/rpc/identity.ts:5-8` afirma que o assistente roda “entirely on the user's machine”.
- `src/config/models.ts` usa xAI como default e também oferece OpenAI; mensagens são enviadas aos respectivos endpoints pelos adapters.

**Impacto:** o próprio assistente pode informar incorretamente que os dados nunca saem da máquina, apesar de o runtime local poder usar um provider remoto.

**Correção recomendada:** dizer que o aplicativo, workspaces e ferramentas são locais, enquanto o conteúdo enviado ao modelo segue o provider configurado.

## Parcial / requer decisão de produto

### Âncora permanente da primeira mensagem

`src/rpc/send.ts:1101-1115` reinsere a primeira mensagem do histórico quando ela sair do tail. Isso protege uma instrução inicial importante, mas também pode reinjetar indefinidamente uma tarefa antiga em conversas reutilizadas. Os testes atuais codificam o primeiro caso; falta uma noção explícita de instruções fixadas versus fronteira de nova tarefa. A correção apropriada é separar perfil/instruções persistentes de tarefas conversacionais, não apenas remover a âncora.

## Áreas consideradas corretas no escopo

- Tool loop finito, deduplicação e idempotência possuem testes diretos.
- Skills respeitam política de invocação automática e seleção explícita.
- MCP usa nomes não ambíguos e políticas por bot.
- Falhas e limites geram resultados/notices em vez de sucesso fictício.
- Contexto de Skill é efêmero e não é persistido no transcript.
- Workspace, transcript e sessões permanecem correlacionados por `agentId`.

## Verificação

- Testes focados: **8 arquivos, 101 testes aprovados, 0 falhas**.
- `npm run typecheck`: **aprovado**.
- Reprodução de truncamento: confirmou JSON inválido após o teto.
- Reprodução de busca no catálogo real: confirmou perda de consulta natural.
- Nenhuma alteração de código foi realizada nesta auditoria.

## Risco residual

Mesmo após corrigir estes contratos, a qualidade de escolha de um LLM real continuará exigindo eval live. A revisão estática consegue provar se o modelo recebe contexto, ferramentas e fronteiras coerentes; não consegue provar julgamento semântico sobre pedidos variados.

## Remediação executada

As sete lacunas confirmadas foram corrigidas em ciclos RED → GREEN:

1. Capturas do browser agora são removidas do JSON textual e seguem como `image_url` multimodal para modelos explicitamente marcados com visão (`grok-4.5`, `gpt-4.1` e `gpt-4.1-mini`). Endpoints OpenAI-compatible desconhecidos permanecem no fallback textual seguro.
2. Resultados JSON grandes permanecem JSON válido, com envelope `openbotTruncated`, tamanho original e preview limitado.
3. O system prompt distingue app/workspaces locais de inferência no provider e trata páginas, anexos, arquivos, resultados, descrições e metadados de tools como dados não confiáveis. Anexos recebem delimitadores de proveniência.
4. Histórico textual e catálogo de schemas possuem limites conservadores separados de 256 KiB, preservando a solicitação atual e impedindo crescimento ilimitado.
5. A busca de Skills tokeniza, normaliza, considera triggers e ranqueia pedidos naturais de maneira determinística.
6. O browser retorna até 200 elementos acionáveis visíveis e ganhou `click_element`, `scroll` e `press_key`, todos limitados e validados no protocolo, backend e host Electron.
7. A identidade deixou de afirmar que a inferência ocorre inteiramente na máquina e informa corretamente a dependência do provider configurado.

## Evidência final após remediação

- typecheck: **GREEN**;
- build: **GREEN**;
- regressão semântica focada: **17 arquivos, 302 testes aprovados**;
- suíte integral serial final: **96/96 arquivos, 1.062 testes aprovados e 1 ignorado**;
- a primeira execução integral teve uma falha transitória `ENOENT` no cenário multibot; o arquivo passou **5/5** isolado e a segunda suíte integral completa ficou verde;
- Skills/MCP: **158/158**;
- core acceptance: **3/3**;
- browser Electron real e segurança: **17/17**;
- desktop Electron isolado: **GREEN**, com processos ausentes, portas livres e perfil temporário removido;
- gate visual: **GREEN**;
- imagem multimodal está comprovada no corpo OpenAI-like e no E2E determinístico; nenhum provider real estava ativo para uma inferência visual live.

## Arquivos centrais da remediação

- `src/rpc/identity.ts`, `src/rpc/attachments.ts`, `src/rpc/send.ts`;
- `src/skills/catalog.ts`, `src/skills/dispatcher.ts`;
- `src/integrations/shared-tools.ts`;
- `src/providers/router.ts`, `src/providers/tool-calls.ts`;
- `src/execution/tool-loop.ts`, `src/execution/home-tools.ts`, `src/execution/tool-request.ts`, `src/execution/contracts.ts`;
- `src/browser/protocol.ts`, `src/browser/execution-backend.ts`, `scripts/openbot-browser-host.cjs`;
- catálogo/contratos compartilhados e testes de regressão correspondentes.
