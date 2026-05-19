import ts from 'typescript';

/**
 * AST-anchored edit helpers for the tool-calling Coder/Fixer.
 *
 * Each `locate*` function takes file content + symbol arguments and returns a
 * StructuralEdit describing the line-level mutation to apply. The actual
 * mutation goes through WorkingSet (insertBefore / replace) so brace-balance
 * verification and rollback (v1.30.5) still wrap every write.
 *
 * Why this layer exists: replace_in_file forces the model to pick correct
 * line coordinates, and v1.30.x bench runs showed it consistently fails at
 * placement (consumed closing brace, duplicated context, off-by-one). These
 * helpers move the navigation from the model into the runtime — the model
 * names a class/method/function, the runtime walks the AST.
 *
 * Scope (v1.31): TypeScript / JavaScript only (.ts/.tsx/.js/.jsx). Top-level
 * symbols only — nested classes inside namespaces or factory functions are
 * not currently locatable. Overloaded functions: the first declaration is
 * targeted; for the implementation body of an overload, use replace_in_file.
 */

export type StructuralEdit =
  | { kind: 'insert'; line: number; text: string }
  | { kind: 'replace'; startLine: number; endLine: number; text: string }
  /**
   * Used by idempotent helpers (add_import) when the requested change is
   * already present in the file. The dispatcher returns success without
   * touching the WorkingSet; brace-balance check is skipped (no edit).
   */
  | { kind: 'noop'; reason: string };

export type LocateResult =
  | { ok: true; edit: StructuralEdit }
  | { ok: false; error: string };

