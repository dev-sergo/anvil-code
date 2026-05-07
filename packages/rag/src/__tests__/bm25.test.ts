import { describe, it, expect, beforeEach } from 'vitest';
import { BM25Index } from '../bm25.js';

describe('BM25Index — core', () => {
  let idx: BM25Index;

  beforeEach(() => {
    idx = new BM25Index();
  });

  it('size reflects add/remove', () => {
    expect(idx.size).toBe(0);
    idx.add('a', 'hello world');
    idx.add('b', 'foo bar');
    expect(idx.size).toBe(2);
    idx.remove('a');
    expect(idx.size).toBe(1);
  });

  it('exact symbol-name match scores highest', () => {
    idx.add('server', 'function server server server src server ts app listen');
    idx.add('userService', 'class userService createUser findUser');
    idx.add('router', 'function router route handler middleware');

    const results = idx.search('server', 3);
    expect(results[0].id).toBe('server');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('path component match — "server" query hits symbol in server.ts', () => {
    // Corpus includes path components: "src", "server", "ts"
    idx.add('listenFn', 'src server ts function listenFn port callback');
    idx.add('createUser', 'src users ts function createUser name email');
    idx.add('handleError', 'src middleware ts function handleError err next');

    const results = idx.search('server', 3);
    expect(results[0].id).toBe('listenFn');
  });

  it('returns empty array on empty index', () => {
    expect(idx.search('anything', 5)).toEqual([]);
  });

  it('returns empty array when query tokens have no match', () => {
    idx.add('a', 'hello world foo bar');
    expect(idx.search('zzznomatch', 5)).toEqual([]);
  });

  it('remove — symbol does not appear in results after removal', () => {
    idx.add('target', 'server server server src server ts listen port');
    idx.add('other', 'function other helper utility');

    const before = idx.search('server', 5);
    expect(before.some(r => r.id === 'target')).toBe(true);

    idx.remove('target');
    const after = idx.search('server', 5);
    expect(after.some(r => r.id === 'target')).toBe(false);
  });

  it('remove then re-add restores document', () => {
    idx.add('a', 'alpha beta gamma');
    idx.remove('a');
    idx.add('a', 'alpha beta gamma');
    expect(idx.size).toBe(1);
    expect(idx.search('alpha', 1)[0]?.id).toBe('a');
  });

  it('topK limits result count', () => {
    for (let i = 0; i < 10; i++) idx.add(`doc${i}`, `term${i} shared shared`);
    expect(idx.search('shared', 3).length).toBeLessThanOrEqual(3);
  });

  it('higher term frequency → higher score within same document length', () => {
    idx.add('heavy', 'server server server server server misc code');
    idx.add('light', 'server misc misc misc misc misc misc');

    const results = idx.search('server', 2);
    expect(results[0].id).toBe('heavy');
  });

  it('tokenization ignores tokens shorter than 2 chars', () => {
    // "a", "I", "." should be filtered
    idx.add('sym', 'a I . function myFunction body code');
    const results = idx.search('myfunction', 1);
    expect(results[0]?.id).toBe('sym');
  });

  it('tokenization is case-insensitive', () => {
    idx.add('sym', 'UserService CreateUser FindUser');
    const results = idx.search('userservice', 1);
    expect(results[0]?.id).toBe('sym');
  });
});

describe('BM25Index.rrf — Reciprocal Rank Fusion', () => {
  it('item in both lists ranks above items in one list only', () => {
    const dense = ['a', 'b', 'c'];
    const bm25  = ['d', 'a', 'e'];
    const merged = BM25Index.rrf(dense, bm25);
    // 'a' appears at rank 1 in dense and rank 2 in bm25 → should rank first
    expect(merged[0]).toBe('a');
  });

  it('deduplicates — each id appears exactly once', () => {
    const dense = ['a', 'b', 'c'];
    const bm25  = ['b', 'a', 'd'];
    const merged = BM25Index.rrf(dense, bm25);
    expect(new Set(merged).size).toBe(merged.length);
    expect(merged.length).toBe(4);
  });

  it('handles empty lists gracefully', () => {
    expect(BM25Index.rrf([], [])).toEqual([]);
    expect(BM25Index.rrf(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(BM25Index.rrf([], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('position matters — earlier rank contributes more', () => {
    // 'a' at dense[0], 'b' at dense[1]; both only in dense
    const merged = BM25Index.rrf(['a', 'b'], []);
    expect(merged[0]).toBe('a');
    expect(merged[1]).toBe('b');
  });

  it('custom k parameter changes scores but not relative order of dominant item', () => {
    const dense = ['a', 'b'];
    const bm25  = ['a', 'c'];
    const merged10 = BM25Index.rrf(dense, bm25, 10);
    const merged60 = BM25Index.rrf(dense, bm25, 60);
    // 'a' is top in both k values
    expect(merged10[0]).toBe('a');
    expect(merged60[0]).toBe('a');
  });
});
