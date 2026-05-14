import { describe, it, expect } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {
      ...actual.config,
      rag: { ...actual.config.rag, graphsPath: '/tmp/test-graphs' },
    },
  };
});

import { vi } from 'vitest';
const { CodeGraph } = await import('../graph.js');

const sym = (name: string, text: string, file = 'src/a.ts') => ({
  name,
  kind: 'function' as const,
  filePath: file,
  startLine: 1,
  endLine: 10,
  text,
  exportedNames: [name],
});

describe('CodeGraph reverse index (v1.43)', () => {
  it('getCallers returns symbols that reference the given name', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('DataLoader', 'function DataLoader() {}')]);
    g.addFile('src/b.ts', [sym('createClient', 'function createClient() { const dl = new DataLoader(); }')]);
    g.addFile('src/c.ts', [sym('runBatch', 'function runBatch() { DataLoader.batch(); }')]);

    const callers = g.getCallers('DataLoader');
    const callerNames = callers.map(c => c.name);
    expect(callerNames).toContain('createClient');
    expect(callerNames).toContain('runBatch');
  });

  it('getCallers excludes the symbol itself', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('Foo', 'function Foo() { return new Foo(); }')]);
    const callers = g.getCallers('Foo');
    expect(callers.every(c => c.name !== 'Foo')).toBe(true);
  });

  it('reverse index updates incrementally on addFile', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('Target', 'class Target {}')]);
    g.addFile('src/b.ts', [sym('User', 'class User { t = new Target(); }')]);
    expect(g.getCallers('Target').map(c => c.name)).toContain('User');

    // Replace file b with a version that no longer references Target
    g.addFile('src/b.ts', [sym('User', 'class User { x = 42; }')]);
    expect(g.getCallers('Target')).toHaveLength(0);
  });

  it('reverse index clears on removeFile', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('Alpha', 'class Alpha {}')]);
    g.addFile('src/b.ts', [sym('Beta', 'class Beta extends Alpha {}')]);
    expect(g.getCallers('Alpha').map(c => c.name)).toContain('Beta');

    g.removeFile('src/b.ts');
    expect(g.getCallers('Alpha')).toHaveLength(0);
  });

  it('returns empty array for symbol with no callers', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('Orphan', 'class Orphan {}')]);
    expect(g.getCallers('Orphan')).toHaveLength(0);
    expect(g.getCallers('NonExistent')).toHaveLength(0);
  });
});

describe('CodeGraph.getTransitiveCallers (v1.46)', () => {
  it('finds callers at hop 1 (same as getCallers)', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('Service', 'class Service {}')]);
    g.addFile('src/b.ts', [sym('Router', 'class Router { s = new Service(); }')]);

    const seen = new Set<string>(['Service']);
    const result = g.getTransitiveCallers(['Service'], 1, seen);
    expect(result.map(r => r.name)).toContain('Router');
  });

  it('finds callers-of-callers at hop 2', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('src/a.ts', [sym('UserService', 'class UserService {}')]);
    g.addFile('src/b.ts', [sym('UserRouter', 'function UserRouter() { return new UserService(); }')]);
    g.addFile('src/c.ts', [sym('App', 'function App() { UserRouter(); }')]);

    const seen = new Set<string>(['UserService']);
    const result = g.getTransitiveCallers(['UserService'], 2, seen);
    const names = result.map(r => r.name);
    expect(names).toContain('UserRouter'); // hop 1
    expect(names).toContain('App');        // hop 2
  });

  it('stops at maxHops boundary', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('a.ts', [sym('Alpha', 'class Alpha {}')]);
    g.addFile('b.ts', [sym('Beta', 'class Beta extends Alpha {}')]);
    g.addFile('c.ts', [sym('Gamma', 'class Gamma extends Beta {}')]);
    g.addFile('d.ts', [sym('Delta', 'class Delta extends Gamma {}')]);

    const seen = new Set<string>(['Alpha']);
    const result = g.getTransitiveCallers(['Alpha'], 2, seen); // cap at 2 hops
    const names = result.map(r => r.name);
    expect(names).toContain('Beta');    // hop 1
    expect(names).toContain('Gamma');   // hop 2
    expect(names).not.toContain('Delta'); // hop 3 — excluded
  });

  it('deduplicates across BFS levels', () => {
    const g = new CodeGraph('/tmp/test-graphs');
    g.addFile('a.ts', [sym('Core', 'class Core {}')]);
    g.addFile('b.ts', [sym('Widget', 'class Widget extends Core {}')]);
    g.addFile('c.ts', [sym('Panel', 'class Panel extends Core {}')]); // also refers to Core

    const seen = new Set<string>(['Core']);
    const result = g.getTransitiveCallers(['Core'], 2, seen);
    // Widget and Panel should each appear exactly once
    const names = result.map(r => r.name);
    expect(names.filter(n => n === 'Widget')).toHaveLength(1);
    expect(names.filter(n => n === 'Panel')).toHaveLength(1);
  });
});
