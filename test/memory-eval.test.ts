import { describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/memory/context.js";
import { SqliteMemoryStore } from "../src/memory/sqlite-store.js";
import type { MemoryUpsertInput } from "../src/memory/types.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

/**
 * Avaliação da recuperação lexical de memória (FTS5 + recência) sobre um corpus
 * fixo de um usuário pessoal. É o placar: cada categoria mede recall@6 e
 * precisão, e os limiares abaixo travam o baseline medido para que uma
 * regressão de recuperação falhe o teste. `paraphrase` só registra o número.
 */

type Kind = MemoryUpsertInput["kind"];
type Category = "lexical" | "identifier" | "generic" | "unrelated" | "paraphrase" | "recency";
interface Case { category: Category; query: string; expected: readonly string[] }

const K = 6; // limite que o ContextAssembler usa por consulta
const DAY = 24 * 60 * 60_000;

const CORPUS: readonly (readonly [Kind, string, string])[] = [
  ["identity", "identity.name", "O usuário se chama Thiago e mora em Fortaleza."],
  ["identity", "identity.role", "Thiago é desenvolvedor de software e dono de uma academia."],
  ["preference", "pref.language", "Prefere respostas em português do Brasil, diretas e sem enrolação."],
  ["preference", "pref.editor", "Usa o VS Code com tema escuro e fonte Fira Code."],
  ["preference", "pref.format", "Gosta de listas curtas em vez de parágrafos longos."],
  ["preference", "pref.coffee", "Toma café sem açúcar e prefere expresso."],
  ["constraint", "constraint.budget", "Não gastar mais de R$ 200 por mês com APIs de modelos."],
  ["constraint", "constraint.secrets", "Nunca commitar arquivos .env nem chaves de API no repositório."],
  ["constraint", "constraint.email", "Never send emails on behalf of the user without explicit confirmation."],
  ["fact", "pet.dog", "O cachorro do usuário se chama Thor, é um golden retriever de 4 anos."],
  ["fact", "family.sister", "A irmã do usuário, Marina, faz aniversário em 12 de março."],
  ["fact", "project.farol", "O projeto FAROL-731 é o painel de relatórios financeiros da academia."],
  ["fact", "model.grok", "O modelo grok-4.6 é usado nos testes de raciocínio longo do bot."],
  ["fact", "server.host", "O servidor de produção roda numa VPS em Frankfurt com Ubuntu 24.04."],
  ["fact", "car", "O carro do usuário é um Honda Civic 2019 prata."],
  ["fact", "gym.hours", "A academia abre às 6h e fecha às 22h nos dias úteis."],
  ["fact", "db.version", "O banco local usa SQLite 3.45 com FTS5 habilitado."],
  ["fact", "run.routine", "Corre 5 km às terças e quintas de manhã."],
  ["fact", "books", "Está lendo o livro Sapiens e quer ler Homo Deus depois."],
  ["fact", "music", "Ouve muito jazz e bossa nova enquanto programa."],
  ["fact", "english.study", "Estuda inglês toda noite com o aplicativo Duolingo."],
  ["fact", "desk.monitors", "Trabalha com dois monitores de 27 polegadas."],
  ["decision", "db.choice", "Decidimos usar SQLite em vez de Postgres porque o bot é local."],
  ["decision", "deploy.windows", "Decidiu distribuir o OpenBot apenas para Windows por enquanto."],
  ["decision", "gym.pricing", "Ficou decidido cobrar mensalidade de R$ 89 nos planos da academia."],
  ["procedure", "proc.backup", "Procedimento de backup: exportar o banco toda sexta-feira e copiar para o HD externo."],
  ["procedure", "proc.release", "Para publicar uma versão: rodar os testes, gerar o instalador e atualizar o changelog."],
  ["procedure", "proc.gateway", "To restart the gateway: stop the service, clear the cache folder, then start it again."],
  ["open_loop", "loop.cert", "Pendente: renovar o certificado digital da empresa antes de 30 de novembro."],
  ["open_loop", "loop.trip", "Falta comprar as passagens para a viagem a Lisboa em dezembro."],
  ["open_loop", "loop.flaky", "Pending: investigate why the flaky browser test fails on Fridays."],
];

const CASES: readonly Case[] = [
  // lexical: mesma palavra ou raiz (plural, acento, caixa)
  { category: "lexical", query: "qual o nome do meu cachorro?", expected: ["pet.dog"] },
  { category: "lexical", query: "meus cachorros", expected: ["pet.dog"] },
  { category: "lexical", query: "CACHORRO GOLDEN", expected: ["pet.dog"] },
  { category: "lexical", query: "quando é o aniversário da minha irmã?", expected: ["family.sister"] },
  { category: "lexical", query: "aniversario das irmas", expected: ["family.sister"] },
  { category: "lexical", query: "onde fica o servidor de producao?", expected: ["server.host"] },
  { category: "lexical", query: "qual carro eu tenho?", expected: ["car"] },
  { category: "lexical", query: "banco de dados local", expected: ["db.version", "db.choice"] },
  { category: "lexical", query: "sobre a academia", expected: ["gym.hours", "project.farol", "identity.role", "gym.pricing"] },
  { category: "lexical", query: "rodar os testes", expected: ["proc.release", "model.grok"] },
  { category: "lexical", query: "restart the gateway", expected: ["proc.gateway"] },
  { category: "lexical", query: "flaky tests", expected: ["loop.flaky"] },
  { category: "lexical", query: "café expresso", expected: ["pref.coffee"] },
  { category: "lexical", query: "passagens para Lisboa", expected: ["loop.trip"] },
  { category: "lexical", query: "Jazz", expected: ["music"] },
  { category: "lexical", query: "meu monitor", expected: ["desk.monitors"] },
  { category: "lexical", query: "certificado digital", expected: ["loop.cert"] },
  { category: "lexical", query: "sem enrolação", expected: ["pref.language"] },
  // identifier: códigos com hífen ou ponto
  { category: "identifier", query: "FAROL-731", expected: ["project.farol"] },
  { category: "identifier", query: "farol 731", expected: ["project.farol"] },
  { category: "identifier", query: "grok-4.6", expected: ["model.grok"] },
  { category: "identifier", query: "grok 4.6", expected: ["model.grok"] },
  { category: "identifier", query: "Ubuntu 24.04", expected: ["server.host"] },
  { category: "identifier", query: "SQLite 3.45", expected: ["db.version"] },
  { category: "identifier", query: "FTS5", expected: ["db.version"] },
  { category: "identifier", query: "R$ 200", expected: ["constraint.budget"] },
  { category: "identifier", query: "Civic 2019", expected: ["car"] },
  // generic: só palavras funcionais ou cortesia; nada deve entrar em "Relevant memories"
  { category: "generic", query: "o que você sabe de mim?", expected: [] },
  { category: "generic", query: "me conta tudo que você lembra sobre mim", expected: [] },
  { category: "generic", query: "oi, tudo bem?", expected: [] },
  { category: "generic", query: "what do you know about me?", expected: [] },
  { category: "generic", query: "hello, how are you?", expected: [] },
  { category: "generic", query: "pode me ajudar com uma coisa?", expected: [] },
  // unrelated: assunto ausente do corpus
  { category: "unrelated", query: "receita de bolo de chocolate", expected: [] },
  { category: "unrelated", query: "qual a capital da Austrália?", expected: [] },
  { category: "unrelated", query: "como funciona a fotossíntese?", expected: [] },
  { category: "unrelated", query: "who won the world cup in 2010?", expected: [] },
  { category: "unrelated", query: "explique o teorema de Pitágoras", expected: [] },
  { category: "unrelated", query: "how to train a neural network with pytorch", expected: [] },
  { category: "unrelated", query: "qual o preço do bitcoin hoje?", expected: [] },
  // paraphrase: sem palavra em comum (nem com a canonicalKey, que também é indexada no FTS); lacuna conhecida, só embeddings resolveriam
  { category: "paraphrase", query: "qual o nome do meu bichinho de estimação?", expected: ["pet.dog"] },
  { category: "paraphrase", query: "meu animal de companhia", expected: ["pet.dog"] },
  { category: "paraphrase", query: "meu veículo", expected: ["car"] },
  { category: "paraphrase", query: "minha parente", expected: ["family.sister"] },
  { category: "paraphrase", query: "onde hospedo minha aplicação?", expected: ["server.host"] },
  { category: "paraphrase", query: "que tipo de música eu curto?", expected: ["music"] },
  { category: "paraphrase", query: "qual é o meu teto de custos com inteligência artificial?", expected: ["constraint.budget"] },
  { category: "paraphrase", query: "what is my puppy called?", expected: ["pet.dog"] },
  { category: "paraphrase", query: "estou aprendendo algum idioma?", expected: ["english.study"] },
];

/** Pares (antigo, recente) que casam igual: o recente deve vir primeiro. Textos de mesmo tamanho isolam a recência do bm25. */
const RECENCY_PAIRS: readonly { query: string; kind: Kind; old: string; recent: string }[] = [
  { query: "plano Titan da hospedagem", kind: "fact", old: "Plano Titan da hospedagem custa R$ 40 ao mês.", recent: "Plano Titan da hospedagem custa R$ 55 ao mês." },
  { query: "aluguel do escritório", kind: "fact", old: "O aluguel do escritório é de R$ 1500 por mês.", recent: "O aluguel do escritório é de R$ 1800 por mês." },
  { query: "testes do Orion", kind: "decision", old: "Decidimos adotar Mocha nos testes do Orion.", recent: "Decidimos adotar Karma nos testes do Orion." },
  { query: "fatura Nubank", kind: "open_loop", old: "Pendente: pagar a fatura do cartão Nubank em janeiro.", recent: "Pendente: pagar a fatura do cartão Nubank em março." },
];

/**
 * Limiares = baseline medido, arredondado para baixo com folga de 0.05.
 * `paraphrase` não tem piso: é o número que decidiria adotar embeddings.
 */
const THRESHOLDS = {
  lexical: { recall: 0.95, precision: 0.89 },
  identifier: { recall: 0.95, precision: 0.89 },
  generic: { silence: 0.95 },
  unrelated: { silenceSearch: 0.95, silenceAssembler: 0.95 },
  recency: { recentFirst: 0.95 },
};

const mean = (values: readonly number[]): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const fixed = (value: number): string => value.toFixed(2);

function evaluate() {
  const store = new SqliteTranscriptStore({ path: ":memory:" });
  try {
    for (const [kind, canonicalKey, text] of CORPUS) {
      store.memoryStore.upsertMemory("agent-a", { kind, canonicalKey, text, trust: "user" }, { kind: "admin" });
    }
    const conversationId = store.conversationStore.create("agent-a").id;
    const search = (query: string): string[] =>
      store.memoryStore.searchMemories("agent-a", query, { limit: K, automatic: true }).map((result) => result.memory.canonicalKey);
    const assemblerRelevant = (prompt: string): boolean => JSON.stringify(new ContextAssembler().assemble({
      agentId: "agent-a", conversationId, prompt, recentStore: store, memoryStore: store.memoryStore,
      mode: "automatic", conversation: { temporary: false }, systemText: "", toolText: "",
    }).messages).includes("Relevant memories");

    const notes: string[] = [];
    const ranked = (category: "lexical" | "identifier" | "paraphrase") => {
      const scores = CASES.filter((item) => item.category === category).map((item) => {
        const got = search(item.query);
        const hits = got.filter((key) => item.expected.includes(key)).length;
        const recall = hits / item.expected.length;
        const precision = got.length === 0 ? 0 : hits / got.length;
        if (recall < 1 || precision < 1) notes.push(`${category} "${item.query}" esperado [${item.expected}] veio [${got}]`);
        return { recall, precision };
      });
      return { n: scores.length, recall: mean(scores.map((score) => score.recall)), precision: mean(scores.map((score) => score.precision)) };
    };
    const lexical = ranked("lexical");
    const identifier = ranked("identifier");
    const paraphrase = ranked("paraphrase");

    const generic = CASES.filter((item) => item.category === "generic");
    const genericSilent = generic.filter((item) => !assemblerRelevant(item.query));
    for (const item of generic) if (assemblerRelevant(item.query)) notes.push(`generic "${item.query}" injetou Relevant memories`);
    const unrelated = CASES.filter((item) => item.category === "unrelated");
    const unrelatedSearch = unrelated.filter((item) => search(item.query).length === 0);
    const unrelatedAssembler = unrelated.filter((item) => !assemblerRelevant(item.query));
    for (const item of unrelated) {
      if (search(item.query).length > 0) notes.push(`unrelated "${item.query}" veio [${search(item.query)}]`);
      if (assemblerRelevant(item.query)) notes.push(`unrelated "${item.query}" injetou Relevant memories`);
    }
    return {
      lexical, identifier, paraphrase, notes,
      generic: { n: generic.length, silence: genericSilent.length / generic.length },
      unrelated: { n: unrelated.length, silenceSearch: unrelatedSearch.length / unrelated.length, silenceAssembler: unrelatedAssembler.length / unrelated.length },
    };
  } finally {
    store.close();
  }
}

function evaluateRecency(): { n: number; recentFirst: number; notes: string[] } {
  let clock = 0;
  const memory = new SqliteMemoryStore({ path: ":memory:", now: () => clock });
  try {
    for (const [index, pair] of RECENCY_PAIRS.entries()) {
      memory.upsertMemory("agent-a", { kind: pair.kind, canonicalKey: `old.${index}`, text: pair.old, trust: "user" }, { kind: "admin" });
    }
    clock = 90 * DAY;
    for (const [index, pair] of RECENCY_PAIRS.entries()) {
      memory.upsertMemory("agent-a", { kind: pair.kind, canonicalKey: `new.${index}`, text: pair.recent, trust: "user" }, { kind: "admin" });
    }
    const notes: string[] = [];
    const firsts = RECENCY_PAIRS.map((pair, index) => {
      const got = memory.searchMemories("agent-a", pair.query, { limit: K, automatic: true }).map((result) => result.memory.canonicalKey);
      const ok = got[0] === `new.${index}` && got.includes(`old.${index}`);
      if (!ok) notes.push(`recency "${pair.query}" veio [${got}]`);
      return ok ? 1 : 0;
    });
    return { n: RECENCY_PAIRS.length, recentFirst: mean(firsts), notes };
  } finally {
    memory.close();
  }
}

describe("memory retrieval evaluation", () => {
  const result = evaluate();
  const recency = evaluateRecency();

  it("prints the scoreboard", () => {
    const row = (name: string, n: number, cells: string) => `${name.padEnd(11)} ${String(n).padStart(2)}  ${cells}`;
    const lines = [
      "",
      `Memory retrieval scoreboard (${CORPUS.length} memories, ${CASES.length + RECENCY_PAIRS.length} queries, k=${K})`,
      "category    n   metrics",
      row("lexical", result.lexical.n, `recall@${K} ${fixed(result.lexical.recall)}  precision ${fixed(result.lexical.precision)}`),
      row("identifier", result.identifier.n, `recall@${K} ${fixed(result.identifier.recall)}  precision ${fixed(result.identifier.precision)}`),
      row("generic", result.generic.n, `silence(assembler) ${fixed(result.generic.silence)}`),
      row("unrelated", result.unrelated.n, `silence(search) ${fixed(result.unrelated.silenceSearch)}  silence(assembler) ${fixed(result.unrelated.silenceAssembler)}`),
      row("recency", recency.n, `recent-first ${fixed(recency.recentFirst)}`),
      row("paraphrase", result.paraphrase.n, `recall@${K} ${fixed(result.paraphrase.recall)}  precision ${fixed(result.paraphrase.precision)}  (known gap, informational)`),
      ...(result.notes.length + recency.notes.length > 0 ? ["imperfect cases:", ...[...result.notes, ...recency.notes].map((note) => `  - ${note}`)] : []),
    ];
    console.log(lines.join("\n"));
    expect(CASES.length).toBeGreaterThanOrEqual(35);
  });

  it("keeps lexical and identifier recall and precision at the baseline", () => {
    expect(result.lexical.recall).toBeGreaterThanOrEqual(THRESHOLDS.lexical.recall);
    expect(result.lexical.precision).toBeGreaterThanOrEqual(THRESHOLDS.lexical.precision);
    expect(result.identifier.recall).toBeGreaterThanOrEqual(THRESHOLDS.identifier.recall);
    expect(result.identifier.precision).toBeGreaterThanOrEqual(THRESHOLDS.identifier.precision);
  });

  it("stays silent for generic and unrelated prompts", () => {
    expect(result.generic.silence).toBeGreaterThanOrEqual(THRESHOLDS.generic.silence);
    expect(result.unrelated.silenceSearch).toBeGreaterThanOrEqual(THRESHOLDS.unrelated.silenceSearch);
    expect(result.unrelated.silenceAssembler).toBeGreaterThanOrEqual(THRESHOLDS.unrelated.silenceAssembler);
  });

  it("ranks the recent fact before the equally matching old one", () => {
    expect(recency.recentFirst).toBeGreaterThanOrEqual(THRESHOLDS.recency.recentFirst);
  });

  it("records the paraphrase recall that would justify adopting embeddings", () => {
    // Informational: no floor. Lexical search cannot bridge synonyms ("pet" vs
    // "cachorro"); a low value here is the known gap, not a regression.
    expect(result.paraphrase.recall).toBeGreaterThanOrEqual(0);
    expect(result.paraphrase.recall).toBeLessThanOrEqual(1);
  });
});
