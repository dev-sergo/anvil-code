/**
 * Tolerant JSON parsing for LLM output. Tries strict `JSON.parse` first, then a
 * pipeline of small targeted fixes for the most common ways LLMs mangle JSON.
 *
 * Returns the parsed value plus the list of fixes that had to be applied so the
 * caller can log telemetry (frequent repairs hint that a prompt needs tightening).
 */

export type RepairResult<T> =
  | { ok: true; value: T; fixes: string[] }
  | { ok: false; error: string; tried: string[] };

interface Fixer {
  name: string;
  apply(input: string): string;
}

/** Strip a leading UTF-8 BOM and surrounding whitespace. */
const trimAndDeBom: Fixer = {
  name: 'trim+bom',
  apply: s => s.replace(/^﻿/, '').trim(),
};

/** Strip a markdown ```json ... ``` (or plain ``` ... ```) fence. */
const stripCodeFence: Fixer = {
  name: 'strip-code-fence',
  apply: s => {
    let out = s;
    if (out.startsWith('```')) {
      const firstNl = out.indexOf('\n');
      if (firstNl >= 0) out = out.slice(firstNl + 1);
      else out = out.replace(/^```(?:json)?/i, '');
    }
    if (out.endsWith('```')) out = out.slice(0, -3);
    return out.trim();
  },
};

/**
 * Slice from the first `{` or `[` to its matching closer, ignoring quoted strings
 * and escapes. Drops whatever prose the model wrapped around the JSON.
 */
const extractFirstJsonValue: Fixer = {
  name: 'extract-first-json-value',
  apply: s => {
    let start = -1;
    let opener: '{' | '[' | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{' || c === '[') {
        start = i;
        opener = c;
        break;
      }
    }
    if (start < 0 || !opener) return s;
    const closer = opener === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === opener) depth++;
      else if (c === closer) {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    // Unterminated — return what we have, parser will surface a clearer error
    return s.slice(start);
  },
};

// Strip line and block comments that appear outside of string literals.
const stripComments: Fixer = {
  name: 'strip-comments',
  apply: s => {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        out += c;
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === '/' && s[i + 1] === '/') {
        const nl = s.indexOf('\n', i + 2);
        i = nl < 0 ? s.length : nl - 1;
        continue;
      }
      if (c === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2);
        i = end < 0 ? s.length : end + 1;
        continue;
      }
      out += c;
    }
    return out;
  },
};

// Remove a comma immediately before a closing brace or bracket.
const stripTrailingCommas: Fixer = {
  name: 'strip-trailing-commas',
  apply: s => {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        out += c;
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === ',') {
        // Look ahead past whitespace for the next non-space char
        let j = i + 1;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
        if (s[j] === '}' || s[j] === ']') continue; // drop the comma
      }
      out += c;
    }
    return out;
  },
};

/**
 * Escape literal newlines and tabs that appear *inside* string literals — a common
 * mistake when LLMs emit multi-line strings without escaping.
 */
const escapeControlInStrings: Fixer = {
  name: 'escape-control-in-strings',
  apply: s => {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!inString) {
        if (c === '"') inString = true;
        out += c;
        continue;
      }
      if (escape) { out += c; escape = false; continue; }
      if (c === '\\') { out += c; escape = true; continue; }
      if (c === '"') { out += c; inString = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
    }
    return out;
  },
};

// Order matters: later fixers see the output of earlier ones. Each fixer is safe
// to run on already-valid JSON (mostly idempotent) so we can stack them freely.
const FIXERS: Fixer[] = [
  trimAndDeBom,
  stripCodeFence,
  extractFirstJsonValue,
  stripComments,
  stripTrailingCommas,
  escapeControlInStrings,
];

export function tryParseJsonTolerant<T>(raw: string): RepairResult<T> {
  // 1. Strict path
  try {
    return { ok: true, value: JSON.parse(raw) as T, fixes: [] };
  } catch { /* fall through */ }

  // 2. Apply fixers cumulatively, reparsing after each — return as soon as one works.
  let current = raw;
  const applied: string[] = [];
  let lastError = 'unknown';
  for (const fixer of FIXERS) {
    const next = fixer.apply(current);
    if (next === current) continue;
    current = next;
    applied.push(fixer.name);
    try {
      return { ok: true, value: JSON.parse(current) as T, fixes: applied };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError, tried: applied };
}
