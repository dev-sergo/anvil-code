import { describe, it, expect } from 'vitest';
import { tryParseJsonTolerant } from '../json-repair.js';

function expectOk<T>(raw: string): { value: T; fixes: string[] } {
  const r = tryParseJsonTolerant<T>(raw);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}; tried: ${r.tried.join(',')}`);
  return r;
}

describe('tryParseJsonTolerant', () => {
  it('returns the value with no fixes for already-valid JSON', () => {
    const r = expectOk<{ a: number }>('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.fixes).toEqual([]);
  });

  it('strips a ```json fence', () => {
    const r = expectOk<{ steps: number[] }>('```json\n{"steps":[1,2,3]}\n```');
    expect(r.value).toEqual({ steps: [1, 2, 3] });
    expect(r.fixes).toContain('strip-code-fence');
  });

  it('strips a plain ``` fence', () => {
    const r = expectOk<{ x: string }>('```\n{"x":"y"}\n```');
    expect(r.value).toEqual({ x: 'y' });
    expect(r.fixes).toContain('strip-code-fence');
  });

  it('extracts the JSON object from surrounding prose', () => {
    const raw = `Sure! Here's the plan you asked for:\n\n{"steps":[{"id":"1"}]}\n\nLet me know if you need changes.`;
    const r = expectOk<{ steps: { id: string }[] }>(raw);
    expect(r.value.steps[0].id).toBe('1');
    expect(r.fixes).toContain('extract-first-json-value');
  });

  it('extracts a JSON array from prose', () => {
    const raw = `Output: [1, 2, 3] (these are the indices)`;
    const r = expectOk<number[]>(raw);
    expect(r.value).toEqual([1, 2, 3]);
  });

  it('drops trailing commas before } and ]', () => {
    const r = expectOk<{ items: number[] }>('{"items":[1,2,3,],}');
    expect(r.value).toEqual({ items: [1, 2, 3] });
    expect(r.fixes).toContain('strip-trailing-commas');
  });

  it('strips // line comments outside strings', () => {
    const raw = `{
      "name": "foo", // the human-readable label
      "count": 3
    }`;
    const r = expectOk<{ name: string; count: number }>(raw);
    expect(r.value).toEqual({ name: 'foo', count: 3 });
  });

  it('strips block comments outside strings', () => {
    const r = expectOk<{ a: number }>('{ /* leading */ "a": 1 /* trailing */ }');
    expect(r.value).toEqual({ a: 1 });
  });

  it('does not strip // that appears inside a string value', () => {
    const r = expectOk<{ url: string }>('{"url":"http://x/y"}');
    expect(r.value.url).toBe('http://x/y');
    expect(r.fixes).toEqual([]); // strict parse handles it; no repair needed
  });

  it('escapes literal newlines inside string values', () => {
    // Raw newline inside the string makes strict JSON.parse fail
    const raw = `{"body":"line1\nline2\nline3"}`;
    const r = expectOk<{ body: string }>(raw);
    expect(r.value.body).toBe('line1\nline2\nline3');
    expect(r.fixes).toContain('escape-control-in-strings');
  });

  it('handles a code-fence + trailing comma + prose combination', () => {
    const raw = `Here you go:\n\n\`\`\`json\n{"items":[1,2,],}\n\`\`\`\n\nGood luck!`;
    const r = expectOk<{ items: number[] }>(raw);
    expect(r.value).toEqual({ items: [1, 2] });
    // At least these two repairs must have run
    expect(r.fixes.length).toBeGreaterThanOrEqual(2);
  });

  it('reports failure when no repair recovers the JSON', () => {
    const r = tryParseJsonTolerant('this is not json at all, just plain prose');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeTruthy();
    }
  });

  it('does not greedily slice past the matching closer', () => {
    // Two objects in prose — should pick only the first
    const r = expectOk<{ x: number }>('first: {"x":1} second: {"x":2}');
    expect(r.value).toEqual({ x: 1 });
  });

  it('respects nested braces inside strings when extracting', () => {
    const raw = `Note: the regex is {"pattern":"^\\\\{[a-z]+\\\\}$"}`;
    const r = expectOk<{ pattern: string }>(raw);
    expect(r.value.pattern).toBe('^\\{[a-z]+\\}$');
  });

  it('strips a UTF-8 BOM', () => {
    const r = expectOk<{ a: number }>('﻿{"a":1}');
    expect(r.value).toEqual({ a: 1 });
  });
});
