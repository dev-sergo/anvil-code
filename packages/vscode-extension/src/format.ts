import type { TaskEvent } from '@rag-system/shared';
import type { TaskRecord, Project } from './api-client.js';

/** Status icon for the TreeView per task status (uses VSCode codicon names). */
export function taskStatusIcon(status: TaskRecord['status']): string {
  switch (status) {
    case 'queued': return 'clock';
    case 'running': return 'sync~spin';
    case 'completed': return 'check';
    case 'failed': return 'error';
    default: return 'question';
  }
}

/** A short human-readable line for the task list. */
export function taskLabel(t: TaskRecord): string {
  const desc = t.description.length > 60 ? `${t.description.slice(0, 60)}…` : t.description;
  return desc;
}

/** Tooltip lines for hovering over a task in the tree. */
export function taskTooltip(t: TaskRecord): string {
  const lines: string[] = [
    `**${t.id}**`,
    `Status: ${t.status}`,
    `Description: ${t.description}`,
  ];
  if (t.result) lines.push(`Result: ${t.result}`);
  if (t.createdAt) lines.push(`Created: ${t.createdAt}`);
  if (t.completedAt) lines.push(`Completed: ${t.completedAt}`);
  return lines.join('\n\n');
}

export function projectLabel(p: Project, isActive: boolean): string {
  return isActive ? `★ ${p.name}` : p.name;
}

/**
 * Render a TaskEvent as a single line for the output channel. Keeps the
 * stream readable: agent_stream chunks are condensed to size hints rather
 * than dumping every token (the user can read final output in the file).
 */
export function formatEventLine(e: TaskEvent): string {
  const ts = new Date(e.timestamp).toISOString().slice(11, 23);
  switch (e.type) {
    case 'queued':
      return `[${ts}] QUEUED  ${e.message ?? ''}`;
    case 'running':
      return `[${ts}] RUNNING ${e.message ?? ''}`;
    case 'plan': {
      const d = e.data as { stepCount?: number; stepIds?: string[] } | undefined;
      return `[${ts}] PLAN    ${d?.stepCount ?? '?'} step(s): ${(d?.stepIds ?? []).join(', ')}`;
    }
    case 'step_start':
      return `[${ts}] STEP→   ${e.message ?? ''}`;
    case 'step_complete': {
      const d = e.data as { stepId?: string; fileCount?: number } | undefined;
      return `[${ts}] STEP✓   ${d?.stepId ?? ''} (${d?.fileCount ?? 0} file(s))`;
    }
    case 'step_fail': {
      const d = e.data as { stepId?: string; error?: string } | undefined;
      return `[${ts}] STEP✗   ${d?.stepId ?? ''}: ${d?.error ?? ''}`;
    }
    case 'step_skip': {
      const d = e.data as { stepId?: string; blockedBy?: string[] } | undefined;
      return `[${ts}] STEP⊘   ${d?.stepId ?? ''} (deps failed: ${(d?.blockedBy ?? []).join(',')})`;
    }
    case 'agent_stream': {
      const d = e.data as { agent?: string; chunk?: string; totalLen?: number } | undefined;
      const preview = (d?.chunk ?? '').replace(/\n/g, ' ').slice(0, 60);
      return `[${ts}] ${(d?.agent ?? '').padEnd(9)} +${d?.chunk?.length ?? 0}b  total=${d?.totalLen ?? 0}b  ${preview}`;
    }
    case 'coder_file_ready': {
      const d = e.data as { path?: string; action?: string; size?: number; source?: string } | undefined;
      return `[${ts}] FILE    ${d?.action ?? '?'} ${d?.path ?? ''} (${d?.size ?? 0}b)${d?.source ? ` [${d.source}]` : ''}`;
    }
    case 'validation_start':
      return `[${ts}] VALID→  ${e.message ?? ''}`;
    case 'validation_pass':
      return `[${ts}] VALID✓  ${e.message ?? ''}`;
    case 'validation_fail':
      return `[${ts}] VALID✗  ${e.message ?? ''}`;
    case 'commit':
      return `[${ts}] COMMIT  ${e.message ?? ''}`;
    case 'done':
      return `[${ts}] DONE    ${e.message ?? ''}`;
    case 'error':
      return `[${ts}] ERROR   ${e.message ?? ''}`;
    case 'index_start': {
      const d = e.data as { totalFiles?: number; root?: string } | undefined;
      return `[${ts}] INDEX→  ${d?.totalFiles ?? '?'} file(s) at ${d?.root ?? ''}`;
    }
    case 'index_file':
    case 'index_skip': {
      const d = e.data as { processed?: number; totalFiles?: number; percent?: number; file?: string } | undefined;
      const tag = e.type === 'index_skip' ? 'SKIP' : 'IDX ';
      return `[${ts}] ${tag}    ${d?.percent ?? 0}% (${d?.processed ?? 0}/${d?.totalFiles ?? 0})  ${d?.file ?? ''}`;
    }
    case 'index_done': {
      const d = e.data as { indexed?: number; skipped?: number; vectors?: number; durationMs?: number } | undefined;
      return `[${ts}] INDEX✓  indexed=${d?.indexed ?? 0} skipped=${d?.skipped ?? 0} vectors=${d?.vectors ?? 0} (${d?.durationMs ?? 0}ms)`;
    }
    default:
      return `[${ts}] ${(e.type as string).toUpperCase().padEnd(7)} ${e.message ?? ''}`;
  }
}
