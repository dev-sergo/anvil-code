import { describe, it, expect } from 'vitest';
import { buildPromptContext } from '../prompt-context.js';
import type { ProjectConventions } from '../project-conventions.js';

function makeConventions(summary: string): ProjectConventions {
  return {
    testFramework: 'vitest',
    moduleType: 'esm',
    tsStrict: true,
    moduleResolution: 'nodenext',
    needsJsSuffix: true,
    runtimeFrameworks: [],
    entryPoints: [],
    testFileExtension: '.test.ts',
    summary,
  };
}

const conventions = makeConventions('Use 2-space indent. Prefer named exports.');

describe('buildPromptContext — context budget (v1.71 T3 guard)', () => {
  it('keeps every section when under budget', () => {
    const out = buildPromptContext({
      conventions,
      ragSnippets: 'small snippet',
      ragFilePaths: [],
      projectRoot: '/tmp',
      repoMap: 'tiny map',
      designContext: 'do the thing',
      maxContextBytes: 1024,
    });
    expect(out).toContain('Project Conventions');
    expect(out).toContain('Related code snippets');
    expect(out).toContain('Repo Map');
    expect(out).toContain('Architectural design');
  });

  it('prunes RAG snippets first when over budget', () => {
    const out = buildPromptContext({
      conventions,
      ragSnippets: 'X'.repeat(5000), // by far the largest section
      ragFilePaths: [],
      projectRoot: '/tmp',
      repoMap: 'compact repo map',
      designContext: 'important design',
      maxContextBytes: 1500,
    });
    // RAG snippets (rank 3) dropped; repo-map (rank 2) and essentials survive.
    expect(out).not.toContain('Related code snippets');
    expect(out).toContain('Repo Map');
    expect(out).toContain('Project Conventions');
    expect(out).toContain('Architectural design');
  });

  it('prunes repo-map next when dropping snippets is not enough', () => {
    const out = buildPromptContext({
      conventions,
      ragSnippets: 'Y'.repeat(2000),
      ragFilePaths: [],
      projectRoot: '/tmp',
      repoMap: 'Z'.repeat(5000),
      designContext: 'important design',
      maxContextBytes: 800,
    });
    expect(out).not.toContain('Related code snippets');
    expect(out).not.toContain('Repo Map');
    // Essentials (rank 0) are never dropped, even if still over budget.
    expect(out).toContain('Project Conventions');
    expect(out).toContain('Architectural design');
  });

  it('never drops essential sections even when they alone exceed budget', () => {
    const out = buildPromptContext({
      conventions: makeConventions('C'.repeat(4000)),
      ragSnippets: '',
      ragFilePaths: [],
      projectRoot: '/tmp',
      designContext: 'D'.repeat(4000),
      maxContextBytes: 500,
    });
    expect(out).toContain('Project Conventions');
    expect(out).toContain('Architectural design');
  });
});
