import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import type { CodeSymbol } from './types.js';
import { parseWithTreeSitter, detectLang } from './tree-sitter-parser.js';

const TS_KEYWORDS = new Set([
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
  'object', 'symbol', 'bigint', 'true', 'false', 'this', 'super', 'new', 'typeof',
  'instanceof', 'in', 'of', 'as', 'is', 'return', 'const', 'let', 'var', 'function',
  'class', 'interface', 'type', 'enum', 'import', 'export', 'from', 'default', 'extends',
  'implements', 'static', 'public', 'private', 'protected', 'readonly', 'abstract',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'delete', 'yield', 'module', 'namespace',
  'declare', 'require', 'Promise', 'Array', 'Map', 'Set', 'Error', 'console', 'process',
  'Buffer', 'Date', 'JSON', 'Math', 'Object', 'Record', 'Partial', 'Required', 'Readonly',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters',
  'ConstructorParameters', 'InstanceType',
]);

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class ASTParser {
  parseFile(filePath: string): CodeSymbol[] {
    if (!fs.existsSync(filePath)) return [];

    const ext = path.extname(filePath).toLowerCase();
    const source = fs.readFileSync(filePath, 'utf8');

    if (detectLang(filePath)) {
      return parseWithTreeSitter(filePath, source) ?? [];
    }
    if (!TS_EXTENSIONS.has(ext)) return [];

    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const symbols: CodeSymbol[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        symbols.push({
          name: node.name.text,
          kind: 'function',
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          text: node.getText(sourceFile).slice(0, 800),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        symbols.push({
          name: node.name.text,
          kind: 'class',
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          text: node.getText(sourceFile).slice(0, 800),
        });
      } else if (ts.isInterfaceDeclaration(node)) {
        const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        symbols.push({
          name: node.name.text,
          kind: 'interface',
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          text: node.getText(sourceFile).slice(0, 800),
        });
      } else if (ts.isTypeAliasDeclaration(node)) {
        const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        symbols.push({
          name: node.name.text,
          kind: 'type',
          filePath,
          startLine: startLine + 1,
          endLine: endLine + 1,
          text: node.getText(sourceFile).slice(0, 400),
        });
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return symbols;
  }

  extractDependencies(symbol: CodeSymbol): string[] {
    if (!symbol.text) return [];
    const identifiers = symbol.text.match(/\b[A-Z][a-zA-Z0-9]+\b/g) ?? [];
    return [...new Set(identifiers)].filter(id => !TS_KEYWORDS.has(id) && id !== symbol.name);
  }
}