function parseFile(content: string): ts.SourceFile {
  return ts.createSourceFile(
    '__locate__.ts',
    content,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
}

/**
 * Top-level class lookup by name. Doesn't descend into namespaces or factory
 * functions — keep ambiguity off for v1; if a project organizes classes
 * differently, replace_in_file remains as fallback.
 */
function findClass(sf: ts.SourceFile, name: string): ts.ClassDeclaration | null {
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return null;
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return null;
}

/**
 * v1.50 — Find a method on a class by name with three improvements over v1:
 *
 * 1. Overload disambiguation: when a name has multiple MethodDeclaration nodes
 *    (TypeScript overload signatures + implementation), prefer the one WITH a
 *    body — that is the actual implementation. Overload signatures have no body
 *    and replacing them produces a no-op or corrupts the file.
 *
 * 2. Property arrow-function fallback: real-world classes often express methods
 *    as `name: SomeType = (...) => { ... }`. These are PropertyDeclarations,
 *    not MethodDeclarations. When no MethodDeclaration matches, this function
 *    falls back to a PropertyDeclaration whose initializer is an ArrowFunction
 *    — returned as-is so the caller can build a replace_in_file edit instead.
 *    The return type is broadened to ClassElement to cover both cases.
 *
 * 3. nearLine hint: when multiple candidates with bodies remain, pick the one
 *    whose start line is closest to nearLine (1-based). Without a hint the last
 *    with-body candidate is returned (implementation overload convention).
 */
function findMethod(
  cls: ts.ClassDeclaration,
  name: string,
  sf?: ts.SourceFile,
  nearLine?: number,
): ts.MethodDeclaration | ts.PropertyDeclaration | null {
  // Collect all MethodDeclaration candidates.
  const methodCandidates: ts.MethodDeclaration[] = [];
  for (const m of cls.members) {
    if (
      ts.isMethodDeclaration(m) &&
      m.name &&
      ts.isIdentifier(m.name) &&
      m.name.text === name
    ) {
      methodCandidates.push(m);
    }
  }

  if (methodCandidates.length > 0) {
    if (methodCandidates.length === 1) return methodCandidates[0];

    // Multiple → prefer candidates with a body (implementation overloads).
    const withBody = methodCandidates.filter(m => m.body !== undefined);
    const pool = withBody.length > 0 ? withBody : methodCandidates;

    if (pool.length === 1) return pool[0];

    // Use nearLine to pick the closest candidate.
    if (nearLine !== undefined && sf) {
      return pool.reduce((best, m) => {
        const lineM = sf.getLineAndCharacterOfPosition(m.getStart(sf, false)).line + 1;
        const lineBest = sf.getLineAndCharacterOfPosition(best.getStart(sf, false)).line + 1;
        return Math.abs(lineM - nearLine) < Math.abs(lineBest - nearLine) ? m : best;
      });
    }

    // Fallback: last candidate with body (implementation is always last in TS).
    return pool[pool.length - 1];
  }

  // Property arrow-function fallback.
  for (const m of cls.members) {
    if (
      ts.isPropertyDeclaration(m) &&
      m.name &&
      ts.isIdentifier(m.name) &&
      m.name.text === name &&
      m.initializer &&
      ts.isArrowFunction(m.initializer)
    ) {
      return m;
    }
  }

  return null;
}

/**
 * Inspect the source argument the model passed for add_method/replace_method.
 * Wraps it in `class _ { ... }` and parses; the wrapper must contain exactly
 * one MethodDeclaration with a simple identifier name. Returns the name so
 * add_method can derive it (no duplicate `name` arg) and replace_method can
 * cross-check against its `name` parameter.
 */
function parseMethodSource(source: string): { name: string } | { error: string } {
  const wrapped = `class _Wrapper_ {\n${source}\n}`;
  const sf = ts.createSourceFile('_method_source_.ts', wrapped, ts.ScriptTarget.Latest, true);
  if (sf.statements.length === 0) {
    return { error: 'source is empty' };
  }
  const cls = sf.statements[0];
  if (!ts.isClassDeclaration(cls)) {
    return { error: 'could not parse source as a method declaration' };
  }
  if (cls.members.length !== 1) {
    return {
      error: `source must declare exactly one method; parser saw ${cls.members.length} class member(s). Pass only the method, not surrounding class/syntax`,
    };
  }
  const m = cls.members[0];
  if (!ts.isMethodDeclaration(m)) {
    return { error: 'source is not a method declaration (constructors, getters, setters, and fields are not supported here)' };
  }
  if (!m.name || !ts.isIdentifier(m.name)) {
    return { error: 'method name must be a simple identifier (computed names are not supported)' };
  }
  return { name: m.name.text };
}

/**
 * Inspect the source argument the model passed for replace_function.
 * Top-level FunctionDeclaration only.
 */
function parseFunctionSource(source: string): { name: string } | { error: string } {
  const sf = ts.createSourceFile('_fn_source_.ts', source, ts.ScriptTarget.Latest, true);
  if (sf.statements.length === 0) {
    return { error: 'source is empty' };
  }
  if (sf.statements.length !== 1) {
    return {
      error: `source must contain exactly one top-level statement; parser saw ${sf.statements.length}. Pass only the function declaration`,
    };
  }
  const stmt = sf.statements[0];
  if (!ts.isFunctionDeclaration(stmt)) {
    return { error: 'source must be a top-level function declaration (e.g. `function foo() { ... }`)' };
  }
  if (!stmt.name) {
    return { error: 'function declaration must have a name' };
  }
  return { name: stmt.name.text };
}

/**
 * Read the leading whitespace of a 0-indexed line in the file content. Used
 * to discover the project's indent style (tabs vs spaces, 2 vs 4) by reading
 * an existing member instead of guessing.
 */
function lineIndent(content: string, line0: number): string {
  const lines = content.split('\n');
  const ln = lines[line0] ?? '';
  const m = ln.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * Re-indent multi-line source so its left edge sits at `targetIndent`. Detects
 * the source's intrinsic indent (the min leading whitespace among non-empty
 * lines) and strips that before prepending `targetIndent`. Empty lines stay
 * empty (no trailing whitespace).
 *
 * This lets the model write a method body with whatever indentation feels
 * natural ("0 spaces" or "2 spaces"); the runtime normalizes to match the
 * destination's style. Tabs and spaces are counted by character length —
 * mixed-indent source isn't perfectly handled but the common case (consistent
 * spaces) works correctly.
 */
