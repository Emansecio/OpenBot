# Onda 4 — Build, pacote e regressão de performance

## Objetivo

Remover custos residuais, separar artefatos de desenvolvimento da distribuição e impedir regressões dos ganhos anteriores.

## Fila SSE

`SseClient.pending` passa de `string[]` para:

```ts
interface PendingFrame {
  frame: string;
  bytes: number;
}

interface SseClient {
  pending: PendingFrame[];
  pendingHead: number;
}
```

Flush avança `pendingHead` sem `shift()`. Quando a fila esvazia, array e cursor são resetados. Bytes não são recalculados.

## Builds separados

- `tsconfig.json`: base estrita compartilhada, sem decisão de emissão.
- `tsconfig.dev.json`: `incremental:true`, `sourceMap:true`, `declaration:false`, com `.tsbuildinfo` em `node_modules/.cache/openbot/`.
- `tsconfig.prod.json`: `incremental:false`, `sourceMap:false`, `declaration:false`.

Novo `scripts/clean-dist.mjs` remove somente `dist/` antes do build de produção.

Scripts:

```json
{
  "build": "npm run build:prod",
  "clean:dist": "node scripts/clean-dist.mjs",
  "build:prod": "npm run clean:dist && tsc -p tsconfig.prod.json",
  "build:dev": "tsc -p tsconfig.dev.json --watch",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

O entrypoint permanece `dist/main.js`.

## Pacote runtime seguro

Novo `scripts/package-runtime.mjs` com opções:

```text
--source <client-dir>   default client
--out <target-dir>     obrigatório
--dry-run               lista sem copiar
```

Regras:

- recusa `out` dentro de `source`;
- nunca remove arquivos do source;
- copia árvore preservando paths;
- exclui somente extensões/arquivos de desenvolvimento aprovados:
  `.map`, `.original`, `.iobj`, `.ipdb`, `.tlog`, `.vcxproj`, `.filters`, `.lastbuildstate`;
- falha se faltarem `extracted/dist/electron-main/main.cjs` ou `extracted/dist/renderer/index.html`;
- produz `package-manifest.json` com contagem, bytes de origem/copiados/excluídos e regras usadas.

A possível deduplicação de `app.asar.unpacked` não será feita automaticamente nesta onda, pois layouts iguais podem ter papéis distintos no loader. O relatório apenas mede overlap.

## Suíte de performance

Novo `test/performance-regression.test.ts` usa relógios/stores/fetches injetados. Budgets estruturais:

1. 5.000 ticks de stream: persists ≤ `ceil(duration/1000)+2`.
2. Nenhum snapshot integral emitido por turno/tool completion.
3. Context builder devolve tokens ≤ budget.
4. Anexo acima do limite lê no máximo `limit+1` bytes.
5. Config hot path executa zero `snapshot()` por delta.
6. Dois probes independentes iniciam antes de qualquer um resolver.
7. Fila SSE faz flush sem `shift()` e sem recalcular bytes.
8. Runtime package contém zero arquivos proibidos.

O script obrigatório `scripts/benchmark-hot-paths.mjs` reporta tempos, writes e bytes para execução manual, mas não falha por milissegundos. O CI falha apenas em contagens/tamanhos determinísticos.

## Documentação e métricas

- Atualizar README com `build:dev`, `build:prod`, `typecheck` e `package:runtime`.
- Registrar antes/depois em `analysis_outputs/IMPLEMENTATION_RESULTS.md`.
- O relatório inclui testes, writes por stream, bytes SSE, tamanho do pacote limpo e arquivos excluídos.

## Erros

- Empacotamento para target existente exige target vazio ou `--force`; sem `--force`, falha.
- Erro de cópia remove apenas o target parcial criado pela execução, nunca o source.
- Build prod limpa `dist` antes de emitir para evitar `.map`/`.d.ts` antigos.
- Benchmarks manuais não são usados como gate de hardware.

## Testes exigidos

1. Fila bloqueada preserva ordem, bytes e reconexão de drain.
2. Fila com milhares de frames não usa `shift()`; teste inspeciona comportamento, não tempo.
3. `build:prod` gera JS/JSON necessários e zero `.map`/`.d.ts`.
4. `build:dev` typechecks com incremental habilitado.
5. Empacotador exclui exatamente as extensões aprovadas em fixture temporária.
6. Empacotador preserva `.js`, `.cjs`, `.node`, HTML, CSS e assets.
7. Source permanece byte a byte intacto.
8. Manifest soma bytes/arquivos corretamente.
9. Entry point ausente causa erro claro.
10. Suíte estrutural de performance cobre os budgets das quatro ondas.

## Verificação final

```bash
npm run typecheck
npm test -- --reporter=dot
npm run build:prod
npm run smoke:local
node scripts/package-runtime.mjs --source client --out <temp>
```

## Critérios de aceite

- `dist/` de produção não contém maps/declarations.
- Pacote temporário não contém artefatos proibidos e preserva entrypoints.
- `client/` original permanece inalterado.
- Todos os budgets estruturais e testes funcionais passam.
- `IMPLEMENTATION_RESULTS.md` documenta resultados e limitações restantes.