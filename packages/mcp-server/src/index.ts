#!/usr/bin/env node
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pino from 'pino';
import { config } from '@rag-system/shared';
import { ProjectRegistry } from '@rag-system/memory';
import type { Project } from '@rag-system/memory';
import { ProjectManager } from '@rag-system/agents';
import { ModelRouter } from '@rag-system/model-router';
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

// Reused on every project-scoped tool — omit to use the default project.
const projectIdField = z
  .string()
  .optional()
  .describe('Project id from list_projects. Omit to target the default project.');

// Zod schemas — defined once, used for both MCP SDK description and runtime validation
const IndexCodebaseInput = z.object({
  path: z.string().describe('Absolute path to the directory to index'),
  project_id: projectIdField,
});
const SearchCodeInput = z.object({
  query: z.string().describe('Natural language description of what you are looking for'),
  limit: z.number().optional().default(5).describe('Number of results to return (default: 5)'),
  project_id: projectIdField,
});
const GetRelatedCodeInput = z.object({
  symbol: z.string().describe('Name of the class, function, or interface to find dependencies for'),
  project_id: projectIdField,
});
const RunTaskInput = z.object({
  task: z.string().describe('Description of the coding task in natural language'),
  mode: z.enum(['fast', 'balanced', 'deep']).optional().default('balanced')
    .describe('fast=small models, balanced=default routing, deep=large models for everything'),
  project_id: projectIdField,
});
const GetTaskStatusInput = z.object({
  task_id: z.string().describe('Task ID returned by run_task'),
});
const ListDecisionsInput = z.object({
  limit: z.number().optional().default(10).describe('Number of recent decisions to return'),
  project_id: projectIdField,
});
const AddDecisionInput = z.object({
  title: z.string().describe('Short title of the architectural decision'),
  context: z.string().describe('Why this decision was needed'),
  decision: z.string().describe('What was decided'),
  consequences: z.string().optional().default('').describe('Trade-offs and implications'),
  project_id: projectIdField,
});
const RegisterProjectInput = z.object({
  root: z.string().describe('Absolute path to the project root directory'),
  name: z.string().optional().describe('Human-readable name (defaults to basename of root)'),
});

