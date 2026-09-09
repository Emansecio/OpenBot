# Onda 2 — Contexto, anexos e execução

## Objetivo

Controlar tamanho/custo do request ao modelo e paralelizar somente I/O comprovadamente independente.

## `ContextBudget`

Novo módulo `src/context/budget.ts`.

```ts
interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
}

interface ContextBudgetInput {
  capabilities: ModelCapabilities;
  system: string;
  tools?: readonly ProviderTool[];
  messages: readonly ProviderChatMessage[];
  requestedOutputTokens?: number;
}
```

Estimativa conservadora: `ceil(Buffer.byteLength(text, 'utf8') / 3)`. JSON de schemas/tool messages entra pelo seu texto serializado. O algoritmo:

1. reserva `min(requestedOutputTokens, maxOutputTokens)`;
2. desconta system, tools e margem fixa de 1.024 tokens;
3. agrupa mensagens em turnos completos, mantendo assistant-tool/tool-result juntos;
4. seleciona grupos do mais recente para o mais antigo;
5. devolve em ordem cronológica;
6. quando houver omissão, adiciona uma mensagem curta informando que contexto antigo foi omitido.

Capabilities aprovadas:

| Modelo | Contexto | Saída máxima |
|---|---:|---:|
| `grok-4.5` | 131.072 | 8.192 |
| `gpt-4.1` | 1.000.000 | 32.768 |
| `gpt-4.1-mini` | 1.000.000 | 32.768 |
| OpenAI-compatible desconhecido | 32.768 | 4.096 |

Os defaults compatíveis podem ser sobrescritos por configuração futura, mas esta onda não adiciona UI nova.

## `ProviderContextBuilder`

Novo módulo `src/rpc/provider-context.ts`:

- consulta `getRecentEntries()` em lotes limitados, ampliando somente se ainda houver budget;
- converte apenas entries relevantes para diálogo;
- integra anexos do turno atual;
- aplica `ContextBudget` antes de construir `ProviderChatRequest`;
- fornece `maxTokens` igual à reserva aprovada.

O limite legado de 80 mensagens deixa de controlar o request. A constante exportada `MAX_PROVIDER_TRANSCRIPT_MESSAGES` permanece com valor 80 e anotação `@deprecated` para compatibilidade de import, mas nenhum caminho de runtime a utiliza.

## Anexos

Constantes:

```ts
MAX_ATTACHMENTS_PER_TURN = 8
ATTACHMENT_READ_CONCURRENCY = 4
```

`readAllowedAttachment()` abre o arquivo, executa `stat`, rejeita tamanho inválido e lê no máximo `limit + 1` bytes. Nunca usa `readFile()` para um caminho não dimensionado.

`readTurnAttachments()`:

- preserva a ordem original;
- usa map com concorrência 4;
- rejeita itens acima de 8 como `skipped` explícito;
- interrompe inclusão de texto quando o budget agregado acabar;
- não persiste blocos que não serão enviados sem um marcador `skipped`.

## Tool e search output

```ts
MAX_TOOL_RESULT_BYTES = 128 * 1024
SEARCH_READ_CONCURRENCY = 8
MAX_SEARCH_RESULTS = 1_000
```

A truncagem preserva UTF-8 e termina com `\n[output truncated by OpenBot]`. O contrato de sucesso de `command.run` recebe o campo aditivo opcional `truncated?: boolean`; resultados truncados definem `truncated:true` e sempre contêm o marcador textual.

Busca processa arquivos em lotes de até 8:

1. lê o lote em paralelo;
2. processa os resultados na ordem determinística dos paths;
3. atualiza limites de bytes/resultados;
4. só agenda o próximo lote se ainda houver budget.

## Paralelismo de tool calls

Classificação read-only:

- `file.read`, `file.list`, `search.files`, `search.text`: read-only;
- `file.write` e qualquer operação desconhecida: mutável.

Se todas as calls únicas do round forem read-only, executar com concorrência máxima 4. Se qualquer call for mutável, executar o round inteiro sequencialmente na ordem do provider. Resultados são devolvidos ao modelo na ordem original mesmo quando conclusões ocorrerem fora de ordem.

## Descoberta local

`probeLocalEndpoints()` usa `Promise.allSettled` sobre os probes, mantendo a ordem de `PROBES`. Cada probe conserva seu próprio timeout e erro.

## Erros

- Budget insuficiente para system/tools retorna erro de validação antes da rede.
- Arquivo que cresce após `stat` é detectado pela leitura de `limit+1`.
- Falha individual de anexo vira `skipped`; não derruba os demais.
- Falha individual de tool read-only gera resultado de erro para aquela call; não cancela calls irmãs já iniciadas.
- AbortSignal interrompe agendamento de novos lotes.

## Testes exigidos

1. Budget nunca excede janela e preserva turnos completos.
2. Anexo/tool mais recente é preservado antes de histórico antigo.
3. `maxTokens` é enviado ao provider.
4. Arquivo esparso de 64 MiB é rejeitado após leitura limitada, não integral.
5. Nono anexo recebe `skipped` sem ser aberto.
6. Ordem de anexos permanece estável com concorrência.
7. Busca paralela produz output idêntico à ordem sequencial.
8. Output acima de 128 KiB é truncado em UTF-8 válido com marcador.
9. Lote totalmente read-only roda em paralelo; lote com write roda em série.
10. Dois probes de 120 ms completam em aproximadamente uma unidade lógica de delay usando relógio/fetch controlado, sem assert frágil de parede.

## Critérios de aceite

- Nenhum request ao provider excede o budget calculado.
- Nenhum arquivo acima do limite é carregado integralmente.
- Outputs de tools não ultrapassam 128 KiB.
- Paralelismo não altera ordem observável nem semântica de mutações.