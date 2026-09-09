# Current Provider Models Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Exibir e executar Grok 4.6 e GPT-5.6 Luna/Sol/Terra, migrar configurações antigas e remover descoberta específica LM Studio/Ollama.

**Architecture:** Manter registry e contratos atuais. `OpenAiAdapter` seleciona Responses API somente para IDs `gpt-5.6-*`; xAI e compatibilidade legada continuam Chat Completions. Catálogo estático controla UI; decode de config traduz aliases antigos antes da validação. Discovery continua expondo apenas presets OpenAI-compatible explícitos, sem probes locais.

**Tech Stack:** TypeScript 5.9, Node.js 22, fetch/Web Streams, Vitest 3.2.

**Execution note:** checkout não contém `.git`; executar no diretório atual, sem passos de commit/worktree.

---

### Task 1: Atualizar catálogo e defaults

**Files:**
- Modify: `src/config/models.ts`
- Modify: `src/config/store.ts`
- Modify: `src/rpc/send.ts`
- Modify: `test/shared-contracts.test.ts`
- Modify: `test/xai.test.ts`
- Modify: `test/config-store.test.ts`

- [ ] **Step 1: Escrever expectativas RED do catálogo**

Atualizar teste de visão em `test/shared-contracts.test.ts` para exigir exatamente:

```ts
expect(MODEL_CATALOG.map(({ id, provider }) => ({ id, provider }))).toEqual([
  { id: "grok-4.6", provider: "xai" },
  { id: "gpt-5.6-luna", provider: "openai" },
  { id: "gpt-5.6-sol", provider: "openai" },
  { id: "gpt-5.6-terra", provider: "openai" },
  { id: "openai-compatible", provider: "openai-compat" },
]);
expect(MODEL_CATALOG.filter((entry) => entry.supportsVision).map((entry) => entry.id)).toEqual([
  "grok-4.6",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
expect(MODEL_CATALOG.find((entry) => entry.default)?.id).toBe("grok-4.6");
```

- [ ] **Step 2: Executar RED**

Run:

```bash
npx vitest run test/shared-contracts.test.ts test/xai.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL mostrando IDs antigos `grok-4.5`, `gpt-4.1`, `gpt-4.1-mini`.

- [ ] **Step 3: Substituir catálogo**

`src/config/models.ts`:

```ts
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { id: "grok-4.6", provider: "xai", displayName: "Grok 4.6", description: "Modelo default do produto", contextWindow: 500_000, supportsVision: true, default: true },
  { id: "gpt-5.6-luna", provider: "openai", displayName: "GPT-5.6 Luna", description: "OpenAI", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-sol", provider: "openai", displayName: "GPT-5.6 Sol", description: "OpenAI", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", provider: "openai", displayName: "GPT-5.6 Terra", description: "OpenAI", contextWindow: 272_000, supportsVision: true },
  { id: "openai-compatible", provider: "openai-compat", displayName: "OpenAI-compatible", description: "Modelo configurado no endpoint custom" },
];
```

Trocar default fresco em `src/config/store.ts`:

```ts
activeProvider: "xai",
globalModel: "grok-4.6",
```

Atualizar comentário default em `src/rpc/send.ts` e expectativas diretamente dependentes do catálogo em testes.

- [ ] **Step 4: Executar GREEN focado**

```bash
npx vitest run test/shared-contracts.test.ts test/xai.test.ts test/config-store.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS.

---

### Task 2: Migrar configurações persistidas

**Files:**
- Modify: `src/config/store.ts`
- Modify: `test/config-store.test.ts`

- [ ] **Step 1: Escrever teste RED da migração global e por agente**

Adicionar helper de fixture usando config fresca, sobrescrever JSON no disco e reabrir:

```ts
it("migrates obsolete provider models before validation", () => {
  const path = configPath();
  const store = new ConfigStore({ configPath: path });
  const raw = store.snapshot();
  writeFileSync(path, JSON.stringify({
    ...raw,
    activeProvider: "xai",
    globalModel: "grok-4.5",
    agents: [
      { id: "grok", name: "Grok", avatarId: "a", provider: "xai", model: "grok-4.5" },
      { id: "gpt", name: "GPT", avatarId: "b", provider: "openai", model: "gpt-4.1-mini" },
    ],
  }));

  expect(new ConfigStore({ configPath: path }).snapshot()).toMatchObject({
    activeProvider: "xai",
    globalModel: "grok-4.6",
    agents: [
      { provider: "xai", model: "grok-4.6" },
      { provider: "openai", model: "gpt-5.6-sol" },
    ],
  });
});
```

