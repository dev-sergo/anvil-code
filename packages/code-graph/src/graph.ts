import fs from 'fs';
import path from 'path';
import { config, logger } from '@rag-system/shared';
import { ASTParser } from './parser.js';
import type { CodeSymbol } from './types.js';

interface GraphData {
  symbols: Record<string, CodeSymbol[]>;
  savedAt: string;
}

export class CodeGraph {
  private symbols: Map<string, CodeSymbol[]> = new Map();
  private parser = new ASTParser();
  private graphsDir: string;
  // v1.43 — reverse dependency index: depName → Set of symbolNames that reference it.
  // Enables 2-hop retrieval: given a retrieved symbol, surface other symbols that USE it
  // (callers) so Coder sees the usage context alongside the definition. Rebuilt lazily
  // on loadFromDisk and maintained incrementally on addFile/removeFile.
  private reverseIndex: Map<string, Set<string>> = new Map();

  constructor(graphsDir?: string) {
    this.graphsDir = path.resolve(graphsDir ?? config.rag.graphsPath);
  }

  addFile(filePath: string, symbols: CodeSymbol[]): void {
    // Remove stale reverse-index entries for the previous version of this file.
    const previous = this.symbols.get(filePath) ?? [];
    for (const sym of previous) {
      for (const dep of this.parser.extractDependencies(sym)) {
        this.reverseIndex.get(dep)?.delete(sym.name);
      }
    }
    this.symbols.set(filePath, symbols);
    // Add new entries.
    for (const sym of symbols) {
      for (const dep of this.parser.extractDependencies(sym)) {
        if (!this.reverseIndex.has(dep)) this.reverseIndex.set(dep, new Set());
        this.reverseIndex.get(dep)!.add(sym.name);
      }
    }
  }

  removeFile(filePath: string): void {
    const previous = this.symbols.get(filePath) ?? [];
    for (const sym of previous) {
      for (const dep of this.parser.extractDependencies(sym)) {
        this.reverseIndex.get(dep)?.delete(sym.name);
      }
    }
    this.symbols.delete(filePath);
  }

  // v1.43 — return symbols that reference `symbolName` in their body text.
  // Used by 2-hop retrieval to surface callers/users of a retrieved symbol.
  getCallers(symbolName: string): CodeSymbol[] {
    const callerNames = this.reverseIndex.get(symbolName) ?? new Set();
    const callers: CodeSymbol[] = [];
    for (const name of callerNames) {
      const sym = this.getSymbol(name);
      if (sym && sym.name !== symbolName) callers.push(sym);
    }
    return callers;
  }

  // v1.46 — BFS over the reverse index up to `maxHops` levels. Returns all
  // symbols that transitively reference any name in `seeds`, deduplicating
  // against `seen` (modified in-place so the caller can track across calls).
  // Callers-of-callers surfaces the full cross-service callsite graph without
  // an O(n²) scan — the reverse index makes each level O(callers).
  getTransitiveCallers(
    seeds: string[],
    maxHops: number,
    seen: Set<string>,
  ): CodeSymbol[] {
    const result: CodeSymbol[] = [];
    // Seeds are the expansion roots — we want their callers, not the seeds
    // themselves. Start frontier from seeds regardless of seen-status; seen
    // is checked for the CALLERS we discover, not the seeds we expand from.
    let frontier = [...seeds];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        const callers = this.getCallers(name);
        for (const caller of callers) {
          if (seen.has(caller.name)) continue;
          seen.add(caller.name);
          result.push(caller);
          nextFrontier.push(caller.name);
        }
      }
      frontier = nextFrontier;
    }
    return result;
  }

  getByFile(filePath: string): CodeSymbol[] {
    return this.symbols.get(filePath) ?? [];
  }

  getSymbol(name: string): CodeSymbol | undefined {
    for (const syms of this.symbols.values()) {
      const found = syms.find(s => s.name === name);
      if (found) return found;
    }
    return undefined;
  }

  getDependencies(symbolName: string): CodeSymbol[] {
    const sym = this.getSymbol(symbolName);
    if (!sym) return [];

    const depNames = this.parser.extractDependencies(sym);
    const deps: CodeSymbol[] = [];

    for (const name of depNames) {
      const dep = this.getSymbol(name);
      if (dep && dep.name !== symbolName) deps.push(dep);
    }
    return deps;
  }

  getAll(): CodeSymbol[] {
    return [...this.symbols.values()].flat();
  }

  async saveToDisk(): Promise<void> {
    fs.mkdirSync(this.graphsDir, { recursive: true });
    const graphPath = path.join(this.graphsDir, 'graph.json');
    const data: GraphData = {
      symbols: Object.fromEntries(this.symbols),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(graphPath, JSON.stringify(data), 'utf8');
    logger.debug({ symbols: this.getAll().length }, 'Code graph saved');
  }

  async loadFromDisk(): Promise<void> {
    const graphPath = path.join(this.graphsDir, 'graph.json');
    if (!fs.existsSync(graphPath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as GraphData;
      this.symbols = new Map(Object.entries(data.symbols));
      this.rebuildReverseIndex();
      logger.info({ symbols: this.getAll().length, savedAt: data.savedAt }, 'Code graph loaded from disk');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Failed to load code graph, starting fresh');
    }
  }

  private rebuildReverseIndex(): void {
    this.reverseIndex.clear();
    for (const syms of this.symbols.values()) {
      for (const sym of syms) {
        for (const dep of this.parser.extractDependencies(sym)) {
          if (!this.reverseIndex.has(dep)) this.reverseIndex.set(dep, new Set());
          this.reverseIndex.get(dep)!.add(sym.name);
        }
      }
    }
  }
}
