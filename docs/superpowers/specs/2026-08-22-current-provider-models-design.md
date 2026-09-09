# OpenBot — catálogo atual de GPT-5.6 e Grok 4.6

**Data:** 2026-08-22  
**Status:** aprovado para implementação

## Objetivo

Substituir modelos obsoletos exibidos pelo OpenBot, fazer GPT-5.6 usar protocolo correto e remover integração específica com LM Studio/Ollama.

## Fonte canônica

`C:\Users\User\.pi\agent\models-store.json` confirma:

- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- Grok 4.6 (`x-ai/grok-4.6` no OpenRouter)

OpenBot usa xAI diretamente; portanto ID enviado à xAI será `grok-4.6`, sem prefixo OpenRouter `x-ai/`.

## Catálogo final

| ID | Provider | Exibição | Visão | Uso |
|---|---|---|---|---|
| `grok-4.6` | `xai` | Grok 4.6 | sim | padrão global |
| `gpt-5.6-luna` | `openai` | GPT-5.6 Luna | sim | selecionável |
| `gpt-5.6-sol` | `openai` | GPT-5.6 Sol | sim | fallback OpenAI e migração |
| `gpt-5.6-terra` | `openai` | GPT-5.6 Terra | sim | selecionável |
| `openai-compatible` | `openai-compat` | OpenAI-compatible | dependente do endpoint | modelo custom |

## Transporte

`OpenAiAdapter` mantém Chat Completions para xAI e compatibilidade legada. Requisições cujo modelo começa por `gpt-5.6-` usam `POST /v1/responses`.

Corpo Responses:

- `model`, `stream: true`, `store: false`;
- `input` convertido de system/user/assistant/tool;
- tools no formato Responses (`type`, `name`, `description`, `parameters`);
- `max_output_tokens` e `temperature` quando informados.

Parser SSE cobre:

- `response.output_text.delta`;
- `response.output_item.added`/`done` para function calls;
- `response.function_call_arguments.delta`/`done`;
- `response.completed` como terminal de sucesso;
- `response.failed`, `response.incomplete` e `error` como falha;
- abort, timeout, EOF prematuro e limite de buffer.

Roteador continua responsável por acumular deltas, emitir mensagem final e classificar erros.

## Migração de configuração

Durante decode da configuração persistida:

- `grok-4.5` vira `grok-4.6`;
- `gpt-4.1` e `gpt-4.1-mini` viram `gpt-5.6-sol`;
- provider compatível é preservado (`xai` ou `openai`);
- migração vale para configuração global e agentes.

Config inválida fora desses aliases continua falhando fechada.

## Remoção LM Studio/Ollama

Remover:

- probes fixos e `probeLocalEndpoints`;
- retorno LM Studio/Ollama em `discoverLocalProviders`;
- script/package command `verify:local-provider-live` e teste dedicado;
- menções operacionais ativas que apontem ao gate removido.

Preservar:

- OpenAI-compatible com baseURL custom;
- `testCompatConnection`;
- presets ClinePass e Command Code;
- documentos históricos datados, pois registram evidência antiga e não controlam produto atual.

## Testes

TDD obrigatório:

1. RED: catálogo esperado, default Grok 4.6 e ausência dos IDs antigos.
2. RED: migração de config global e por agente.
3. RED: discovery retorna apenas presets, sem probes de rede.
4. RED: GPT-5.6 envia payload Responses e interpreta texto/tool calls SSE.
5. RED: abort, falha terminal e EOF prematuro.
6. GREEN: implementação mínima.
7. Verificação final: testes focados, `npm run typecheck`, `npm run build`, suíte Vitest completa serial.

## Não objetivos

- adicionar provider novo;
- remover OpenAI-compatible genérico;
- mudar presets ClinePass/Command Code;
- implementar OAuth Codex do Pi;
- alterar xAI para OpenRouter.
