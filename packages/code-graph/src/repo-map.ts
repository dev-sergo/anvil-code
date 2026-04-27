import path from 'path';
import { CodeGraph } from './graph.js';
import type { CodeSymbol } from './types.js';

/**
 * Repo-map — compact "what exists" sketch of the project. Every symbol the AST
 * indexer captured is rendered with its declaration signature (no body), grouped
 * by file. The model uses this to navigate without hallucinating: if a method
 * isn't in the map, it doesn't exist (or wasn't indexed — but that's the same
 * outcome from the model's POV).
 *
 * Output looks like:
 *
 *   src/services/user-service.ts:
 *     class UserService:
 *       static list(): User[]
 *       static get(id: string): User | null
 *
 *   src/types.ts:
 *     interface User:
 *       id: string
 *       name: string
 */

const DEFAULT_MAX_BYTES = 6000;
const SIGNATURE_LINE_MAX = 120;
const MAX_MEMBERS_PER_SYMBOL = 30;

const CONTROL_FLOW_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'throw', 'await', 'new', 'typeof',
  'in', 'of', 'do', 'try', 'catch', 'finally', 'else', 'case', 'break', 'continue',
]);

export interface RepoMapOptions {
  /** Hard cap on the rendered string length, in chars (≈ chars/4 tokens). */
  maxBytes?: number;
  /**
   * Files (relative paths) to render first and never truncate. Typically the
   * project's entry points and any files just modified by previous steps.
   */
  highlightFiles?: string[];
}

/**
 * Build a compact textual map of the project, suitable for embedding into agent
 * prompts. Pure function over a CodeGraph snapshot — does not touch disk.
 */
