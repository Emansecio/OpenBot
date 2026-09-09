# Auditoria de segurança end-to-end das ações autônomas

**Data:** 18/08/2026  
**Modo:** auditoria interna passiva; leitura de código, testes existentes, mocks e reproduções em memória.  
**Escopo:** prompt/tool chain, MCP, isolamento entre bots, browser egress, uploads/downloads, gateway/IPC, segredos e DoS.  
**Status:** **YELLOW** — quatro achados Medium confirmados, um Low e quatro riscos parciais. Nenhum Critical/High confirmado.

## Gate 0 e ameaça considerada

- autorização: solicitação explícita do proprietário do projeto;
- ativos: `C:\SuperAgent\openbot` e estado local do OpenBot;
- técnicas: inspeção passiva, testes/mocks locais, leitura de ACL e reproduções sem rede;
- fora do escopo: rede externa, OOB, dados reais, brute force, DoS ativo, evasão ou modificação do código;
- atacantes considerados: página pública maliciosa aberta pelo bot, documento malicioso processado pelo modelo, servidor MCP comprometido/configurado e processo local sem o token do gateway;
- ativos protegidos: chaves de provider/MCP, workspaces, transcripts, cookies do browser, isolamento entre bots e disponibilidade local.

## Estado real observado

- perfil atual: `localToolPermission: "ask"`;
- bots configurados: `0`;
- servidores MCP configurados: `0`;
- ACL de `%APPDATA%\OpenBot` e `%LOCALAPPDATA%\OpenBot`: herança removida; acesso explícito somente ao usuário atual, SYSTEM e Administradores;
- nenhum literal com formato plausível de API key foi encontrado em `src`, `scripts`, `test` ou `docs` fora dos artefatos/bundles excluídos.

Isso significa que os riscos de MCP abaixo não estão ativos no perfil atual. Eles passam a importar quando o usuário criar bots e habilitar servidores.

## Achados confirmados

### MEDIUM-1 — Segredos usados em browser/processo são persistidos no resumo da tool

**Localização:** `src/execution/tool-card.ts:32-54`, chamado por `src/execution/tool-loop.ts:201,254` e `src/rpc/send.ts:1176`.  
**Categoria:** Information Disclosure / ASI08.  
**Explorabilidade:** modelo/provider ou conteúdo indireto que leve o modelo a chamar uma tool com valor sensível.  
**Impacto:** credenciais digitadas, URLs de recuperação e valores de `env`/`stdin` ficam em claro no card `tool-call`, no transcript SQLite, SSE e backups.

**Reprodução:**

- `browser_type({text:"PASSWORD_SUPERSECRET_42"})` produziu summary com o valor completo;
- `browser_navigate` preservou `?token=RESET_SECRET_99`;
- `process_run` preservou `API_KEY` e `stdin`;
- uma reprodução pelo `TurnRunner` confirmou `persistedSecret:true` no card armazenado.

**Causa:** somente `file`, buscas, Skills e MCP têm resumos específicos. As demais tools caem em `sanitizeToolSummary(rawArgs)`, que normaliza caracteres e tamanho, mas não remove valores sensíveis.

**Correção recomendada:** resumos por tool com allowlist de campos não sensíveis; `browser_type` deve indicar apenas quantidade de caracteres, navegação deve remover query/fragment e `process_run` deve mostrar somente executável/cwd, nunca `env` ou `stdin`. Adicionar redator genérico como segunda defesa.

### MEDIUM-2 — Autorizar um servidor MCP libera implicitamente todas as tools atuais e futuras

**Localização:** `src/mcp/manager.ts:489-496,760-789,856-895`.  
**Categoria:** Elevation of Privilege / MCP01 / ASI04.  
**Explorabilidade:** servidor MCP configurado que seja atualizado ou comprometido após o usuário permitir o servidor.  
**Impacto:** uma nova tool sensível passa a ser exposta ao modelo sem alteração de política quando `toolAllowlist` foi omitida.

**Reprodução:** com policy `{enabled:true, serverAllowlist:["demo"]}`, o catálogo retornou tanto `read_public` quanto uma tool adicionada posteriormente chamada `new_dangerous_write`.

**Agravante:** `src/integrations/shared-tools.ts:175-191` chama MCP diretamente. A preferência `localToolPermission: "ask"` protege o broker local, não cria confirmação para MCP.

**Correção recomendada:** `toolAllowlist` ausente deve significar deny-all, não wildcard. Wildcard deve ser explícito. Persistir digest/versionamento do catálogo e exigir aprovação quando nome/schema/descrição mudar; oferecer aprovação por risco para tools MCP com efeitos colaterais.

### MEDIUM-3 — Sessão MCP compartilhada por default pode transportar estado entre bots

**Localização:** `src/mcp/contracts.ts:19-42`, `src/mcp/manager.ts:214-217,560-587`.  
**Categoria:** Information Disclosure / ASI07.  
**Explorabilidade:** servidor stateful configurado sem `sessionScope:"agent"`.  
**Impacto:** dados ou estado da chamada do bot A podem aparecer na resposta recebida pelo bot B.

**Reprodução:** um servidor fake stateful recebeu `BOT_A_SECRET`; a chamada seguinte do bot B retornou esse valor. A telemetria da reprodução mostrou `connections:1`, confirmando o reuso da sessão.

**Correção recomendada:** usar `sessionScope:"agent"` como default seguro. Exigir `shared` explícito apenas para servidores declaradamente stateless e avisar na interface que o servidor verá chamadas de vários bots.

### MEDIUM-4 — Instalação nova executa tools locais automaticamente por default

