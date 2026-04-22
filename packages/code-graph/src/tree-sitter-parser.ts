import { createRequire } from 'module';
import path from 'path';
import type { CodeSymbol } from './types.js';

const _require = createRequire(import.meta.url);

interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
}

interface TSTree {
  rootNode: TSNode;
}

interface TSParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TSTree;
}

interface ParserCtor {
  new (): TSParser;
}

type Lang = 'python' | 'rust' | 'go';

const langModules: Record<Lang, string> = {
  python: 'tree-sitter-python',
  rust: 'tree-sitter-rust',
  go: 'tree-sitter-go',
};

let parserCtor: ParserCtor | null = null;
const cachedParsers = new Map<Lang, TSParser>();
let initFailed = false;

function getParser(lang: Lang): TSParser | null {
  if (initFailed) return null;
  const cached = cachedParsers.get(lang);
  if (cached) return cached;

  try {
    if (!parserCtor) {
      parserCtor = _require('tree-sitter') as ParserCtor;
    }
    const language = _require(langModules[lang]) as unknown;
    const p = new parserCtor();
    p.setLanguage(language);
    cachedParsers.set(lang, p);
    return p;
  } catch {
    initFailed = true;
    return null;
  }
}

export function detectLang(filePath: string): Lang | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  return null;
}

export function parseWithTreeSitter(filePath: string, source: string): CodeSymbol[] | null {
  const lang = detectLang(filePath);
  if (!lang) return null;
  const parser = getParser(lang);
  if (!parser) return null;

  const tree = parser.parse(source);
  const symbols: CodeSymbol[] = [];

  switch (lang) {
    case 'python':
      collectPython(tree.rootNode, filePath, symbols);
      break;
    case 'rust':
      collectRust(tree.rootNode, filePath, symbols);
      break;
    case 'go':
      collectGo(tree.rootNode, filePath, symbols);
      break;
  }

  return symbols;
}

function pushSymbol(
  symbols: CodeSymbol[],
  node: TSNode,
  name: string,
  kind: CodeSymbol['kind'],
  filePath: string,
  textLimit = 800,
): void {
  symbols.push({
    name,
    kind,
    filePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    text: node.text.slice(0, textLimit),
  });
}

function walk(node: TSNode, fn: (n: TSNode) => boolean | void): void {
  // Returning `true` from fn means "don't recurse into this subtree"
  const stop = fn(node);
  if (stop) return;
  for (const child of node.namedChildren) walk(child, fn);
}

function collectPython(root: TSNode, filePath: string, out: CodeSymbol[]): void {
  walk(root, node => {
    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        pushSymbol(
          out,
          node,
          name,
          node.type === 'class_definition' ? 'class' : 'function',
          filePath,
        );
      }
    }
  });
}

function collectRust(root: TSNode, filePath: string, out: CodeSymbol[]): void {
  walk(root, node => {
    switch (node.type) {
      case 'function_item': {
        const name = node.childForFieldName('name')?.text;
        if (name) pushSymbol(out, node, name, 'function', filePath);
        return;
      }
      case 'struct_item':
      case 'union_item': {
        const name = node.childForFieldName('name')?.text;
        if (name) pushSymbol(out, node, name, 'class', filePath);
        return;
      }
      case 'enum_item': {
        const name = node.childForFieldName('name')?.text;
        if (name) pushSymbol(out, node, name, 'type', filePath, 400);
        return;
      }
      case 'trait_item': {
        const name = node.childForFieldName('name')?.text;
        if (name) pushSymbol(out, node, name, 'interface', filePath);
        return;
      }
      case 'type_item': {
        const name = node.childForFieldName('name')?.text;
        if (name) pushSymbol(out, node, name, 'type', filePath, 400);
        return;
      }
      case 'impl_item': {
        // Don't synthesize a symbol for the impl block itself, but recurse
        // so the methods inside become functions.
        return;
      }
    }
  });
}

function collectGo(root: TSNode, filePath: string, out: CodeSymbol[]): void {
  walk(root, node => {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) pushSymbol(out, node, name, 'function', filePath);
      return;
    }
    if (node.type === 'type_spec') {
      const name = node.childForFieldName('name')?.text;
      const typeNode = node.childForFieldName('type');
      if (!name) return;
      let kind: CodeSymbol['kind'] = 'type';
      if (typeNode?.type === 'struct_type') kind = 'class';
      else if (typeNode?.type === 'interface_type') kind = 'interface';
      pushSymbol(out, node, name, kind, filePath, 400);
      return;
    }
  });
}