function reindent(source: string, targetIndent: string): string {
  const lines = source.split('\n');
  let baseIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.match(/^[ \t]*/);
    const w = m ? m[0].length : 0;
    if (w < baseIndent) baseIndent = w;
  }
  if (baseIndent === Infinity) baseIndent = 0;
  return lines
    .map(line => {
      if (line.trim() === '') return '';
      return targetIndent + line.slice(baseIndent);
    })
    .join('\n');
}

/**
 * add_method: insert a new method declaration into a named top-level class,
 * positioned just before the class's closing brace. The model passes the
 * full method source (`async getSize(): Promise<number> { ... }`) — the name
 * is extracted from the AST so model and runtime can't disagree.
 *
 * Errors when:
 *  - source isn't a single method declaration
 *  - container class isn't found at top level
 *  - a method with the same name already exists (use replace_method instead)
 *  - the class's closing brace isn't on its own line (style we can't safely
 *    edit without picking apart the rest of the line)
 */
export function locateAddMethod(
  content: string,
  container: string,
  source: string,
): LocateResult {
  const parsed = parseMethodSource(source);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { name } = parsed;

  const sf = parseFile(content);
  const cls = findClass(sf, container);
  if (!cls) return { ok: false, error: `class ${container} not found at top level` };

  if (findMethod(cls, name)) {
    return {
      ok: false,
      error: `method ${container}.${name} already exists; use replace_method to change its body`,
    };
  }

  // Closing brace position: getEnd() points to the byte after `}`, so the
  // brace itself is at getEnd()-1. We resolve to its 0-indexed line.
  const closeBracePos = cls.getEnd() - 1;
  const { line: closeBraceLine0 } = sf.getLineAndCharacterOfPosition(closeBracePos);

  // Refuse if the closing brace shares its line with other code — adding
  // before "line N" then would corrupt the rest of the line.
  const lines = content.split('\n');
  const closeBraceLineText = lines[closeBraceLine0] ?? '';
  if (closeBraceLineText.trim() !== '}') {
    return {
      ok: false,
      error: `class ${container} closing brace shares its line with other content (\`${closeBraceLineText.trim()}\`); refactor to a multi-line class first`,
    };
  }

  // Member indent: copy from first existing member, or class indent + 2 spaces.
  let memberIndent: string;
  if (cls.members.length > 0) {
    const firstMember = cls.members[0];
    const startPos = firstMember.getStart(sf, false);
    const { line: ml0 } = sf.getLineAndCharacterOfPosition(startPos);
    memberIndent = lineIndent(content, ml0);
  } else {
    memberIndent = lineIndent(content, closeBraceLine0) + '  ';
  }

  const indented = reindent(source, memberIndent);

  // Existing members → leading blank line for breathing room. Empty class →
  // no blank line. Trailing newline never added: the closing-brace line is
  // already the next thing in the file (insertBefore squeezes us in).
  const text = (cls.members.length > 0 ? '\n' : '') + indented;

  return {
    ok: true,
    edit: { kind: 'insert', line: closeBraceLine0 + 1, text },
  };
}

/**
 * replace_method: rewrite the body+signature of a named method on a top-level
 * class. The model's `source` must declare a method whose name matches `name`
 * — to rename, use delete + add_method instead. Modifiers and decorators in
 * the new source replace the old ones; jsdoc comments above the method are
 * preserved (they sit on different lines outside the replace range).
 */
