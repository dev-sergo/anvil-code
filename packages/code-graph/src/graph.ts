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

  constructor(graphsDir?: string) {
    this.graphsDir = path.resolve(graphsDir ?? config.rag.graphsPath);
  }

  addFile(filePath: string, symbols: CodeSymbol[]): void {
    this.symbols.set(filePath, symbols);
  }

  removeFile(filePath: string): void {
    this.symbols.delete(filePath);
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
      logger.info({ symbols: this.getAll().length, savedAt: data.savedAt }, 'Code graph loaded from disk');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Failed to load code graph, starting fresh');
    }
  }
}
