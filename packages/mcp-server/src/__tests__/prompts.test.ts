import { describe, it, expect } from 'vitest';
import {
  buildAddFeaturePrompt,
  buildFixBugPrompt,
  buildRefactorPrompt,
  buildAddTestsPrompt,
} from '../prompts.js';

describe('prompts', () => {
  it('add-feature returns a single user message referencing search_code and run_task', () => {
    const r = buildAddFeaturePrompt({ feature: 'export to PDF', area: 'reports' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe('user');
    const text = r.messages[0].content.text;
    expect(text).toContain('export to PDF');
    expect(text).toContain('search_code');
    expect(text).toContain('run_task');
    expect(text).toContain('reports');
    expect(r.description).toContain('Add feature');
  });

  it('add-feature works without optional area', () => {
    const r = buildAddFeaturePrompt({ feature: 'thing' });
    expect(r.messages[0].content.text).toContain('search_code');
  });

  it('fix-bug references failures resource and includes file when provided', () => {
    const r = buildFixBugPrompt({ description: 'crash on save', file: 'src/save.ts' });
    const text = r.messages[0].content.text;
    expect(text).toContain('crash on save');
    expect(text).toContain('failures://top');
    expect(text).toContain('src/save.ts');
    expect(text).toContain('get_related_code');
  });

  it('refactor uses deep mode and references adr://recent', () => {
    const r = buildRefactorPrompt({ target: 'Orchestrator', goal: 'split per-step recovery' });
    const text = r.messages[0].content.text;
    expect(text).toContain('Orchestrator');
    expect(text).toContain('adr://recent');
    expect(text).toContain('mode: deep');
    expect(text).toContain('split per-step recovery');
  });

  it('add-tests prompts to use search_code and TesterAgent', () => {
    const r = buildAddTestsPrompt({ target: 'VectorStore' });
    const text = r.messages[0].content.text;
    expect(text).toContain('VectorStore');
    expect(text).toContain('search_code');
    expect(text).toContain('TesterAgent');
  });
});