export function locateReplaceMethod(
  content: string,
  container: string,
  name: string,
  source: string,
  nearLine?: number,
): LocateResult {
  const parsed = parseMethodSource(source);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  if (parsed.name !== name) {
    return {
      ok: false,
      error:
        `source declares method '${parsed.name}' but replace_method was called with name='${name}'. ` +
        `Either match the names, or delete the old method and add_method the new one to rename.`,
    };
  }

  const sf = parseFile(content);
  const cls = findClass(sf, container);
  if (!cls) return { ok: false, error: `class ${container} not found at top level` };

  const method = findMethod(cls, name, sf, nearLine);
  if (!method) return { ok: false, error: `method ${container}.${name} not found` };

  // v1.50 — property arrow functions (ts.PropertyDeclaration) are not directly
  // replaceable via method-rewrite — guide the Coder to use replace_in_file.
  // v1.55 — include the current source so Coder skips the read_file round-trip.
  if (ts.isPropertyDeclaration(method)) {
    const startPos = method.getStart(sf, false);
    const endPos = method.getEnd();
    const { line: startLine0 } = sf.getLineAndCharacterOfPosition(startPos);
    const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);
    const currentLines = content.split('\n').slice(startLine0, endLine0 + 1).join('\n');
    return {
      ok: false,
      error:
        `${container}.${name} is a property arrow function, not a method declaration. ` +
        `Use replace_in_file(file, ${startLine0 + 1}, ${endLine0 + 1}, new_text) ` +
        `where new_text is the full replacement including the trailing semicolon.\n` +
        `Current content (lines ${startLine0 + 1}–${endLine0 + 1}):\n${currentLines}`,
    };
  }

  const startPos = method.getStart(sf, /*includeJsDoc*/ false);
  const endPos = method.getEnd();
  const { line: startLine0 } = sf.getLineAndCharacterOfPosition(startPos);
  const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);

  const targetIndent = lineIndent(content, startLine0);
  const indented = reindent(source, targetIndent);

  return {
    ok: true,
    edit: {
      kind: 'replace',
      startLine: startLine0 + 1,
      endLine: endLine0 + 1,
      text: indented,
    },
  };
}

/**
 * replace_function: rewrite a top-level FunctionDeclaration. Overloaded
 * function declarations resolve to the first matching node, which for an
 * overload group is the signature stub, not the implementation — model
 * should use replace_in_file for the implementation body in that case.
 */
