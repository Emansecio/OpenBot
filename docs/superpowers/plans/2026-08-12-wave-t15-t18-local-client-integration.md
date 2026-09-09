# Wave T15–T18 — Integração do cliente local

> **Status atual (2026-08-12): documento histórico.** Este documento preserva o plano/design original. O estado executável atual está em [`../../phase-2-local-execution-progress.md`](../../phase-2-local-execution-progress.md) e no [`README`](../../../README.md).


## Decisão

Uma wave deve implementar **T15, T16 e T17**. T18 fica como etapa dependente e pode ser incluída somente após validar o conector local. T19 permanece separado como aceite final.

## Capacidade recomendada

- **T15:** patch de perfil local, removendo gates de autenticação.
- **T16:** conexão do cliente ao gateway `127.0.0.1:1340`, descritor local e health check.
- **T17:** updates/telemetria desativados e auditoria de egress.
- **T18:** iniciar apenas se os fluxos de UI e canais IPC existentes forem identificados; não inventar wiring.
- **T19:** não implementar nesta wave; exige provider real, UI completa e monitoramento Windows.

## Sequência

### 1. Inventário e fixtures

**Arquivos:** `client/extracted/dist/electron-dev-controls/main.cjs`, `patches/diff-t15-t17.txt`, novos `test/client-contracts.test.ts`.

- Identificar funções de auth, connector, update e telemetria no bundle original/patched.
- Extrair somente trechos necessários; manter o bundle sem rebuild.
- Criar fixtures de descritor local e respostas de health.

### 2. T15 — Perfil local

**Arquivos:** `patches/diff-t15-t17.txt`, `client/extracted/dist/electron-dev-controls/main.cjs` apenas se necessário, `test/client-auth-patch.test.ts`.

- Mapear status/auth para perfil local.
- Tornar login/logout e refresh no-ops seguros.
- Preservar nome/avatar via RPC/config local.
- Garantir ausência de credenciais Cursor no caminho de boot.

### 3. T16 — Conector local

**Arquivos:** `src/main.ts`, `src/server/gateway.ts`, `scripts/local-descriptor.mjs`, `client/extracted/dist/electron-dev-controls/main.cjs`, `test/local-connector.test.ts`.

- Gerar descritor local com URL `http://127.0.0.1:1340` e token loopback não secreto.
- Validar `/health` e falhar claramente se a porta não estiver disponível.
- Adaptar o cliente para preferir o descritor local.
- Não adicionar fallback para serviços Cursor.

### 4. T17 — Egress e telemetria

**Arquivos:** `patches/diff-t15-t17.txt`, `client/extracted/dist/electron-dev-controls/main.cjs`, `scripts/monitor-rede.ps1`, `test/egress-policy.test.ts`.

- Desativar update checks e instalações.
- Desativar Statsig/Sentry/OTLP/telemetria remota.
- Manter reportes como no-op ou log local.
- Auditar URLs proibidas no artefato final.

### 5. Gate de T18 e handoff T19

**Arquivos:** `test/wave-t15-t17.integration.test.ts`, `README.md`.

- Testar bootstrap, descritor e health sem rede externa.
- Testar que falhas do gateway são apresentadas localmente.
- Documentar o que ainda falta para T18: canais IPC da UI, telas e fluxo de provider.
- Preparar checklist de T19 sem alegar aceite final.

## Critérios de aceite

- Cliente inicia sem login Cursor.
- Gateway local é descoberto e `/health` responde.
- Nenhuma tentativa de update, Statsig, Sentry, OTLP ou domínio Cursor ocorre no caminho testado.
- Alterações permanecem em patches mínimos, sem rebuild do renderer.
- `npm run build` e `npm test` continuam verdes.

## Fora do escopo

- Provider real e smoke com chave real.
- Aceite completo T19.
- Execução de tools, VNC e transcrição.
- Rebuild ou refatoração ampla do bundle cliente.
