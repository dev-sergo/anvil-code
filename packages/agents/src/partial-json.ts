/**
 * Incremental scanner for the Coder/Fixer streaming output.
 *
 * The agent emits a JSON object of the form `{"files":[{...}, {...}]}`. Once the
 * first file object inside the `files` array is fully balanced (all braces
 * paired, taking string literals into account), we hand it off to the caller
 * synchronously — without waiting for subsequent files or the closing array.
 *
 * The scanner is string-aware so braces inside `"content"` strings don't trip
 * the depth counter.
 */

export interface PartialFile {
  path: string;
  content: string;
  action: 'create' | 'modify' | 'delete';
}

interface ScannerState {
  buf: string;
  cursor: number;          // index of the next unread char in `buf`
  inFilesArray: boolean;   // true once we've seen `"files":[` (or `[` of the array)
  arrayClosed: boolean;
}

function newState(): ScannerState {
  return { buf: '', cursor: 0, inFilesArray: false, arrayClosed: false };
}

/**
 * Strip a leading markdown fence (``` or ```json) if the buffer starts with it.
 * Returns the new cursor position past any consumed prefix; safe to re-call as
 * more chunks arrive (no-op once the fence is past).
 */
function skipPrefix(state: ScannerState): void {
  while (state.cursor < state.buf.length) {
    const c = state.buf[state.cursor];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿') {
      state.cursor++;
      continue;
    }
    if (c === '`' && state.buf.startsWith('```', state.cursor)) {
      // Skip "```" then optional "json" then a newline.
      const nl = state.buf.indexOf('\n', state.cursor + 3);
      if (nl < 0) return; // wait for more
      state.cursor = nl + 1;
      continue;
    }
    return;
  }
}

/**
 * Locate `"files"` followed by `:` `[`, advancing `cursor` past the `[`. Returns
 * true once we're inside the array; false if more input is needed.
 */
function enterFilesArray(state: ScannerState): boolean {
  if (state.inFilesArray) return true;

  // We don't strictly need `"files":` — any `[` after the first `{` works for
  // schemas that match {files: [...]}. But scanning for the literal makes us
  // robust to any extra top-level keys the model might emit before `files`.
  const i = state.buf.indexOf('"files"', state.cursor);
  if (i < 0) return false;

  let j = i + '"files"'.length;
  while (j < state.buf.length && (state.buf[j] === ' ' || state.buf[j] === '\t' || state.buf[j] === '\n' || state.buf[j] === '\r')) j++;
  if (j >= state.buf.length || state.buf[j] !== ':') return false;
  j++;
  while (j < state.buf.length && (state.buf[j] === ' ' || state.buf[j] === '\t' || state.buf[j] === '\n' || state.buf[j] === '\r')) j++;
  if (j >= state.buf.length) return false;
  if (state.buf[j] !== '[') return false;
  state.cursor = j + 1;
  state.inFilesArray = true;
  return true;
}

/**
 * Scan from `cursor` for the next balanced `{...}` (the next file object).
 * Returns the slice if found, or null if more input is needed. Updates `cursor`
 * past the object on success. Sets `arrayClosed` if we hit `]` first.
 */
function nextObject(state: ScannerState): string | null {
  // Skip whitespace and a leading separator comma.
  let i = state.cursor;
  while (i < state.buf.length) {
    const c = state.buf[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === ']') { state.arrayClosed = true; state.cursor = i + 1; return null; }
    if (c === '{') break;
    // Anything else inside the array is malformed; skip it defensively.
    i++;
  }
  if (i >= state.buf.length) { state.cursor = i; return null; }

  // Walk the object with string-literal awareness.
  const start = i;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (; i < state.buf.length; i++) {
    const c = state.buf[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = state.buf.slice(start, i + 1);
        state.cursor = i + 1;
        return slice;
      }
    }
  }
  // Unterminated — wait for more chunks
  return null;
}

function isPartialFile(value: unknown): value is PartialFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === 'string' && v.path.length > 0
    && typeof v.content === 'string'
    && (v.action === 'create' || v.action === 'modify' || v.action === 'delete');
}

/**
 * Consume an async stream of model token chunks and yield each fully-formed
 * file change as soon as its closing `}` arrives. Skips malformed objects with
 * a console-debug rather than throwing — caller can still validate the
 * accumulated full text afterwards via tolerant JSON repair.
 */
export async function *streamFileChanges(
  source: AsyncIterable<string>,
): AsyncIterable<PartialFile> {
  const state = newState();

  for await (const chunk of source) {
    state.buf += chunk;

    // Skip leading prefix (whitespace, ```json fence) once.
    skipPrefix(state);

    // Wait until we're inside the files array.
    if (!enterFilesArray(state)) continue;
    if (state.arrayClosed) continue;

    // Drain as many balanced objects as currently fit.
    while (!state.arrayClosed) {
      const slice = nextObject(state);
      if (slice === null) break; // wait for more input
      try {
        const parsed = JSON.parse(slice) as unknown;
        if (isPartialFile(parsed)) yield parsed;
      } catch {
        // Malformed object — skip; the agent's accumulated string still goes
        // through tolerant parsing for the authoritative result.
      }
    }
  }
}
