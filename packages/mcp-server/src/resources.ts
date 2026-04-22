import type { MemoryStore } from '@rag-system/memory';
import type { ADRRecord, FailureRecord } from '@rag-system/memory';

export function formatAdr(adr: ADRRecord): string {
  return [
    `## ${adr.decision}`,
    adr.createdAt ? `*${adr.createdAt} — task ${adr.taskId}*` : `*task ${adr.taskId}*`,
    '',
    `**Context:** ${adr.context}`,
    '',
    `**Consequences:** ${adr.consequences}`,
  ].join('\n');
}

export function buildAdrRecentText(store: Pick<MemoryStore, 'listADR'>, limit = 20): string {
  const adrs = store.listADR(limit);
  if (adrs.length === 0) return '_No architectural decisions recorded yet._';
  return `# Recent Architectural Decisions (${adrs.length})\n\n${adrs.map(formatAdr).join('\n\n---\n\n')}`;
}

export function buildAdrByIdText(store: Pick<MemoryStore, 'listADR'>, id: string): string | null {
  // listADR returns up to 20 by default; we look in a wider window for direct lookup
  const all = store.listADR(500);
  const found = all.find(a => a.id === id);
  if (!found) return null;
  return formatAdr(found);
}

export function buildFailuresTopText(store: Pick<MemoryStore, 'getFailurePatterns'>, limit = 20): string {
  const failures = store.getFailurePatterns(limit);
  if (failures.length === 0) return '_No failures recorded — system has been healthy._';
  const rows = failures.map((f: FailureRecord, i) =>
    `${i + 1}. **(×${f.count})** ${f.pattern}${f.resolution ? `\n    — ${f.resolution}` : ''}`,
  );
  return `# Top Failure Patterns (${failures.length})\n\nThese patterns have triggered self-healing or aborted tasks. Useful as guard-rails for new code.\n\n${rows.join('\n')}`;
}

export function buildTasksRecentText(store: Pick<MemoryStore, 'listTasks'>, limit = 20): string {
  const tasks = store.listTasks(limit);
  if (tasks.length === 0) return '_No tasks have been submitted yet._';
  const rows = tasks.map(t => {
    const status = t.status.padEnd(9);
    const desc = t.description.length > 80 ? `${t.description.slice(0, 80)}…` : t.description;
    return `- \`${status}\` **${t.id}** — ${desc}${t.result ? `\n    → ${t.result.slice(0, 200)}` : ''}`;
  });
  return `# Recent Tasks (${tasks.length})\n\n${rows.join('\n')}`;
}