export function buildRepoMap(
  graph: CodeGraph,
  projectRoot: string,
  opts: RepoMapOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const highlightRel = (opts.highlightFiles ?? []).map(p => toRelative(p, projectRoot));
  const highlightSet = new Set(highlightRel);

  // Group symbols by relative path. Skip the empty-name entries that some
  // tree-sitter parsers can emit for malformed declarations.
  const byFile = new Map<string, CodeSymbol[]>();
  for (const sym of graph.getAll()) {
    if (!sym.name) continue;
    const rel = toRelative(sym.filePath, projectRoot);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(sym);
  }
  if (byFile.size === 0) return '';

  // Render every file once.
  const rendered = new Map<string, string>();
  for (const [rel, syms] of byFile) {
    syms.sort((a, b) => a.startLine - b.startLine);
    rendered.set(rel, renderFile(rel, syms));
  }

  // Highlight files first, in caller-supplied order; the rest alphabetic.
  const head: string[] = [];
  for (const hp of highlightRel) {
    const r = rendered.get(hp);
    if (r !== undefined) {
      head.push(r);
      rendered.delete(hp);
    }
  }
  const tail = Array.from(rendered.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

  // Greedy fill: highlight entries are always rendered (budget can be exceeded
  // by them on purpose — they're the load-bearing context). Tail entries are
  // dropped once the budget is gone.
  const parts: string[] = [];
  let total = 0;
  for (const r of head) {
    parts.push(r);
    total += r.length + 2;
  }
  let truncated = 0;
  for (const r of tail) {
    if (total + r.length + 2 > maxBytes) {
      truncated++;
      continue;
    }
    parts.push(r);
    total += r.length + 2;
  }
  if (truncated > 0) {
    parts.push(`// ... (${truncated} more file${truncated === 1 ? '' : 's'} omitted to fit token budget)`);
  }

  return parts.join('\n\n');
}

function renderFile(relPath: string, syms: CodeSymbol[]): string {
  const lines: string[] = [`${relPath}:`];
  for (const sym of syms) {
    const headerLine = headerFor(sym);
    if (sym.kind === 'class' || sym.kind === 'variable') {
      const members = extractMethodSignatures(sym.text);
      if (members.length > 0) {
        lines.push(`  ${headerLine}:`);
        for (const m of members.slice(0, MAX_MEMBERS_PER_SYMBOL)) {
          lines.push(`    ${truncate(m, SIGNATURE_LINE_MAX)}`);
        }
        if (members.length > MAX_MEMBERS_PER_SYMBOL) {
          lines.push(`    // ... (${members.length - MAX_MEMBERS_PER_SYMBOL} more)`);
        }
      } else {
        lines.push(`  ${headerLine}`);
      }
    } else if (sym.kind === 'interface') {
      const members = extractInterfaceMembers(sym.text);
      if (members.length > 0) {
        lines.push(`  ${headerLine}:`);
        for (const m of members.slice(0, MAX_MEMBERS_PER_SYMBOL)) {
          lines.push(`    ${truncate(m, SIGNATURE_LINE_MAX)}`);
        }
        if (members.length > MAX_MEMBERS_PER_SYMBOL) {
          lines.push(`    // ... (${members.length - MAX_MEMBERS_PER_SYMBOL} more)`);
        }
      } else {
        lines.push(`  ${headerLine}`);
      }
    } else {
      lines.push(`  ${headerLine}`);
    }
  }
  return lines.join('\n');
}

/**
 * Single-line declaration signature from CodeSymbol.text. Works on a "first line
 * up to brace" basis — robust enough for ~95% of TS declarations the AST parser
 * captures, without needing a second AST walk.
 */
function headerFor(sym: CodeSymbol): string {
  if (sym.kind === 'variable') {
    // For `export const X = { ... }` style symbols, render an opaque header —
    // the methods underneath will tell the reader what's actually inside.
    return `const ${sym.name}`;
  }

  const firstLine = sym.text.split(/\r?\n/)[0] ?? '';
  const stripped = firstLine.replace(/^\s*(export\s+default\s+|export\s+|declare\s+)/, '');
  const beforeBrace = stripped.split('{')[0].trim();
  const cleaned = beforeBrace.replace(/\s+/g, ' ');
  return truncate(cleaned, SIGNATURE_LINE_MAX);
}

/**
 * Pull method-like declarations out of a class body or top-level object literal.
 * We deliberately avoid re-running the AST parser — text is already sliced to
 * 800 chars and the simple regex below has a low false-positive rate when
 * filtered through `CONTROL_FLOW_KEYWORDS`.
 */
function extractMethodSignatures(text: string): string[] {
  const openIdx = text.indexOf('{');
  if (openIdx === -1) return [];
  const body = text.slice(openIdx + 1);

  // Match: optional modifiers, identifier, paren args, optional return annotation.
  // Stops at `{` (method body) or `;` (interface-style or arrow). Does not try
  // to handle multi-line param lists — we just take the first line of the match.
  const methodRe =
    /(?:^|\n)[ \t]*((?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?::\s*([^{;\n]+))?/g;

  const sigs: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(body)) !== null) {
    const mods = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    const name = match[2];
    const params = match[3].replace(/\s+/g, ' ').trim();
    const ret = (match[4] ?? '').trim();

    if (CONTROL_FLOW_KEYWORDS.has(name)) continue;

    let sig = mods ? `${mods} ${name}(${params})` : `${name}(${params})`;
    if (ret) sig += `: ${ret}`;

    if (seen.has(sig)) continue;
    seen.add(sig);
    sigs.push(sig);
  }
  return sigs;
}

function extractInterfaceMembers(text: string): string[] {
  const openIdx = text.indexOf('{');
  if (openIdx === -1) return [];
  const closeIdx = text.lastIndexOf('}');
  const body = text.slice(openIdx + 1, closeIdx === -1 ? undefined : closeIdx);

  return body
    .split(/[;\n]/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0 && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*'));
}

function toRelative(p: string, projectRoot: string): string {
  const normalized = path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
  return normalized.split(path.sep).join('/');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
