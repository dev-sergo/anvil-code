#!/usr/bin/env node
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pino from 'pino';
import { config } from '@rag-system/shared';
import { MemoryStore } from '@rag-system/memory';
import { GraphRetriever } from '@rag-system/rag';
import {
  buildAdrRecentText,
  buildAdrByIdText,
  buildFailuresTopText,
  buildTasksRecentText,
} from './resources.js';
import {
  buildAddFeaturePrompt,
  buildFixBugPrompt,
  buildRefactorPrompt,
  buildAddTestsPrompt,
} from './prompts.js';

// MCP uses stdio — log to stderr to avoid polluting the protocol stream
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

const API_URL = process.env.RAG_API_URL ?? `http://localhost:${config.api.port}`;

// Zod schemas — defined once, used for both MCP SDK description and runtime validation
const IndexCodebaseInput = z.object({
  path: z.string().describe('Absolute path to the directory to index'),
});
const SearchCodeInput = z.object({
  query: z.string().describe('Natural language description of what you are looking for'),
  limit: z.number().optional().default(5).describe('Number of results to return (default: 5)'),
});
const GetRelatedCodeInput = z.object({
  symbol: z.string().describe('Name of the class, function, or interface to find dependencies for'),
});
const RunTaskInput = z.object({
  task: z.string().describe('Description of the coding task in natural language'),
  mode: z.enum(['fast', 'balanced', 'deep']).optional().default('balanced')
    .describe('fast=small models, balanced=default routing, deep=large models for everything'),
});
const GetTaskStatusInput = z.object({
  task_id: z.string().describe('Task ID returned by run_task'),
});
const ListDecisionsInput = z.object({
  limit: z.number().optional().default(10).describe('Number of recent decisions to return'),
});
const AddDecisionInput = z.object({
  title: z.string().describe('Short title of the architectural decision'),
  context: z.string().describe('Why this decision was needed'),
  decision: z.string().describe('What was decided'),
  consequences: z.string().optional().default('').describe('Trade-offs and implications'),
});

