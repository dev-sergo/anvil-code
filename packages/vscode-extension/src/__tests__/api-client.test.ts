import { describe, it, expect } from 'vitest';
import { parseSseFrame } from '../api-client.js';

describe('parseSseFrame', () => {
  it('extracts the data: line and parses JSON', () => {
    const frame = 'event: queued\ndata: {"taskId":"t-1","type":"queued","timestamp":1700000000000}';
    const out = parseSseFrame(frame);
    expect(out).toMatchObject({ taskId: 't-1', type: 'queued', timestamp: 1700000000000 });
  });

  it('returns null for heartbeat (comment) frames', () => {
    expect(parseSseFrame(': heartbeat')).toBeNull();
  });

  it('returns null when data is not JSON', () => {
    expect(parseSseFrame('event: x\ndata: not-json')).toBeNull();
  });

  it('returns null when no data line is present', () => {
    expect(parseSseFrame('event: queued')).toBeNull();
  });

  it('takes the last data line when multiple are present (per SSE spec we just want one frame)', () => {
    const frame = 'event: x\ndata: {"a":1}\ndata: {"b":2}';
    const out = parseSseFrame(frame);
    expect(out).toEqual({ b: 2 });
  });
});
