import { describe, it, expect } from 'vitest';
import { streamFileChanges, type PartialFile } from '../partial-json.js';

/** Chunk a string into an async iterable, simulating an LLM token stream. */
async function *chunks(text: string, size: number): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}

async function collect(source: AsyncIterable<PartialFile>): Promise<PartialFile[]> {
  const out: PartialFile[] = [];
  for await (const f of source) out.push(f);
  return out;
}

describe('streamFileChanges', () => {
  it('yields a single file once its closing brace arrives', async () => {
    const payload = `{"files":[{"path":"src/a.ts","content":"export {};","action":"create"}]}`;
    const files = await collect(streamFileChanges(chunks(payload, 4)));
    expect(files).toEqual([
      { path: 'src/a.ts', content: 'export {};', action: 'create' },
    ]);
  });

  it('yields each file eagerly when multiple are in the array', async () => {
    const payload = JSON.stringify({
      files: [
        { path: 'a.ts', content: 'one', action: 'create' },
        { path: 'b.ts', content: 'two', action: 'modify' },
        { path: 'c.ts', content: 'three', action: 'delete' },
      ],
    });
    const files = await collect(streamFileChanges(chunks(payload, 10)));
    expect(files.map(f => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles chunks that split mid-string', async () => {
    const payload = JSON.stringify({
      files: [{ path: 'x.ts', content: 'a-very-long-string-content', action: 'create' }],
    });
    // 1-byte chunks — exercises the scanner on every boundary
    const files = await collect(streamFileChanges(chunks(payload, 1)));
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('a-very-long-string-content');
  });

  it('is string-aware: braces inside content do not trip depth counting', async () => {
    const inner = 'if (x) { doThing({ y: 1 }); }';
    const payload = JSON.stringify({
      files: [{ path: 'f.ts', content: inner, action: 'create' }],
    });
    const files = await collect(streamFileChanges(chunks(payload, 3)));
    expect(files).toEqual([{ path: 'f.ts', content: inner, action: 'create' }]);
  });

  it('respects escaped quotes inside string content', async () => {
    const inner = 'const s = "hi \\"friend\\"";';
    const payload = JSON.stringify({
      files: [{ path: 'q.ts', content: inner, action: 'create' }],
    });
    const files = await collect(streamFileChanges(chunks(payload, 5)));
    expect(files[0].content).toBe(inner);
  });

  it('strips a leading markdown fence', async () => {
    const body = JSON.stringify({
      files: [{ path: 'fenced.ts', content: 'x', action: 'create' }],
    });
    const payload = '```json\n' + body + '\n```';
    const files = await collect(streamFileChanges(chunks(payload, 6)));
    expect(files.map(f => f.path)).toEqual(['fenced.ts']);
  });

  it('ignores extra top-level keys before the files array', async () => {
    const payload = `{"meta":"preamble","extra":42,"files":[{"path":"a.ts","content":"","action":"create"}]}`;
    const files = await collect(streamFileChanges(chunks(payload, 7)));
    expect(files.map(f => f.path)).toEqual(['a.ts']);
  });

  it('emits nothing when stream ends before first object closes', async () => {
    const payload = `{"files":[{"path":"incomplete.ts","content":"half`;
    const files = await collect(streamFileChanges(chunks(payload, 8)));
    expect(files).toEqual([]);
  });

  it('skips malformed entries without aborting the stream', async () => {
    // Middle object is missing `action` — isPartialFile returns false, we skip
    const payload = `{"files":[
      {"path":"ok1.ts","content":"a","action":"create"},
      {"path":"bad.ts","content":"x"},
      {"path":"ok2.ts","content":"b","action":"modify"}
    ]}`;
    const files = await collect(streamFileChanges(chunks(payload, 12)));
    expect(files.map(f => f.path)).toEqual(['ok1.ts', 'ok2.ts']);
  });

  it('handles large chunks that deliver the whole payload at once', async () => {
    const payload = JSON.stringify({
      files: [
        { path: 'a.ts', content: 'one', action: 'create' },
        { path: 'b.ts', content: 'two', action: 'modify' },
      ],
    });
    const files = await collect(streamFileChanges(chunks(payload, payload.length)));
    expect(files).toHaveLength(2);
  });
});
