# Qualidade da execução autônoma — design

**Data:** 2026-08-18

## Objetivo

Fechar falhas reproduzíveis no loop autônomo sem trocar o runtime compartilhado: impedir efeitos duplicados, manter um contexto longo limitado porém coerente, respeitar Skills manuais, validar resultados de tools e sempre encerrar o turno com uma explicação honesta.

## Fluxo preservado

`sendPrompt → fila por agentId → contexto limitado → provider → tool loop → broker/aprovação → backend → tool result → provider → SQLite/SSE`.

As correções permanecem nessas fronteiras:

- `src/execution/broker.ts`: idempotência por `(agentId, requestId)` e validação do resultado resolvido;
- `src/execution/tool-loop.ts`: identidade semântica de chamadas e bloqueio de repetição consecutiva;
- `src/rpc/send.ts` + stores: âncora da tarefa original, corte em fronteira de usuário e notices terminais;
- `src/skills/dispatcher.ts`: `auto-select:false` não pode ser carregada pelo modelo;
- testes de integração: cadeia Skill/tool/resposta, browser+arquivo+resposta e dois bots concorrentes.

## Decisões

### Chamadas duplicadas

O ID fornecido pelo provider continua sendo usado para correlação de protocolo e cards. Uma fingerprint separada, baseada em nome e argumentos JSON canonicalizados, identifica a ação.

- mesma ação duplicada na mesma resposta: executar uma vez e reutilizar o resultado para todos os IDs;
- mesma ação repetida na rodada imediatamente seguinte: não executar; devolver ao modelo um resultado explícito pedindo que use o resultado anterior e conclua;
- repetição após esse aviso: encerrar com erro de validação claro;
- uma ação igual após uma rodada diferente continua permitida, evitando bloquear leituras legítimas após mudança de estado.

O broker também reutiliza execução em voo ou resultado concluído para o mesmo `(agentId, requestId)` e mesmo payload. Colisão com payload diferente falha fechada. O cache é limitado e limpo no fechamento.

### Contexto longo

O request ao provider continua limitado a 80 mensagens. Quando o histórico exceder o limite:

- preservar a primeira mensagem do usuário como âncora da tarefa original;
- usar o restante do orçamento para o tail recente;
- nunca começar o tail por uma resposta `assistant` órfã;
- não fazer uma chamada adicional de modelo para resumização.

Limite honesto: isso preserva a tarefa inicial, não todas as instruções intermediárias antigas.

### Falhas e respostas vazias

- limite interno de tool calls/rodadas gera notice persistido e sanitizado;
- provider que conclui sem texto nem tool call gera notice de resposta vazia;
- resultado inválido de backend/executor vira falha de tool, não `TypeError` nem sucesso fictício;
- cancelamento cooperativo continua abortando backends; efeito já commitado permanece registrado como concluído.

### Skills

`auto-select:false` significa manual-only. A referência explícita (`workflowReference` ou `/skill`) continua sendo resolvida por `resolveTurnContext`; `use_skill`, que é uma chamada do modelo, deve recusá-la.

## Validação

1. Testes RED individuais para cada falha confirmada.
2. GREEN focado para broker, tool loop, contexto, Skills e notices.
3. Integração determinística com provider/MCP/browser simulados e homes temporárias.
4. E2E multi-bot concorrente com IDs de tool iguais e arquivos de mesmo nome em homes distintas.
5. Typecheck, build, suíte serial, smoke isolado, browser/desktop gates aplicáveis e inspeção de cleanup.
6. Gate live de provider local apenas se LM Studio/Ollama estiver disponível; ausência será reportada como `SKIP`, nunca como sucesso.