Adicionar segundo caso global OpenAI `gpt-4.1` → `gpt-5.6-sol`.

- [ ] **Step 2: Executar RED**

```bash
npx vitest run test/config-store.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL com `modelo não suportado`.

- [ ] **Step 3: Implementar tradução antes de `validateModelProvider`**

Em `decodeConfig`, depois de validar que provider/modelo são strings e antes de construir/validar config:

```ts
const LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  "grok-4.5": "grok-4.6",
  "gpt-4.1": "gpt-5.6-sol",
  "gpt-4.1-mini": "gpt-5.6-sol",
};

function migrateModelId(model: string): string {
  return LEGACY_MODEL_IDS[model] ?? model;
}
```

Aplicar:

```ts
raw.globalModel = migrateModelId(raw.globalModel);
if (Array.isArray(raw.agents)) {
  raw.agents = raw.agents.map((agent) => isRecord(agent) && typeof agent.model === "string"
    ? { ...agent, model: migrateModelId(agent.model) }
    : agent);
}
```

Não alterar provider; validação existente confirma compatibilidade.

- [ ] **Step 4: Executar GREEN**

```bash
npx vitest run test/config-store.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS.

---

### Task 3: Remover descoberta LM Studio/Ollama

**Files:**
- Modify: `src/providers/local-discover.ts`
- Modify: `src/rpc/roster.ts`
- Modify: `test/provider-regressions.test.ts`
- Modify: `test/fidelity-windows.test.ts`
- Modify: `src/providers/openai-compat.ts`
- Delete: `scripts/verify-local-provider-live.mjs`
- Delete: `test/local-provider-live-script.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Escrever RED do discovery sem rede**

Em `test/fidelity-windows.test.ts`, remover teste de `probeLocalEndpoints` e fortalecer RPC:

```ts
expect(value.endpoints).toEqual([
  expect.objectContaining({ id: "clinepass" }),
  expect.objectContaining({ id: "commandcode" }),
]);
```

Em `test/provider-regressions.test.ts`, remover import/test de probes; manter `testCompatConnection`.

- [ ] **Step 2: Executar RED**

```bash
npx vitest run test/fidelity-windows.test.ts test/provider-regressions.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL porque RPC ainda acrescenta `lmstudio` e `ollama`.

- [ ] **Step 3: Remover probes e deixar conexão custom**

Em `src/providers/local-discover.ts`, apagar `LocalEndpointProbe`, `PROBES` e `probeLocalEndpoints`. Preservar `ConnectionTestResult`, parser de modelos, `fetchJson` e `testCompatConnection`.

Em `src/rpc/roster.ts`:

```ts
import { testCompatConnection } from "../providers/local-discover.js";
```

Handler:

```ts
gateway.registerHandler("discoverLocalProviders", () => ({
  endpoints: compatPresetEndpoints(),
}));
```

Remover exemplos específicos LM Studio/Ollama do comentário de `src/providers/openai-compat.ts`, mantendo explicação de endpoint OpenAI-compatible custom.

- [ ] **Step 4: Remover gate obsoleto**

```bash
rm scripts/verify-local-provider-live.mjs test/local-provider-live-script.test.ts
```

Remover de `package.json`:

```json
"verify:local-provider-live": "npm run build && node scripts/verify-local-provider-live.mjs"
```

- [ ] **Step 5: Executar GREEN**

```bash
npx vitest run test/fidelity-windows.test.ts test/provider-regressions.test.ts test/compat-presets.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS.

---

### Task 4: Implementar OpenAI Responses para GPT-5.6

**Files:**
- Modify: `src/providers/openai.ts`
- Create: `test/openai-responses.test.ts`

- [ ] **Step 1: Escrever RED de payload e texto SSE**

Criar fetch fake que captura request e responde:

```ts
const responseEvents = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "Olá" },
  { type: "response.output_text.delta", output_index: 0, delta: " mundo" },
  { type: "response.completed", response: { id: "resp_1", status: "completed" } },
];
const fetchImpl = vi.fn(async (_url, init) => new Response(
  responseEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
));
const adapter = new OpenAiAdapter({ apiKey: "sk-test", fetchImpl });
const registry = createProviderRegistry();
registry.register(adapter);
const out = await streamChat("openai", {
  model: "gpt-5.6-sol",
  system: "system",
  messages: [{ role: "user", content: "oi" }],
}, undefined, { registry });
expect(out.message?.content).toBe("Olá mundo");
expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.objectContaining({ method: "POST" }));
expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
  model: "gpt-5.6-sol",
  stream: true,
  store: false,
});
```

- [ ] **Step 2: Escrever RED de function call**

SSE deve incluir `response.output_item.added`, deltas de argumentos, `response.function_call_arguments.done`, `response.output_item.done` e `response.completed`. Esperar evento normalizado:

```ts
expect(events).toContainEqual({
  type: "tool-call",
  call: {
    id: "call_weather",
    type: "function",
    function: { name: "weather", arguments: "{\"city\":\"SP\"}" },
  },
});
```

- [ ] **Step 3: Escrever RED de falha/EOF/abort**

Cobrir:

```ts
expect((await run([{ type: "response.failed", response: { status: "failed", error: { message: "boom" } } }])).error).toBeDefined();
expect((await run([{ type: "response.output_text.delta", output_index: 0, delta: "parcial" }])).error).toMatchObject({ kind: "server" });
```

Abort deve resultar `kind: "aborted"` pelo roteador.

- [ ] **Step 4: Executar RED**

```bash
npx vitest run test/openai-responses.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL porque adapter chama `/chat/completions` e espera `[DONE]`.

