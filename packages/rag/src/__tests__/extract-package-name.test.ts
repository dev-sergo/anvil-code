import { describe, it, expect } from 'vitest';
import { extractPackageName } from '../graph-retriever.js';

describe('extractPackageName (v1.66)', () => {
  it('extracts name from absolute path with packages/ segment', () => {
    expect(extractPackageName('/Users/admin/work/trpc/packages/openapi/src/foo.ts')).toBe('openapi');
  });

  it('extracts name from relative packages/ path', () => {
    expect(extractPackageName('packages/server/src/router.ts')).toBe('server');
  });

  it('extracts name from query string mentioning packages/', () => {
    expect(extractPackageName('Add a new route to packages/api/src/server.ts')).toBe('api');
  });

  it('returns undefined for paths without packages/ segment', () => {
    expect(extractPackageName('src/utils/helper.ts')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractPackageName('')).toBeUndefined();
  });

  it('returns undefined for cross-cutting package: shared', () => {
    expect(extractPackageName('packages/shared/src/config.ts')).toBeUndefined();
  });

  it('returns undefined for cross-cutting package: utils', () => {
    expect(extractPackageName('packages/utils/src/format.ts')).toBeUndefined();
  });

  it('returns undefined for cross-cutting package: types', () => {
    expect(extractPackageName('packages/types/index.ts')).toBeUndefined();
  });

  it('returns undefined for cross-cutting package: common', () => {
    expect(extractPackageName('packages/common/src/constants.ts')).toBeUndefined();
  });

  it('returns undefined for cross-cutting package: helpers', () => {
    expect(extractPackageName('packages/helpers/src/math.ts')).toBeUndefined();
  });

  it('handles package names with dots and dashes', () => {
    expect(extractPackageName('packages/vscode-extension/src/extension.ts')).toBe('vscode-extension');
  });

  it('handles monorepo with nested path: returns first packages/ segment', () => {
    expect(extractPackageName('/abs/repo/packages/agents/src/orchestrator.ts')).toBe('agents');
  });
});
