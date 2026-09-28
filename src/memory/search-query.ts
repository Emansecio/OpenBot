/**
 * Query side of the memory/history FTS5 indexes. The unicode61 tokenizer
 * folds case and diacritics but has no stopwords or stemming, so a raw
 * prompt ORs function words ("de", "que", "the") that match almost every
 * row. Queries keep only meaningful terms and match simple plurals.
 */

/** Folded (lower-case, no diacritics) function words of PT, EN and ES; terms under 3 letters are dropped anyway. */
const SEARCH_STOPWORDS = new Set([
  // pt
  "aos", "aquela", "aquele", "aquilo", "aqui", "algum", "alguma", "algumas", "alguns", "ainda", "agora", "ate",
  "cada", "com", "como", "coisa", "coisas", "contra", "das", "dela", "dele", "delas", "deles", "depois", "deve",
  "devo", "diga", "diz", "dos", "ela", "elas", "ele", "eles", "entao", "entre", "era", "essa", "essas", "esse",
  "esses", "esta", "estao", "estas", "estava", "este", "estes", "estou", "isso", "isto", "fale", "falar", "faz",
  "fazer", "foi", "lembra", "lembrar", "lembre", "lhe", "mais", "mas", "menos", "mesma", "mesmo", "meu", "meus",
  "mim", "minha", "minhas", "muita", "muitas", "muito", "muitos", "nada", "nao", "nas", "nem", "nos", "nossa",
  "nossas", "nosso", "nossos", "onde", "outra", "outras", "outro", "outros", "para", "pela", "pelas", "pelo",
  "pelos", "pode", "podemos", "porque", "posso", "pra", "pro", "qual", "quais", "quando", "que", "quem", "sabe",
  "saber", "sao", "sei", "sem", "ser", "seu", "seus", "sim", "sob", "sobre", "sou", "sua", "suas", "tambem",
  "tem", "temos", "tenho", "ter", "teu", "teus", "tinha", "toda", "todas", "todo", "todos", "tua", "tuas",
  "tudo", "uma", "umas", "uns", "vai", "voce", "voces", "vou",
  // en
  "about", "all", "and", "any", "are", "been", "but", "can", "could", "did", "does", "for", "from", "had",
  "has", "have", "hello", "her", "here", "him", "his", "how", "into", "its", "just", "know", "may", "might",
  "mine", "more", "most", "must", "not", "our", "please", "remember", "shall", "she", "should", "some", "tell",
  "than", "thanks", "that", "the", "their", "them", "then", "there", "these", "they", "thing", "things", "this",
  "those", "very", "was", "were", "what", "when", "where", "which", "who", "whom", "whose", "why", "will",
  "with", "would", "yes", "you", "your", "yours",
  // es
  "cual", "cuales", "del", "donde", "dime", "eso", "esos", "estan", "estoy", "gracias", "hay", "hola", "las",
  "los", "mis", "muy", "pero", "por", "recuerdas", "sabes", "sus", "tengo", "tiene", "tus", "una", "unos",
  "usted",
]);

export const MAX_SEARCH_TERMS = 16;

function foldTerm(term: string): string {
  return term.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase();
}

/**
 * One term per whitespace-separated chunk, folded. A chunk of several words
 * ("FAROL-731", "grok-4.6") stays one compound term, its words joined by "-",
 * and is searched as an exact phrase.
 */
function wordTerms(text: string): string[] {
  const terms = text.normalize("NFKC").split(/\s+/u).flatMap((chunk) => {
    // An apostrophe joins its word ("user's" -> "users") instead of making a compound.
    const words = [...chunk.replace(/['’]/gu, "").matchAll(/[\p{L}\p{N}]+/gu)].map((match) => foldTerm(match[0]));
    return words.length === 0 ? [] : [words.join("-")];
  });
  return [...new Set(terms)];
}

/** Folded terms of `text` that carry meaning: compounds, and words that are no stopword nor 1-2 letters (numbers of 2+ digits stay). */
export function significantSearchTerms(text: string, limit = MAX_SEARCH_TERMS): string[] {
  const terms: string[] = [];
  for (const term of wordTerms(text)) {
    const compound = term.includes("-");
    const numeric = /^\p{N}+$/u.test(term);
    if (!compound && (term.length < (numeric ? 2 : 3) || SEARCH_STOPWORDS.has(term))) continue;
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Single words of 4+ letters become prefix matches without a trailing plural "s": "cachorros" also finds "cachorro". */
function ftsTerm(term: string): string {
  if (term.includes("-")) return `"${term.replaceAll("-", " ")}"`;
  if (term.length < 4 || /^\p{N}+$/u.test(term)) return `"${term}"`;
  const stem = term.length >= 5 && term.endsWith("s") ? term.slice(0, -1) : term;
  return `"${stem}"*`;
}

/**
 * FTS5 MATCH expression for a free-text query. A query made only of function
 * words keeps them as exact terms, so an explicit search still finds them;
 * automatic retrieval checks {@link significantSearchTerms} first.
 */
export function ftsMatchExpression(query: string): string {
  const significant = significantSearchTerms(query);
  if (significant.length > 0) return significant.map(ftsTerm).join(" OR ");
  return wordTerms(query).slice(0, MAX_SEARCH_TERMS).map((term) => `"${term}"`).join(" OR ");
}