- [ ] **Step 5: Implementar seleção de transporte**

Em `OpenAiAdapter.streamChat`, depois de resolver chave e antes de `buildChatBody`:

```ts
const usesResponsesApi = req.model.startsWith("gpt-5.6-");
const body = usesResponsesApi ? buildResponsesBody(req) : buildChatBody(req);
const endpoint = new URL(this.baseUrl);
endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${usesResponsesApi ? "responses" : "chat/completions"}`;
```

Adicionar funções locais tipadas:

```ts
function buildResponsesBody(req: ProviderChatRequest): Record<string, unknown> {
  const input: unknown[] = [];
  if (req.system) input.push({ role: "developer", content: req.system });
  for (const message of req.messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    input.push({ role: message.role, content: message.content });
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }
  }
  return {
    model: req.model,
    input,
    stream: true,
    store: false,
    ...(req.tools?.length ? {
      tools: req.tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? {},
      })),
    } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_output_tokens: Math.max(16, req.maxTokens) } : {}),
  };
}
```

Adicionar `readResponsesStream` com `Map<number, { id; name; arguments }>`; emitir deltas de texto imediatamente, acumular function-call args e emitir cada tool call uma vez em `response.output_item.done`. Considerar sucesso somente após `response.completed`; lançar `ApiError(..., 502)` para falha terminal/EOF/buffer inválido.

No mesmo `streamChat`:

```ts
if (usesResponsesApi) await this.readResponsesStream(response.body, emit, controller.signal, resetIdleTimer);
else await this.readStream(response.body, emit, controller.signal, resetIdleTimer);
```

- [ ] **Step 6: Executar GREEN focado e regressões OpenAI/xAI**

```bash
npx vitest run test/openai-responses.test.ts test/providers.test.ts test/xai.test.ts test/openai-compat.test.ts test/tool-calls.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS.

---

### Task 5: Atualizar referências operacionais

**Files:**
- Modify: `README.md`
- Modify: `docs/verification-gates.md`
- Modify: `docs/chat-provider-resilience.md`

- [ ] **Step 1: Atualizar README**

Trocar default documentado `grok-4.5` por `grok-4.6`; listar GPT-5.6 Luna/Sol/Terra no estado de providers.

- [ ] **Step 2: Remover gate local de docs ativas**

Apagar seção/comandos `verify:local-provider-live` e referências LM Studio/Ollama em `docs/verification-gates.md` e `docs/chat-provider-resilience.md`. Não editar documentos históricos datados.

- [ ] **Step 3: Confirmar ausência em superfícies ativas**

```bash
rg -n "LM Studio|Ollama|lmstudio|ollama|verify:local-provider-live" package.json src scripts test README.md docs/verification-gates.md docs/chat-provider-resilience.md
```

Expected: nenhum match.

---

### Task 6: Verificação final

**Files:**
- Verify only

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: exit 0 e `dist/` atualizado.

- [ ] **Step 3: Suíte completa serial**

```bash
npm test -- --maxWorkers=1 --no-file-parallelism
```

Expected: todos arquivos/testes passam; único skip ACL pode permanecer.

- [ ] **Step 4: Busca de catálogo obsoleto em código ativo**

```bash
rg -n "grok-4\.5|gpt-4\.1(?:-mini)?|LM Studio|Ollama|lmstudio|ollama" src test package.json README.md scripts
```

Expected: IDs antigos aparecem somente nos testes explícitos de migração; nenhuma referência LM Studio/Ollama.
