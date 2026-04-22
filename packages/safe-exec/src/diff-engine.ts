import { createPatch } from 'diff';
import type { DiffResult } from '@rag-system/shared';

export class DiffEngine {
  generate(original: string, modified: string, filePath: string): DiffResult {
    const diff = createPatch(filePath, original, modified, 'original', 'modified');
    return { path: filePath, diff };
  }
}
