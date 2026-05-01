/**
 * Recovery for tool calls emitted as JSON in `message.content` instead of the
 * structured `tool_calls` field. Models that exhibit this: qwen2.5-coder,
 * gemma2, occasionally llama3.1 — the property is the model's, not the
 * backend's, so the same recovery is needed for both Ollama and llama-swap.
 *
 * Walks the string with brace-matched, string-aware JSON extraction. Robust to
 * leading/trailing prose, multiple back-to-back calls, and JSON with embedded
 * `{`/`}` inside string literals.
 */
export function extractInlineToolCalls(
  content: string,
): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] !== '{') { i++; continue; }
    const end = findMatchingBrace(content, i);
    if (end === -1) break;
    const candidate = content.slice(i, end + 1);
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const name = obj.name;
      const args = obj.arguments;
      if (
        typeof name === 'string' &&
        name.length > 0 &&
        args !== null &&
        typeof args === 'object' &&
        !Array.isArray(args)
      ) {
        calls.push({
          function: { name, arguments: args as Record<string, unknown> },
        });
      }
    } catch {
      // Not parseable as JSON; skip and look for the next `{`.
    }
    i = end + 1;
  }
  return calls;
}

export function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