async function main() {
  log.info('Starting RAG System MCP Server...');

  const registry = new ProjectRegistry();
  // ModelRouter is harmless to construct here — Orchestrator only fires LLMs from inside
  // run_task, which forwards to the API. The MCP process never actually invokes agents.
  const router = new ModelRouter();
  const projects = new ProjectManager(registry, router);

  // Auto-register the configured project root as default if registry is empty.
  let defaultProject = registry.list()[0];
  if (config.projects.autoRegisterDefault && !defaultProject) {
    defaultProject = registry.register(config.projectRoot);
    log.info({ projectId: defaultProject.id, root: defaultProject.root }, 'Auto-registered default project');
  }
  if (!defaultProject) {
    throw new Error('No projects registered and PROJECTS_AUTO_REGISTER_DEFAULT=false');
  }

  // Resolve the project context to use for a tool call. Returns the default
  // when no id is given; throws (caller wraps as isError) on unknown id.
  const resolveContext = async (projectId?: string) => {
    const id = projectId ?? defaultProject.id;
    if (!registry.get(id)) throw new Error(`Project '${id}' not registered. Use list_projects to see available projects.`);
    return projects.get(id);
  };

  const server = new McpServer({
    name: 'rag-system',
    version: '1.0.0',
  }, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: `RAG system for local AI-assisted development. Multi-project: use list_projects to see registered projects, register_project to add a new one, and pass project_id on any tool to target a specific project (omit to use the default: ${defaultProject.name}). Read adr://recent and failures://top before designing changes; use the add-feature / fix-bug / refactor / add-tests prompts to scaffold workflows.`,
  });

  // ── Tool: index_codebase ──────────────────────────────────────────────────
  server.registerTool('index_codebase', {
    description: 'Index a directory into the RAG vector store for semantic code search. Run this once per project to enable search_code.',
    inputSchema: {
      path: z.string().describe('Absolute path to the directory to index'),
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = IndexCodebaseInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { path: dirPath, project_id } = parsed.data;
    try {
      const ctx = await resolveContext(project_id);
      log.info({ projectId: ctx.project.id, path: dirPath }, 'Indexing codebase');
      const indexId = await ctx.retriever.indexCodebase(dirPath);
      return {
        content: [{
          type: 'text' as const,
          text: `Indexed codebase at: ${dirPath}\nProject: ${ctx.project.name} (${ctx.project.id})\nIndex ID: ${indexId}\nLive progress: GET /task/${indexId}/stream`,
        }],
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
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = SearchCodeInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { query, limit, project_id } = parsed.data;
    try {
      const ctx = await resolveContext(project_id);
      const items = await ctx.retriever.retrieveContextItems(query, limit);
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: `No results found in ${ctx.project.name}. Try running index_codebase first.` }] };
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
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = GetRelatedCodeInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { symbol, project_id } = parsed.data;
    try {
      const ctx = await resolveContext(project_id);
      const items = await ctx.retriever.retrieveContextItems(`dependencies of ${symbol}`, 5);
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: `No related code found for: ${symbol} in ${ctx.project.name}` }] };
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
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = RunTaskInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { task, mode, project_id } = parsed.data;
    const targetProjectId = project_id ?? defaultProject.id;
    if (!registry.get(targetProjectId)) {
      return {
        content: [{ type: 'text' as const, text: `Project '${targetProjectId}' not registered. Use list_projects.` }],
        isError: true,
      };
    }
    try {
      const res = await fetch(`${API_URL}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, mode, project: targetProjectId }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text' as const, text: `API error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json() as { task_id: string; project_id: string; status: string };
      return {
        content: [{
          type: 'text' as const,
          text: `Task submitted.\nID: ${data.task_id}\nProject: ${data.project_id}\nStatus: ${data.status}\nLive progress: GET /task/${data.task_id}/stream\nOr poll get_task_status.`,
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
      // The API tracks live jobs and knows which project each one belongs to.
      // Falling back to local stores would require scanning every project.
      const res = await fetch(`${API_URL}/task/${task_id}`);
      if (!res.ok) return { content: [{ type: 'text' as const, text: `Task ${task_id} not found` }] };
      const data = await res.json() as { status: string; result?: string; project_id?: string };
      return {
        content: [{
          type: 'text' as const,
          text: `Task ${task_id}${data.project_id ? `\nProject: ${data.project_id}` : ''}\nStatus: ${data.status}${data.result ? `\nResult: ${data.result}` : ''}`,
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
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = ListDecisionsInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    try {
      const ctx = await resolveContext(parsed.data.project_id);
      const adrs = ctx.store.listADR(parsed.data.limit);
      if (adrs.length === 0) {
        return { content: [{ type: 'text' as const, text: `No architectural decisions recorded yet in ${ctx.project.name}.` }] };
      }
      const text = adrs.map(a =>
        `## ${a.decision}\n**Context:** ${a.context}\n**Consequences:** ${a.consequences}\n*Task: ${a.taskId} | ${a.createdAt ?? ''}*`,
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  // ── Tool: add_decision ────────────────────────────────────────────────────
  server.registerTool('add_decision', {
    description: 'Record an architectural decision in the project memory for future context.',
    inputSchema: {
      title: z.string().describe('Short title of the architectural decision'),
      context: z.string().describe('Why this decision was needed'),
      decision: z.string().describe('What was decided'),
      consequences: z.string().optional().default('').describe('Trade-offs and implications'),
      project_id: projectIdField,
    },
  }, async (rawArgs) => {
    const parsed = AddDecisionInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { title, context, decision, consequences, project_id } = parsed.data;
    try {
      const ctx = await resolveContext(project_id);
      const id = `manual-${Date.now()}`;
      ctx.store.saveADR({
        id,
        taskId: 'manual',
        decision: title,
        context,
        consequences: consequences ? `${decision}\n\nConsequences: ${consequences}` : decision,
      });
      return { content: [{ type: 'text' as const, text: `Architectural decision recorded (ID: ${id}) in project ${ctx.project.name}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  // ── Tool: list_projects ───────────────────────────────────────────────────
  server.registerTool('list_projects', {
    description: 'List all registered projects with ids and roots. Tools accept project_id to target a specific project.',
    inputSchema: {},
  }, async () => {
    const list = registry.list();
    if (list.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No projects registered.' }] };
    }
    const text = list.map((p: Project) => {
      const isDefault = p.id === defaultProject.id ? ' *(default)*' : '';
      return `- **${p.name}**${isDefault}\n  id: \`${p.id}\`\n  root: \`${p.root}\``;
    }).join('\n');
    return { content: [{ type: 'text' as const, text: `# Registered projects (${list.length})\n\n${text}` }] };
  });

  // ── Tool: register_project ────────────────────────────────────────────────
  server.registerTool('register_project', {
    description: 'Register a new project at the given absolute path. Returns its id; idempotent on the same root.',
    inputSchema: {
      root: z.string().describe('Absolute path to the project root directory'),
      name: z.string().optional().describe('Human-readable name (defaults to basename of root)'),
    },
  }, async (rawArgs) => {
    const parsed = RegisterProjectInput.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }
    const { root, name } = parsed.data;
    try {
      const project = registry.register(root, name);
      return {
        content: [{
          type: 'text' as const,
          text: `Project registered.\nName: ${project.name}\nId: ${project.id}\nRoot: ${project.root}\n\nUse \`project_id: "${project.id}"\` on tool calls to target this project.`,
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error registering project: ${msg}` }], isError: true };
    }
  });

  // ── Resources ─────────────────────────────────────────────────────────────
  // Resources show the *default* project's data. Tools accept project_id to
  // address other projects; resources stay simple by URI.
  const defaultStore = async () => (await projects.get(defaultProject.id)).store;

  server.registerResource(
    'adr-recent',
    'adr://recent',
    {
      title: 'Recent ADRs',
      description: 'Recent architectural decision records from the default project.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildAdrRecentText(await defaultStore()),
      }],
    }),
  );

  server.registerResource(
    'adr-by-id',
    new ResourceTemplate('adr://{id}', {
      list: async () => {
        const adrs = (await defaultStore()).listADR(50);
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
      description: 'Read a specific architectural decision by its ID (default project).',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const text = buildAdrByIdText(await defaultStore(), id) ?? `_ADR \`${id}\` not found._`;
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
      description: 'Recurring failure patterns from past tasks (default project). Read this before proposing changes.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildFailuresTopText(await defaultStore()),
      }],
    }),
  );

  server.registerResource(
    'tasks-recent',
    'tasks://recent',
    {
      title: 'Recent Tasks',
      description: 'Recent tasks submitted to the orchestrator with their status and result (default project).',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: buildTasksRecentText(await defaultStore()),
      }],
    }),
  );

  server.registerResource(
    'projects-list',
    'projects://list',
    {
      title: 'Registered Projects',
      description: 'All projects known to this RAG instance. Pass project_id on tools to target one.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const list = registry.list();
      if (list.length === 0) {
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '_No projects registered._' }] };
      }
      const rows = list.map((p: Project) => {
        const isDefault = p.id === defaultProject.id ? ' *(default)*' : '';
        return `- **${p.name}**${isDefault} — id \`${p.id}\` — root \`${p.root}\``;
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: `# Registered projects (${list.length})\n\n${rows.join('\n')}`,
        }],
      };
    },
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