**Localização:** `src/config/store.ts:130-136`, `src/main.ts:385-391`, `src/execution/broker.ts:208-246`.  
**Categoria:** Tampering / ASI01, ASI02 e ASI09.  
**Explorabilidade:** modelo que segue instrução indireta presente em página, anexo ou saída MCP.

**Impacto:** em instalação nova, uma tool de escrita/browser/processo pode executar sem confirmação humana. O system prompt marca conteúdo externo como não confiável, mas isso é uma instrução probabilística, não uma barreira de autorização.

**Reprodução controlada:** uma saída MCP fake continha instrução para escrever `Documents/proof.txt`; o provider scripted emitiu `file.write`; com a policy default `always`, o backend recebeu a escrita e o turno terminou como sucesso.

**Estado atual:** o perfil real está em `ask`, portanto o broker local pediria confirmação hoje. A falha permanece no default de novas instalações e MCP continua fora desse broker.

**Correção recomendada:** default `ask`; separar leitura, escrita, processo, browser e MCP; exigir aprovação para efeitos colaterais originados após conteúdo externo, com grants persistentes por bot/tool para não destruir a autonomia.

### LOW-1 — `/health` dispensa token e expõe atividade e identidade do bot ativo

**Localização:** `src/server/gateway.ts:399-401,427-436`.  
**Categoria:** Information Disclosure.  
**Explorabilidade:** processo local ou cliente que alcance loopback; browsers remotos não conseguem ler a resposta por CORS, mas a rota não aplica `tokenGuard`.

**Impacto:** revela PID, horário de boot, estado ocupado e `activeAgentId`. O impacto é local e limitado.

**Correção recomendada:** manter uma sonda mínima sem identidade (`ok`) ou exigir token para os campos detalhados usados pelo recovery/launcher.

## Parcial / requer validação adicional

### Browser sem limite agregado de conexões e downloads

`src/browser/egress-proxy.ts:245-247` só define `server.maxConnections` quando uma opção é fornecida; `BrowserSessionManager` não fornece default. Downloads têm teto de 1 MiB por arquivo em `scripts/openbot-browser-host.cjs:694-729`, mas não há contador agregado ou reserva da `WorkspaceQuota`. Uma página maliciosa pode tentar gerar muitas conexões/subrecursos ou downloads. A condição está provada; falta um E2E local que demonstre o volume efetivo permitido pelo Chromium antes de classificar o impacto.

### Markdown image zero-click

`client/extracted/dist/renderer/index.html:7` permite `img-src https:` e o bundle inclui `react-markdown`. Se mensagens do assistente renderizarem imagens Markdown sem override, uma resposta contaminada pode provocar request externo. O componente efetivo não foi provado por fonte ou E2E; não é achado confirmado.

### Descriptor local pode gravar o token em caminho amplo

`scripts/local-descriptor.mjs:6,21-38` usa `openbot-local-descriptor.json` no diretório atual quando nenhum destino é fornecido e inclui `SAND_HOST_GATEWAY_TOKEN`. O arquivo não existe no checkout nem nos data roots atuais e não faz parte do launcher normal. Tratar como risco de ferramenta auxiliar, não vazamento atual.

### MCP stdio executa código confiado com a identidade do usuário

O snapshot de executável, cwd validado e ambiente mínimo reduzem troca de binário e vazamento ambiental, mas não são sandbox. Um servidor Node configurado continua podendo usar permissões do usuário para filesystem/rede/processos. Isso é inerente a MCP stdio e deve ser apresentado como fronteira de confiança explícita, não como isolamento.

## Não-achados confirmados

- **Browser SSRF:** IPs loopback, privados, link-local, metadata, multicast e reservados são negados em IPv4/IPv6; DNS é validado e o socket conecta ao IP aprovado; redirects passam novamente pelo proxy.
- **MCP HTTP SSRF:** HTTPS é obrigatório fora de loopback; DNS privado/reservado é negado; lookup é pinado no dispatcher e redirects falham fechado.
- **Gateway remoto/CSRF:** produção liga somente em `127.0.0.1`, usa token aleatório persistido, valida Host/Origin e limita body a 1 MB, SSE a 32 clientes e backpressure a 256 KiB.
- **Uploads/path traversal:** upload do browser exige caminho relativo da home e revalida links/hardlinks; workspace rejeita drive, UNC, traversal e reparse points.
- **Segredos:** provider/MCP secrets usam keystore; RPCs retornam somente nomes/refs; nenhuma key literal foi encontrada; logs possuem redator e rotação.
- **ACL:** data roots reais estão protegidos e o gate live de ACL ficou verde.
- **Loops/DoS de tools:** 8 rodadas, 16 chamadas por rodada, resultado textual de 128 KiB, contexto/schemas limitados e filas por bot.

## Verificação

- `npm run typecheck`: GREEN;
- 15 arquivos de segurança: **215 aprovados, 1 ignorado, 0 falhas**;
- `npm run verify:acl:live`: **6/6 GREEN**;
- ACL real de Roaming/Local: protegida, sem ACE herdada ampla;
- scan de literais sensíveis: nenhum arquivo encontrado;
- reproduções em memória: vazamento de summary, wildcard MCP, estado cross-bot e cadeia MCP → escrita.

## Prioridade recomendada

1. redigir summaries sem valores sensíveis;
2. tornar tool allowlist e sessão MCP seguras por default, incluindo aprovação MCP;
3. trocar o default local para `ask` e introduzir grants por risco;
4. depois medir conexões/downloads e Markdown remoto em E2E isolado.