async function main() {
  log.info('Starting RAG System MCP Server...');

  const store = new MemoryStore();
  const retriever = new GraphRetriever(store);
  await retriever.loadFromDisk();

  const server = new McpServer({
    name: 'rag-system',
    version: '1.0.0',
  }, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: 'RAG system for local AI-assisted development. Use search_code to find relevant code, index_codebase to index your project, and run_task to execute autonomous coding tasks. Read adr://recent and failures://top before designing changes; use the add-feature / fix-bug / refactor / add-tests prompts to scaffold workflows.',
  });

  // ── Tool: index_codebase ──────────────────────────────────────────────────
  server.registerTool('index_codebase', {
    description: 'Index a directory into the RAG vector store for semantic code search. Run this once per project to enable search_code.',
    inputSchema: { path: z.string().describe('Absolute path to the directory to index') },
  }, async (rawArgs) => {
    const parsed = IndexCodebaseInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { path: dirPath } = parsed.data;
    try {
      log.info({ path: dirPath }, 'Indexing codebase');
      await retriever.indexCodebase(dirPath);
      return {
        content: [{ type: 'text' as const, text: `Indexed codebase at: ${dirPath}` }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error indexing: ${msg}` }], isError: true };
    }
  });

  // ── Tool: search_code ─────────────────────────────────────────────────────
  server.registerTool('search_code', {
    description: 'Semantic search across the indexed codebase. Returns relevant code snippets and their file locations.',
    inputSchema: {
      query: z.string().describe('Natural language description of what you are looking for'),
      limit: z.number().optional().default(5).describe('Number of results to return (default: 5)'),
    },
  }, async (rawArgs) => {
    const parsed = SearchCodeInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit } = parsed.data;
    try {
      const items = await retriever.retrieveContextItems(query, limit);
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No results found. Try running index_codebase first.' }] };
      }
      // Return one content block per result so the LLM can identify file/line for each
      return {
        content: items.map(item => ({
          type: 'text' as const,
          text: `**${item.symbolName}** in \`${item.filePath}\` (lines ${item.startLine}–${item.endLine})\n\`\`\`typescript\n${item.text}\n\`\`\``,
        })),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Search error: ${msg}` }], isError: true };
    }
  });

  // ── Tool: get_related_code ────────────────────────────────────────────────
  server.registerTool('get_related_code', {
    description: 'Get code symbols related to a given symbol name (1-hop dependency traversal).',
    inputSchema: {
      symbol: z.string().describe('Name of the class, function, or interface to find dependencies for'),
    },
  }, async (rawArgs) => {
    const parsed = GetRelatedCodeInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { symbol } = parsed.data;
    try {
      const items = await retriever.retrieveContextItems(`dependencies of ${symbol}`, 5);
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: `No related code found for: ${symbol}` }] };
      }
      return {
        content: items.map(item => ({
          type: 'text' as const,
          text: `**${item.symbolName}** in \`${item.filePath}\` (lines ${item.startLine}–${item.endLine})\n\`\`\`typescript\n${item.text}\n\`\`\``,
        })),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  // ── Tool: run_task ────────────────────────────────────────────────────────
  server.registerTool('run_task', {
    description: 'Submit an autonomous coding task to the RAG system. The system will plan, code, test, review, and commit the changes.',
    inputSchema: {
      task: z.string().describe('Description of the coding task in natural language'),
      mode: z.enum(['fast', 'balanced', 'deep']).optional().default('balanced')
        .describe('fast=small models, balanced=default routing, deep=large models for everything'),
    },
  }, async (rawArgs) => {
    const parsed = RunTaskInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { task, mode } = parsed.data;
    try {
      const res = await fetch(`${API_URL}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, mode }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text' as const, text: `API error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json() as { task_id: string; status: string };
      return {
        content: [{
          type: 'text' as const,
          text: `Task submitted.\nID: ${data.task_id}\nStatus: ${data.status}\nCheck progress with get_task_status tool.`,
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Failed to submit task (is the API server running at ${API_URL}?): ${msg}` }],
        isError: true,
      };
    }
  });

  // ── Tool: get_task_status ─────────────────────────────────────────────────
  server.registerTool('get_task_status', {
    description: 'Check the status and result of a previously submitted task.',
    inputSchema: {
      task_id: z.string().describe('Task ID returned by run_task'),
    },
  }, async (rawArgs) => {
    const parsed = GetTaskStatusInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { task_id } = parsed.data;
    try {
      const task = store.getTask(task_id);
      if (task) {
        return {
          content: [{
            type: 'text' as const,
            text: `Task ${task_id}\nStatus: ${task.status}${task.result ? `\nResult: ${task.result}` : ''}`,
          }],
        };
      }
      const res = await fetch(`${API_URL}/task/${task_id}`);
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }] };
      const data = await res.json() as { status: string; result?: string };
      return {
        content: [{
          type: 'text' as const,
          text: `Task ${task_id}\nStatus: ${data.status}${data.result ? `\nResult: ${data.result}` : ''}`,
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  // ── Tool: list_decisions ──────────────────────────────────────────────────
  server.registerTool('list_decisions', {
    description: 'List architectural decision records (ADR) stored in the project memory.',
    inputSchema: {
      limit: z.number().optional().default(10).describe('Number of recent decisions to return'),
    },
  }, async (rawArgs) => {
    const parsed = ListDecisionsInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const adrs = store.listADR(parsed.data.limit);
    if (adrs.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No architectural decisions recorded yet.' }] };
    }
    const text = adrs.map(a =>
      `## ${a.decision}\n**Context:** ${a.context}\n**Consequences:** ${a.consequences}\n*Task: ${a.taskId} | ${a.createdAt ?? ''}*`
    ).join('\n\n---\n\n');
    return { content: [{ type: 'text' as const, text }] };
  });

  // ── Tool: add_decision ────────────────────────────────────────────────────
  server.registerTool('add_decision', {
    description: 'Record an architectural decision in the project memory for future context.',
    inputSchema: {
      title: z.string().describe('Short title of the architectural decision'),
      context: z.string().describe('Why this decision was needed'),
      decision: z.string().describe('What was decided'),
      consequences: z.string().optional().default('').describe('Trade-offs and implications'),
    },
  }, async (rawArgs) => {
    const parsed = AddDecisionInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { title, context, decision, consequences } = parsed.data;
    const id = `manual-${Date.now()}`;
    store.saveADR({
      id,
      taskId: 'manual',
      decision: title,
      context,
      consequences: consequences ? `${decision}\n\nConsequences: ${consequences}` : decision,
    });
    return { content: [{ type: 'text' as const, text: `Architectural decision recorded (ID: ${id})` }] };
  });

  // ── Resources ─────────────────────────────────────────────────────────────
  server.registerResource(
    'adr-recent',
    'adr://recent',
    {
      title: 'Recent ADRs',
      description: 'Recent architectural decision records, including those produced by self-healing retries.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildAdrRecentText(store),
      }],
    }),
  );

  server.registerResource(
    'adr-by-id',
    new ResourceTemplate('adr://{id}', {
      list: async () => {
        const adrs = store.listADR(50);
        return {
          resources: adrs.map(a => ({
            uri: `adr://${a.id}`,
            name: a.decision.slice(0, 80),
            description: a.context.slice(0, 160),
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    {
      title: 'ADR by ID',
      description: 'Read a specific architectural decision by its ID.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const text = buildAdrByIdText(store, id) ?? `_ADR \`${id}\` not found._`;
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
      };
    },
  );

  server.registerResource(
    'failures-top',
    'failures://top',
    {
      title: 'Top Failure Patterns',
      description: 'Recurring failure patterns from past tasks. Read this before proposing changes to avoid known pitfalls.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildFailuresTopText(store),
      }],
    }),
  );

  server.registerResource(
    'tasks-recent',
    'tasks://recent',
    {
      title: 'Recent Tasks',
      description: 'Recent tasks submitted to the orchestrator with their status and result summary.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildTasksRecentText(store),
      }],
    }),
  );

  // ── Prompts ───────────────────────────────────────────────────────────────
  server.registerPrompt(
    'add-feature',
    {
      title: 'Add a feature',
      description: 'Plan and execute a new feature using the RAG system tools.',
      argsSchema: {
        feature: z.string().describe('What the feature should do'),
        area: z.string().optional().describe('Optional codebase area to start the search from'),
      },
    },
    (args) => buildAddFeaturePrompt(args),
  );

  server.registerPrompt(
    'fix-bug',
    {
      title: 'Fix a bug',
      description: 'Investigate and fix a reported bug end-to-end.',
      argsSchema: {
        description: z.string().describe('Description of the bug'),
        file: z.string().optional().describe('Optional file path where the bug is suspected'),
      },
    },
    (args) => buildFixBugPrompt(args),
  );

  server.registerPrompt(
    'refactor',
    {
      title: 'Refactor a target',
      description: 'Plan a refactor with awareness of past architectural decisions.',
      argsSchema: {
        target: z.string().describe('Symbol, file, or area to refactor'),
        goal: z.string().optional().describe('Specific refactoring goal (e.g., extract module, reduce duplication)'),
      },
    },
    (args) => buildRefactorPrompt(args),
  );

  server.registerPrompt(
    'add-tests',
    {
      title: 'Add tests for a target',
      description: 'Generate tests covering happy path and edge cases for an existing symbol.',
      argsSchema: {
        target: z.string().describe('Symbol or file that needs tests'),
      },
    },
    (args) => buildAddTestsPrompt(args),
  );

  // ── Connect to stdio transport ────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('MCP Server connected via stdio. Waiting for requests...');
}

main().catch(err => {
  process.stderr.write(`MCP Server fatal error: ${String(err)}\n`);
  process.exit(1);
});