export function locateReplaceFunction(
  content: string,
  name: string,
  source: string,
): LocateResult {
  const parsed = parseFunctionSource(source);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  if (parsed.name !== name) {
    return {
      ok: false,
      error:
        `source declares function '${parsed.name}' but replace_function was called with name='${name}'.`,
    };
  }

  const sf = parseFile(content);
  const fn = findFunction(sf, name);
  if (!fn) return { ok: false, error: `top-level function ${name} not found` };

  const startPos = fn.getStart(sf, /*includeJsDoc*/ false);
  const endPos = fn.getEnd();
  const { line: startLine0 } = sf.getLineAndCharacterOfPosition(startPos);
  const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);

  const targetIndent = lineIndent(content, startLine0);
  const indented = reindent(source, targetIndent);

  return {
    ok: true,
    edit: {
      kind: 'replace',
      startLine: startLine0 + 1,
      endLine: endLine0 + 1,
      text: indented,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Fastify route insertion (add_route)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Identifiers we recognize as a Fastify-style instance (the `app` in
 * `app.get('/x', ...)`). Conservative list — avoids false positives like
 * `mockServer.get(...)` or `cache.get(...)` in test files.
 */
const FASTIFY_TARGETS = new Set(['app', 'server', 'fastify', 'instance', 'route']);

/** HTTP methods Fastify exposes on the instance. */
const FASTIFY_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

interface RouteCall {
  method: string;
  path: string;
  /** Identifier text used in the existing call (e.g. 'app' or 'server'). */
  target: string;
  /** The wrapping ExpressionStatement — its line range is what we anchor to. */
  statement: ts.ExpressionStatement;
}

function findRouteCalls(sf: ts.SourceFile): RouteCall[] {
  const calls: RouteCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ts.isIdentifier(node.expression.name)
    ) {
      const target = node.expression.expression.text;
      const method = node.expression.name.text.toLowerCase();
      if (FASTIFY_TARGETS.has(target) && FASTIFY_METHODS.has(method)) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          // Walk up to the wrapping ExpressionStatement so we can take a
          // line range that includes the trailing `;`.
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isExpressionStatement(parent)) parent = parent.parent;
          if (parent && ts.isExpressionStatement(parent)) {
            calls.push({
              method,
              path: firstArg.text,
              target,
              statement: parent,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/**
 * add_route: insert a new Fastify-style route call after the last existing
 * route in the file. Anchors against existing routes so the insertion sits
 * inside the same plugin/build function and uses the right instance name
 * (app / server / fastify / instance / route, copied from the last route).
 *
 * Limitations:
 *  - File must already have at least one Fastify route. Bootstrap (zero
 *    routes) is out of scope for v1 — there's no reliable way to identify
 *    "where routes go" in an empty file. Use create_file or replace_in_file.
 *  - Path is rendered as a single-quoted string literal — must not contain
 *    a single quote, backslash, or newline. If it does, falls back to error.
 *  - No support for schema/options arguments. If the route needs `{schema:
 *    ...}`, the model adds it via replace_in_file after.
 */
export function locateAddRoute(
  content: string,
  http_method: string,
  route_path: string,
  body: string,
  params: string = '(request, reply)',
): LocateResult {
  const method = http_method.toLowerCase();
  if (!FASTIFY_METHODS.has(method)) {
    return {
      ok: false,
      error: `unknown HTTP method '${http_method}'; expected one of: ${[...FASTIFY_METHODS].join(', ').toUpperCase()}`,
    };
  }
  if (route_path.includes("'") || route_path.includes('\\') || route_path.includes('\n')) {
    return {
      ok: false,
      error: `route_path '${route_path}' contains characters (quote, backslash, newline) not safe to render as a single-quoted literal — escape manually with replace_in_file`,
    };
  }

  const sf = parseFile(content);
  const routes = findRouteCalls(sf);
  if (routes.length === 0) {
    return {
      ok: false,
      error:
        'no Fastify route calls (app.get/post/put/...) found in this file; cannot anchor add_route. Bootstrap routes via create_file or replace_in_file first',
    };
  }

  for (const r of routes) {
    if (r.method === method && r.path === route_path) {
      return {
        ok: false,
        error: `route ${method.toUpperCase()} ${route_path} already exists in this file (line ${sf.getLineAndCharacterOfPosition(r.statement.getStart(sf, false)).line + 1}); remove it first or use replace_in_file to modify`,
      };
    }
  }

  // Pick the last route by file position. That's where new routes naturally
  // accumulate, and copying its target name + indent gives consistent style.
  const last = routes.reduce((a, b) =>
    a.statement.getEnd() > b.statement.getEnd() ? a : b,
  );
  const lastEndPos = last.statement.getEnd();
  const { line: lastEndLine0 } = sf.getLineAndCharacterOfPosition(lastEndPos);

  const lastStartPos = last.statement.getStart(sf, /*includeJsDoc*/ false);
  const { line: lastStartLine0 } = sf.getLineAndCharacterOfPosition(lastStartPos);
  const callIndent = lineIndent(content, lastStartLine0);
  // Doubling callIndent is the cheapest way to detect the project's indent
  // unit: 2 spaces → body at 4, 4 spaces → body at 8, tabs → two tabs. Falls
  // back to 2 spaces when the route is somehow at column 0.
  const bodyIndent = callIndent.length > 0 ? callIndent + callIndent : '  ';
  const indentedBody = reindent(body, bodyIndent);

  const route =
    `${callIndent}${last.target}.${method}('${route_path}', async ${params} => {\n` +
    `${indentedBody}\n` +
    `${callIndent}});`;

  // Leading blank line for breathing room from the previous route.
  const text = '\n' + route;

  return {
    ok: true,
    edit: { kind: 'insert', line: lastEndLine0 + 2, text },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Import management (add_import)
 * ───────────────────────────────────────────────────────────────────────── */

interface ParsedImport {
  defaultName: string | undefined;
  named: string[];
  typeOnly: boolean;
}

function parseExistingImport(decl: ts.ImportDeclaration): ParsedImport | null {
  const clause = decl.importClause;
  if (!clause) return { defaultName: undefined, named: [], typeOnly: false };

  const typeOnly = clause.isTypeOnly === true;
  const defaultName = clause.name?.text;
  let named: string[] = [];
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      // `import * as ns from 'mod';` — out of scope for merge in v1.
      return null;
    }
    if (ts.isNamedImports(clause.namedBindings)) {
      named = clause.namedBindings.elements.map(e => e.name.text);
    }
  }
  return { defaultName, named, typeOnly };
}

function renderImport(
  source: string,
  named: string[],
  defaultName: string | undefined,
  typeOnly: boolean,
): string {
  const typeKw = typeOnly ? 'type ' : '';
  const parts: string[] = [];
  if (defaultName) parts.push(defaultName);
  if (named.length > 0) {
    // Sort named imports alphabetically so identical inputs render the same
    // text — keeps merge output stable and easier to diff.
    const sorted = [...new Set(named)].sort();
    parts.push(`{ ${sorted.join(', ')} }`);
  }
  if (parts.length === 0) {
    return `import '${source}';`;
  }
  return `import ${typeKw}${parts.join(', ')} from '${source}';`;
}

/**
 * add_import: ensure the file imports the requested names from `source`.
 * Idempotent — if every requested name (and default) is already present
 * with matching type-only flag, returns a noop edit. If an import from the
 * same source already exists with a compatible shape, the existing import
 * line range is replaced with a merged version. Otherwise a new import is
 * appended after the last existing import (or at the top of the file).
 */
export function locateAddImport(
  content: string,
  source: string,
  names: string[] = [],
  defaultName?: string,
  typeOnly: boolean = false,
): LocateResult {
  const sf = parseFile(content);

  let existing: ts.ImportDeclaration | null = null;
  let lastImport: ts.ImportDeclaration | null = null;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === source &&
      !existing
    ) {
      existing = stmt;
    }
    lastImport = stmt;
  }

  if (existing) {
    const parsed = parseExistingImport(existing);
    if (!parsed) {
      return {
        ok: false,
        error: `existing import from '${source}' uses a namespace form (import * as ...) that add_import does not merge in v1 — modify with replace_in_file`,
      };
    }
    if (parsed.typeOnly !== typeOnly) {
      return {
        ok: false,
        error: `existing import from '${source}' is ${parsed.typeOnly ? 'type-only' : 'value'}; request was ${typeOnly ? 'type-only' : 'value'}. Type-only flag must match`,
      };
    }
    if (defaultName && parsed.defaultName && parsed.defaultName !== defaultName) {
      return {
        ok: false,
        error: `existing import from '${source}' has default name '${parsed.defaultName}'; cannot replace with '${defaultName}' — drop the default rename or modify manually`,
      };
    }

    const wantedDefault = defaultName ?? parsed.defaultName;
    const haveAllNames = names.every(n => parsed.named.includes(n));
    const haveDefault = !defaultName || parsed.defaultName === defaultName;
    if (haveAllNames && haveDefault) {
      return {
        ok: true,
        edit: {
          kind: 'noop',
          reason: `import from '${source}' already includes all requested names${defaultName ? ` and default '${defaultName}'` : ''}`,
        },
      };
    }

    const mergedNamed = [...new Set([...parsed.named, ...names])].sort();
    const newText = renderImport(source, mergedNamed, wantedDefault, parsed.typeOnly);

    const startPos = existing.getStart(sf, false);
    const endPos = existing.getEnd();
    const { line: startLine0 } = sf.getLineAndCharacterOfPosition(startPos);
    const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);
    return {
      ok: true,
      edit: {
        kind: 'replace',
        startLine: startLine0 + 1,
        endLine: endLine0 + 1,
        text: newText,
      },
    };
  }

  // No existing import from this source — fresh insert.
  const newText = renderImport(source, names, defaultName, typeOnly);
  if (lastImport) {
    const endPos = lastImport.getEnd();
    const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);
    return {
      ok: true,
      edit: { kind: 'insert', line: endLine0 + 2, text: newText },
    };
  }
  // No imports anywhere — top of file. Add a trailing newline so the next
  // statement isn't crammed onto the same line.
  return {
    ok: true,
    edit: { kind: 'insert', line: 1, text: newText + '\n' },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Top-level export (add_export)
 * ───────────────────────────────────────────────────────────────────────── */

function isTopLevelExport(stmt: ts.Statement): boolean {
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return true;
  const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  if (modifiers) {
    return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

/**
 * add_export: append a new top-level export. The `source` arg is the full
 * statement text (`export const X = ...;` or `export function foo() {...}`).
 * Insertion point preference: after the last existing top-level export,
 * else after the last import, else at the top of the file. A leading blank
 * line is added when there's a previous statement to separate from.
 */
export function locateAddExport(content: string, source: string): LocateResult {
  const tempSf = ts.createSourceFile('_export_.ts', source, ts.ScriptTarget.Latest, true);
  if (tempSf.statements.length !== 1) {
    return {
      ok: false,
      error: `source must be exactly one statement; parser saw ${tempSf.statements.length}. Pass a single export declaration`,
    };
  }
  const stmt = tempSf.statements[0];
  if (!isTopLevelExport(stmt)) {
    return {
      ok: false,
      error:
        'source must be a top-level export (e.g. `export const ...`, `export function ...`, `export type ...`, `export { ... }`)',
    };
  }

  // Extract the declared name from the new export to guard against duplicates.
  const newName = (() => {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return stmt.name?.text;
    if (ts.isVariableStatement(stmt)) return stmt.declarationList.declarations[0]?.name && ts.isIdentifier(stmt.declarationList.declarations[0].name) ? stmt.declarationList.declarations[0].name.text : undefined;
    return undefined;
  })();

  const sf = parseFile(content);

  // Reject if a top-level symbol with the same name already exists — prevents
  // duplicate definitions when Coder calls add_export twice in one step.
  if (newName) {
    for (const s of sf.statements) {
      const existingName = ts.isFunctionDeclaration(s) ? s.name?.text
        : ts.isClassDeclaration(s) ? s.name?.text
        : ts.isVariableStatement(s) && ts.isIdentifier(s.declarationList.declarations[0]?.name) ? s.declarationList.declarations[0].name.text
        : undefined;
      if (existingName === newName) {
        return { ok: false, error: `'${newName}' already exists in this file — call done() if you have already added it, or use replace_function/replace_in_file to modify the existing definition` };
      }
    }
  }

  let lastExport: ts.Statement | null = null;
  let lastImport: ts.Statement | null = null;
  for (const s of sf.statements) {
    if (isTopLevelExport(s)) lastExport = s;
    else if (ts.isImportDeclaration(s)) lastImport = s;
  }

  const anchor = lastExport ?? lastImport;
  if (anchor) {
    const endPos = anchor.getEnd();
    const { line: endLine0 } = sf.getLineAndCharacterOfPosition(endPos);
    return {
      ok: true,
      edit: { kind: 'insert', line: endLine0 + 2, text: '\n' + source },
    };
  }
  // Bare file with no imports/exports yet — insert at top.
  return {
    ok: true,
    edit: { kind: 'insert', line: 1, text: source + '\n' },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Type member insertion (add_type_member)
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * add_type_member: insert a new member into a top-level interface or type-alias
 * object type. The model names the type and passes the member declaration text
 * (e.g. `retry?: number`); the runtime locates the closing `}` and inserts the
 * member before it, using the existing member indent style.
 *
 * Handles: InterfaceDeclaration, TypeAliasDeclaration whose type is TypeLiteral.
 * Errors when:
 *  - the named type is not found at top level
 *  - it's a type alias but not an object literal type
 *  - a member with the same name already exists (use replace_in_file to change it)
 *  - the closing `}` is not on its own line
 */
export function locateAddTypeMember(
  content: string,
  typeName: string,
  member: string,
): LocateResult {
  const sf = parseFile(content);

  // Find interface or type alias.
  let membersNode: ts.NodeArray<ts.TypeElement> | null = null;
  let closingBraceParent: ts.Node | null = null;

  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === typeName) {
      membersNode = stmt.members;
      closingBraceParent = stmt;
      break;
    }
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === typeName) {
      if (ts.isTypeLiteralNode(stmt.type)) {
        membersNode = stmt.type.members;
        closingBraceParent = stmt.type;
        break;
      }
      // v1.65d — intersection types (A & { ... }). Find the rightmost
      // TypeLiteral in the intersection and add the member there.
      // Common in adapter/option types: `type Opts<T> = Base<T> & { extra: ... }`
      if (ts.isIntersectionTypeNode(stmt.type)) {
        const literals = stmt.type.types.filter(ts.isTypeLiteralNode);
        if (literals.length > 0) {
          const target = literals[literals.length - 1];
          membersNode = target.members;
          closingBraceParent = target;
          break;
        }
        return {
          ok: false,
          error: `type alias '${typeName}' is an intersection but has no inline object literal to extend — use replace_in_file`,
        };
      }
      return {
        ok: false,
        error: `type alias '${typeName}' exists but is not an object type literal or intersection — use replace_in_file`,
      };
    }
  }

  if (!closingBraceParent || membersNode === null) {
    return { ok: false, error: `interface or object type '${typeName}' not found at top level` };
  }

  // Check for existing member with the same name.
  const memberNameMatch = member.match(/^(\w+)/);
  if (memberNameMatch) {
    const newName = memberNameMatch[1];
    for (const m of membersNode) {
      if (m.name && ts.isIdentifier(m.name) && m.name.text === newName) {
        return {
          ok: false,
          error: `member '${newName}' already exists in '${typeName}'; use replace_in_file to modify it`,
        };
      }
    }
  }

  // Closing brace: getEnd() - 1 for `}`.
  const closeBracePos = closingBraceParent.getEnd() - 1;
  const { line: closeBraceLine0 } = sf.getLineAndCharacterOfPosition(closeBracePos);

  const lines = content.split('\n');
  const closeBraceLineText = lines[closeBraceLine0] ?? '';
  if (closeBraceLineText.trim() !== '}' && closeBraceLineText.trim() !== '};') {
    return {
      ok: false,
      error:
        `'${typeName}' closing brace shares its line with other content; ` +
        `use replace_in_file to add the member manually`,
    };
  }

  // Derive indent from existing members or closing brace + 2 spaces.
  let memberIndent: string;
  if (membersNode.length > 0) {
    const first = membersNode[0];
    const { line: ml0 } = sf.getLineAndCharacterOfPosition(first.getStart(sf, false));
    memberIndent = lineIndent(content, ml0);
  } else {
    memberIndent = lineIndent(content, closeBraceLine0) + '  ';
  }

  // Normalize member: strip trailing semicolons and add one consistently.
  const memberTrimmed = member.replace(/;+$/, '');
  const text = (membersNode.length > 0 ? '' : '') + `${memberIndent}${memberTrimmed};\n`;

  return {
    ok: true,
    edit: { kind: 'insert', line: closeBraceLine0 + 1, text },
  };
}
