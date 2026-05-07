/**
 * v1.34 — Pure-TypeScript BM25 index for hybrid search.
 *
 * Used alongside HNSW dense search: BM25 finds exact token matches (symbol
 * names, path components) that semantic embeddings miss when vocabulary gap
 * is wide. RRF merges both ranked lists before the reranker step.
 *
 * Parameters: k1=1.5, b=0.75 (Robertson & Zaragoza 2009 recommended defaults).
 * RRF constant k=60 (Cormack et al. 2009).
 */

export interface BM25Result {
  id: string;
  score: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(t => t.length >= 2);
}

export class BM25Index {
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  // id → token array (as stored — not deduplicated, order preserves TF)
  private docs = new Map<string, string[]>();
  // term → number of documents containing the term
  private df = new Map<string, number>();
  private totalLen = 0;

  get size(): number {
    return this.docs.size;
  }

  private get avgDL(): number {
    return this.docs.size === 0 ? 1 : this.totalLen / this.docs.size;
  }

  add(id: string, text: string): void {
    if (this.docs.has(id)) this.remove(id);
    const tokens = tokenize(text);
    this.docs.set(id, tokens);
    this.totalLen += tokens.length;
    // Update document frequencies for each unique term in this doc
    for (const term of new Set(tokens)) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
  }

  remove(id: string): void {
    const tokens = this.docs.get(id);
    if (!tokens) return;
    this.totalLen -= tokens.length;
    for (const term of new Set(tokens)) {
      const count = (this.df.get(term) ?? 0) - 1;
      if (count <= 0) this.df.delete(term);
      else this.df.set(term, count);
    }
    this.docs.delete(id);
  }

  search(query: string, topK: number): BM25Result[] {
    if (this.docs.size === 0) return [];
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];

    const N = this.docs.size;
    const avgDL = this.avgDL;
    const scores = new Map<string, number>();

    for (const term of new Set(qTerms)) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;
      // Robertson-Spärck Jones IDF (smooth variant — never negative)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const [id, tokens] of this.docs) {
        let tf = 0;
        for (const t of tokens) if (t === term) tf++;
        if (tf === 0) continue;

        const dl = tokens.length;
        const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * dl / avgDL));
        scores.set(id, (scores.get(id) ?? 0) + idf * tfNorm);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, score]) => ({ id, score }));
  }

  /**
   * Reciprocal Rank Fusion — merges two ranked lists into one.
   * score(d) = Σ_list 1/(k + rank_in_list)  where k=60, rank is 1-indexed.
   * Documents that appear only in one list get 0 contribution from the other.
   * Returns ids sorted by descending RRF score.
   */
  static rrf(denseIds: string[], bm25Ids: string[], k = 60): string[] {
    const scores = new Map<string, number>();

    const add = (ids: string[]) => {
      ids.forEach((id, i) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
      });
    };

    add(denseIds);
    add(bm25Ids);

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }
}
