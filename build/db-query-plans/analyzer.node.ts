// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Statically enumerates every SQL query shape that can reach `db.prepare()`.
 *
 * This is a small path-sensitive abstract interpreter over the TypeScript AST,
 * built on the TypeScript 7 (tsgo) API. It understands the `sql`,
 * `sqlFragment`, `sqlJoin`, `sqlConstant` and `sqlId` helpers from
 * `ts/sql/util.std.ts`, plus plain string templates.
 *
 * Every function in the analyzed files is interpreted with its parameters
 * bound to symbolic values whose possible values come from the type checker
 * (e.g. `order: 'older' | 'newer' | 'bigger'`). When a branch depends on one
 * of those values the interpreter forks and narrows the value on each side, so
 * correlated branches (checking `order` twice) don't produce impossible
 * combinations.
 *
 * Anything the interpreter can't follow is reported as an "issue" on the
 * prepare() site instead of being guessed at.
 */

import { relative } from 'node:path';
import { API, SymbolFlags, TypeFlags } from 'typescript-7/sync';
import type { Checker, Project, Type } from 'typescript-7/sync';
import { NodeFlags, SyntaxKind } from 'typescript-7/ast';
import type { SourceFile } from 'typescript-7/ast';

import { Scope } from './scope.std.ts';
import { State } from './state.std.ts';
import { UNDEFINED, UNKNOWN, lit, opaque } from './values.std.ts';
import type {
  AnyNode,
  Domain,
  DomainEntry,
  FileRef,
  Lit,
  Value,
} from './values.std.ts';

const MAX_STATES = 256;
const MAX_CALL_DEPTH = 8;

type Flow = {
  normal: Array<State>;
  returned: Array<[State, Value]>;
  broke: Array<State>;
};

function emptyFlow(): Flow {
  return { normal: [], returned: [], broke: [] };
}

type Results = Array<[State, Value]>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type QueryVariant = {
  sql: string;
  // Alternative sets of constraints on parameters that produce this SQL
  // (outer array is OR, inner array is AND). Empty when there's no
  // distinguishing condition the analyzer could name.
  conditions: ReadonlyArray<ReadonlyArray<string>>;
  notes: ReadonlyArray<string>;
};

export type QuerySite = {
  file: string;
  functionName: string;
  // 1-based index of this prepare() call within the function
  ordinal: number;
  line: number;
  variants: ReadonlyArray<QueryVariant>;
  issues: ReadonlyArray<string>;
  // `CREATE TEMP TABLE ...` statements run via db.exec() in this function,
  // needed so EXPLAIN can see the temp tables.
  setup: ReadonlyArray<string>;
};

type SiteRecord = {
  file: string;
  functionName: string;
  pos: number;
  line: number;
  sql: Map<string, { conditions: Array<PathConditions>; notes: Set<string> }>;
  issues: Set<string>;
};

type PathConditions = {
  // Narrowed parameters, e.g. `order = "older"`
  refined: ReadonlyArray<string>;
  // Other conditions, e.g. `limit > 0`
  trail: ReadonlyArray<string>;
};

type FileContext = {
  // also satisfies FileRef
  sourceFile: SourceFile;
  path: string;
  moduleScope: Scope;
  // name -> top-level declaration node
  declarations: Map<string, AnyNode>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Function values only ever capture the FileContext they were created in
function contextOf(ref: FileRef): FileContext {
  return ref as FileContext;
}

function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    current.kind === SyntaxKind.ParenthesizedExpression ||
    current.kind === SyntaxKind.AsExpression ||
    current.kind === SyntaxKind.SatisfiesExpression ||
    current.kind === SyntaxKind.NonNullExpression ||
    current.kind === SyntaxKind.TypeAssertionExpression ||
    current.kind === SyntaxKind.AwaitExpression
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionLike(node: AnyNode): boolean {
  return (
    node.kind === SyntaxKind.ArrowFunction ||
    node.kind === SyntaxKind.FunctionExpression ||
    node.kind === SyntaxKind.FunctionDeclaration ||
    node.kind === SyntaxKind.MethodDeclaration
  );
}

function lineOf(sourceFile: SourceFile, pos: number): number {
  const { text } = sourceFile;
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function formatLit(value: Lit): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  return String(value);
}

function isNullish(value: Lit): boolean {
  return value == null;
}

function litTruthy(value: Lit): boolean {
  return Boolean(value);
}

function strictEq(a: Lit, b: Lit): boolean {
  return a === b;
}

function looseEq(a: Lit, b: Lit): boolean {
  if (isNullish(a) || isNullish(b)) {
    return isNullish(a) && isNullish(b);
  }
  // oxlint-disable-next-line eqeqeq
  return a == b;
}

function fingerprint(state: State): string {
  const parts: Array<string> = [];
  for (const [key, value] of state.values) {
    if (value.kind === 'unknown') {
      continue;
    }
    parts.push(`${key}=${valueFingerprint(value)}`);
  }
  for (const [id, domain] of state.refined) {
    parts.push(`?${id}=${domainToString(domain)}`);
  }
  return parts.join('\n');
}

function valueFingerprint(value: Value): string {
  switch (value.kind) {
    case 'lit':
      return `L${formatLit(value.value)}`;
    case 'tmpl':
      return `T${value.text}`;
    case 'frag':
      return `F${value.sql}`;
    case 'sym':
      return `S${value.id}`;
    case 'unknown':
      return 'U';
    case 'opaque':
      return `O${value.reason}`;
    case 'array':
      return `[${value.items.map(valueFingerprint).join(',')}]`;
    case 'repeated':
      return `R(${valueFingerprint(value.item)})`;
    case 'object':
      return `{${[...value.props]
        .map(([k, v]) => `${k}:${valueFingerprint(v)}`)
        .join(',')}}`;
    case 'func':
      return `fn@${value.node.pos}`;
    default:
      throw new Error('unreachable');
  }
}

function domainToString(domain: Domain): string {
  return domain
    .map(entry => (entry.kind === 'lit' ? formatLit(entry.value) : '*'))
    .join('|');
}

// Could this value end up in SQL text (or decide what SQL text is built)?
function isSqlish(value: Value): boolean {
  switch (value.kind) {
    case 'frag':
    case 'tmpl':
    case 'func':
    case 'opaque':
      return true;
    case 'lit':
      return typeof value.value === 'string';
    case 'array':
      return value.items.some(isSqlish);
    case 'repeated':
      return isSqlish(value.item);
    case 'object':
      return [...value.props.values()].some(isSqlish);
    default:
      return false;
  }
}

// Forking on values that can never reach SQL text just multiplies paths
// (e.g. building a big object literal full of `x ? a : b`), so collapse them.
function collapse(state: State, results: Results): Results {
  if (results.length <= 1 || results.some(([, value]) => isSqlish(value))) {
    return results;
  }
  // Keep `const isFoo = a != null || b != null` so later checks stay correlated
  if (
    results.every(
      ([, value]) => value.kind === 'lit' && typeof value.value === 'boolean'
    )
  ) {
    return results;
  }
  return [[state, UNKNOWN]];
}

function dedupe(states: Array<State>): Array<State> {
  const seen = new Map<string, State>();
  for (const state of states) {
    const key = fingerprint(state);
    const existing = seen.get(key);
    if (existing == null) {
      seen.set(key, state);
    } else {
      for (const [condition, truthy] of existing.trail) {
        if (state.trail.get(condition) !== truthy) {
          existing.trail.delete(condition);
        }
      }
    }
  }
  return [...seen.values()];
}

function conditionText(node: AnyNode): string | undefined {
  const text = node.getText().replace(/\s+/g, ' ').trim();
  return text.length <= 60 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

type AnalyzeOptions = {
  cwd: string;
  tsconfig: string;
  files: ReadonlyArray<string>;
};

export function analyze(options: AnalyzeOptions): Array<QuerySite> {
  const api = new API({ cwd: options.cwd });
  try {
    const snapshot = api.createSnapshot({ openFiles: [...options.files] });
    const project = snapshot.getDefaultProjectForFile(options.files[0] ?? '');
    if (project == null) {
      throw new Error(`No TypeScript project found for ${options.files[0]}`);
    }
    const analyzer = new Analyzer(project, options.cwd);
    for (const file of options.files) {
      analyzer.analyzeFile(file);
    }
    return analyzer.results();
  } finally {
    api.close();
  }
}

class Analyzer {
  readonly #project: Project;
  readonly #checker: Checker;
  readonly #cwd: string;
  readonly #sites = new Map<string, SiteRecord>();
  readonly #files = new Map<string, FileContext>();
  readonly #domainCache = new Map<string, Domain | null>();
  readonly #fragmentFnCache = new Map<string, boolean>();
  readonly #moduleValueCache = new Map<string, Value>();
  // root function -> temp table DDL
  readonly #setup = new Map<string, Set<string>>();
  #invocation = 0;
  #depth = 0;
  #rootName = '';
  #rootFile = '';
  // Functions passed to unknown callees that we've already explored for this
  // root, to keep `db.transaction(() => ...)` from being re-run on every fork.
  #explored = new Set<string>();

  constructor(project: Project, cwd: string) {
    this.#project = project;
    this.#checker = project.checker;
    this.#cwd = cwd;
  }

  analyzeFile(fileName: string): void {
    const file = this.#fileContext(fileName);
    for (const [name, decl] of file.declarations) {
      const fn = this.#asFunction(decl);
      if (fn == null) {
        continue;
      }
      if (this.#isFragmentFunction(fn, file)) {
        // Only meaningful when inlined at a call site with real arguments
        continue;
      }
      this.#analyzeRoot(name, fn, file);
    }
  }

  results(): Array<QuerySite> {
    const byFunction = new Map<string, Array<SiteRecord>>();
    for (const site of this.#sites.values()) {
      const key = `${site.file}\0${site.functionName}`;
      let list = byFunction.get(key);
      if (list == null) {
        list = [];
        byFunction.set(key, list);
      }
      list.push(site);
    }

    const output: Array<QuerySite> = [];
    for (const list of byFunction.values()) {
      list.sort((a, b) => a.pos - b.pos);
      list.forEach((site, index) => {
        const labelOf = (v: QueryVariant) =>
          v.conditions.map(c => c.join(', ')).join(' | ');
        const summarize = (includeTrail: boolean) => {
          const pick = (path: PathConditions) =>
            includeTrail ? [...path.refined, ...path.trail] : path.refined;
          // Conditions that hold for every path to this site aren't interesting
          const siteCommon = intersect(
            [...site.sql.values()].flatMap(info => info.conditions.map(pick))
          );
          return [...site.sql].map(([sql, info]) => ({
            sql,
            conditions: alternatives(info.conditions.map(pick), siteCommon),
            notes: [...info.notes].sort(),
          }));
        };
        // Prefer labels in terms of parameters; only mention other conditions
        // (`limit > 0`) when that's the only way to tell variants apart.
        let variants: Array<QueryVariant> = summarize(false);
        const ambiguous = variants.map((variant, i) =>
          variants.some(
            (other, j) =>
              j !== i && overlaps(variant.conditions, other.conditions)
          )
        );
        if (ambiguous.some(Boolean)) {
          const withTrail = summarize(true);
          variants = variants.map((variant, i) =>
            ambiguous[i] ? (withTrail[i] ?? variant) : variant
          );
        }
        variants.sort(
          (a, b) =>
            labelOf(a).localeCompare(labelOf(b)) || a.sql.localeCompare(b.sql)
        );
        output.push({
          file: site.file,
          functionName: site.functionName,
          ordinal: index + 1,
          line: site.line,
          variants,
          issues: [...site.issues].sort(),
          setup: [
            ...(this.#setup.get(`${site.file}\0${site.functionName}`) ?? []),
          ],
        });
      });
    }
    output.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.functionName.localeCompare(b.functionName) ||
        a.ordinal - b.ordinal
    );
    return output;
  }

  // -------------------------------------------------------------------------
  // Files & module-level declarations
  // -------------------------------------------------------------------------

  #fileContext(fileName: string): FileContext {
    const existing = this.#files.get(fileName);
    if (existing) {
      return existing;
    }
    const sourceFile = this.#project.program.getSourceFile(fileName);
    if (sourceFile == null) {
      throw new Error(`Missing source file ${fileName}`);
    }
    const declarations = new Map<string, AnyNode>();
    for (const statement of sourceFile.statements as ReadonlyArray<AnyNode>) {
      if (statement.kind === SyntaxKind.FunctionDeclaration && statement.name) {
        declarations.set(statement.name.text, statement);
      } else if (statement.kind === SyntaxKind.VariableStatement) {
        for (const decl of statement.declarationList.declarations) {
          if (decl.name.kind === SyntaxKind.Identifier) {
            declarations.set(decl.name.text, decl);
          }
        }
      }
    }
    const context: FileContext = {
      sourceFile,
      path: relative(this.#cwd, sourceFile.fileName ?? fileName),
      moduleScope: new Scope(null, 0),
      declarations,
    };
    this.#files.set(fileName, context);
    this.#files.set(sourceFile.fileName, context);
    return context;
  }

  #asFunction(decl: AnyNode): AnyNode {
    if (decl.kind === SyntaxKind.FunctionDeclaration) {
      return decl.body ? decl : undefined;
    }
    if (decl.kind === SyntaxKind.VariableDeclaration && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (isFunctionLike(init)) {
        return init;
      }
    }
    return undefined;
  }

  #moduleValue(name: string, file: FileContext): Value | undefined {
    const decl = file.declarations.get(name);
    if (decl == null) {
      return undefined;
    }
    return this.#declarationValue(decl, file);
  }

  #declarationValue(decl: AnyNode, file: FileContext): Value {
    const cacheKey = `${file.path}:${decl.pos}`;
    const cached = this.#moduleValueCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    let value: Value = UNKNOWN;
    if (decl.kind === SyntaxKind.FunctionDeclaration) {
      value = { kind: 'func', node: decl, scope: file.moduleScope, file };
    } else if (
      decl.kind === SyntaxKind.VariableDeclaration &&
      decl.initializer &&
      // only `const`
      // oxlint-disable-next-line no-bitwise
      (decl.parent.flags & NodeFlags.Const) !== 0
    ) {
      const init = unwrap(decl.initializer);
      if (isFunctionLike(init)) {
        value = { kind: 'func', node: init, scope: file.moduleScope, file };
      } else {
        // Evaluate constant initializers once, in an empty state.
        this.#moduleValueCache.set(cacheKey, UNKNOWN);
        const results = this.#eval(init, new State(), file.moduleScope, file);
        value = results.length === 1 ? (results[0]?.[1] ?? UNKNOWN) : UNKNOWN;
        if (value.kind === 'func' || value.kind === 'sym') {
          value = UNKNOWN;
        }
      }
    }
    this.#moduleValueCache.set(cacheKey, value);
    return value;
  }

  // Resolve an identifier imported from another module
  #importedValue(node: AnyNode): Value | undefined {
    let symbol = this.#checker.getSymbolAtLocation(node);
    if (symbol == null) {
      return undefined;
    }
    // oxlint-disable-next-line no-bitwise
    if (symbol.flags & SymbolFlags.Alias) {
      symbol = this.#checker.getAliasedSymbol(symbol);
    }
    const handle = symbol.valueDeclaration ?? symbol.declarations[0];
    const decl: AnyNode = handle?.resolve(this.#project);
    if (decl == null) {
      return undefined;
    }
    const sourceFile: SourceFile = decl.getSourceFile();
    if (sourceFile.isDeclarationFile) {
      return undefined;
    }
    const file = this.#fileContext(sourceFile.fileName);
    return this.#declarationValue(decl, file);
  }

  // -------------------------------------------------------------------------
  // Types -> domains
  // -------------------------------------------------------------------------

  #domainAt(node: AnyNode, file: FileContext): Domain | null {
    const key = `${file.path}:${node.pos}:${node.end}`;
    if (this.#domainCache.has(key)) {
      return this.#domainCache.get(key) ?? null;
    }
    let domain: Domain | null = null;
    try {
      domain = this.#domainOf(this.#checker.getTypeAtLocation(node));
    } catch {
      domain = null;
    }
    this.#domainCache.set(key, domain);
    return domain;
  }

  /* oxlint-disable no-bitwise */
  #domainOf(type: Type): Domain | null {
    const members = type.isUnionType() ? type.getTypes() : [type];
    const entries: Array<DomainEntry> = [];
    let other: DomainEntry | undefined;
    for (const member of members) {
      const { flags } = member;
      if (flags & (TypeFlags.Any | TypeFlags.Unknown)) {
        return null;
      }
      if (
        flags &
        (TypeFlags.StringLiteral |
          TypeFlags.NumberLiteral |
          TypeFlags.BigIntLiteral)
      ) {
        entries.push({
          kind: 'lit',
          value: (member as unknown as { value: Lit }).value,
        });
      } else if (flags & TypeFlags.BooleanLiteral) {
        const { value, intrinsicName } = member as unknown as {
          value?: boolean;
          intrinsicName?: string;
        };
        entries.push({
          kind: 'lit',
          value: typeof value === 'boolean' ? value : intrinsicName === 'true',
        });
      } else if (flags & (TypeFlags.Undefined | TypeFlags.Void)) {
        entries.push({ kind: 'lit', value: undefined });
      } else if (flags & TypeFlags.Null) {
        entries.push({ kind: 'lit', value: null });
      } else {
        const alwaysTruthy =
          (flags & (TypeFlags.Object | TypeFlags.NonPrimitive)) !== 0;
        if (other == null) {
          other = { kind: 'other', alwaysTruthy };
        } else if (!alwaysTruthy && other.kind === 'other') {
          other = { kind: 'other', alwaysTruthy: false };
        }
      }
    }
    if (other) {
      entries.push(other);
    }
    return entries;
  }
  /* oxlint-enable no-bitwise */

  // Functions that build fragments are inlined at their call sites
  #isFragmentFunction(fn: AnyNode, file: FileContext): boolean {
    const key = `${file.path}:${fn.pos}`;
    const cached = this.#fragmentFnCache.get(key);
    if (cached != null) {
      return cached;
    }
    let result = false;
    try {
      const signature = this.#checker.getSignatureFromDeclaration(fn);
      const returnType = this.#checker.getReturnTypeOfSignature(signature);
      const text = this.#checker.typeToString(returnType);
      result = /\bQuery(Fragment|Template)\b/.test(text);
      if (!result) {
        for (const param of fn.parameters) {
          const paramText = this.#checker.typeToString(
            this.#checker.getTypeAtLocation(param.name)
          );
          if (/\bQueryFragment\b/.test(paramText)) {
            result = true;
            break;
          }
        }
      }
    } catch {
      result = false;
    }
    this.#fragmentFnCache.set(key, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Roots
  // -------------------------------------------------------------------------

  #analyzeRoot(name: string, fn: AnyNode, file: FileContext): void {
    this.#rootName = name;
    this.#rootFile = file.path;
    this.#explored = new Set();
    this.#depth = 0;

    const scope = new Scope(file.moduleScope, (this.#invocation += 1));
    let state = new State();
    for (const param of fn.parameters) {
      state = this.#bindSymbolic(param.name, state, scope, file, '');
    }
    this.#runBody(fn, [state], scope, file);
  }

  #bindSymbolic(
    name: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext,
    prefix: string
  ): State {
    if (name.kind === SyntaxKind.Identifier) {
      const key = scope.declare(name.text, name);
      const label = prefix + name.text;
      return state.set(key, {
        kind: 'sym',
        id: label,
        label,
        domain: this.#domainAt(name, file),
      });
    }
    let next = state;
    if (name.kind === SyntaxKind.ObjectBindingPattern) {
      for (const element of name.elements) {
        next = this.#bindSymbolic(element.name, next, scope, file, prefix);
      }
    } else if (name.kind === SyntaxKind.ArrayBindingPattern) {
      for (const element of name.elements) {
        if (element.name) {
          next = this.#bindSymbolic(element.name, next, scope, file, prefix);
        }
      }
    }
    return next;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  #record(node: AnyNode, file: FileContext, state: State, value: Value): void {
    const key = `${this.#rootFile}\0${this.#rootName}\0${file.path}:${node.pos}`;
    let site = this.#sites.get(key);
    if (site == null) {
      site = {
        file: this.#rootFile,
        functionName: this.#rootName,
        pos:
          file.path === this.#rootFile
            ? node.pos
            : Number.MAX_SAFE_INTEGER - this.#sites.size,
        line: lineOf(file.sourceFile, node.getStart()),
        sql: new Map(),
        issues: new Set(),
      };
      this.#sites.set(key, site);
    }

    const query = this.#queryText(value);
    if (query.issue != null) {
      site.issues.add(query.issue);
      return;
    }
    let entry = site.sql.get(query.sql);
    if (entry == null) {
      entry = { conditions: [], notes: new Set() };
      site.sql.set(query.sql, entry);
    }
    entry.conditions.push(describeConditions(state));
    for (const note of query.notes) {
      entry.notes.add(note);
    }
  }

  #queryText(
    value: Value
  ):
    | { sql: string; notes: ReadonlyArray<string>; issue?: undefined }
    | { issue: string } {
    switch (value.kind) {
      case 'lit':
        if (typeof value.value === 'string') {
          return { sql: value.value, notes: [] };
        }
        return { issue: 'query is not a string' };
      case 'tmpl':
        return {
          sql: value.text,
          notes: [
            `legacy string interpolates non-constant values (rendered as \`?\`): ${value.holes.join(', ')}`,
          ],
        };
      case 'frag':
        return { sql: value.sql, notes: value.notes };
      case 'array': {
        // A QueryTemplate tuple
        const first = value.items[0];
        if (first) {
          return this.#queryText(first);
        }
        return { issue: 'empty query template' };
      }
      case 'opaque':
        return { issue: value.reason };
      case 'sym':
        return { issue: `query text comes from parameter \`${value.label}\`` };
      default:
        return { issue: 'query text could not be determined statically' };
    }
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  #runBody(
    fn: AnyNode,
    states: Array<State>,
    scope: Scope,
    file: FileContext
  ): Results {
    const { body } = fn;
    if (body == null) {
      return states.map(s => [s, UNKNOWN]);
    }
    if (body.kind !== SyntaxKind.Block) {
      const results: Results = [];
      for (const state of states) {
        results.push(...this.#eval(body, state, scope, file));
      }
      return results;
    }
    const hoisted = this.#hoist(body.statements, states, scope, file);
    const flow = this.#execStatements(body.statements, hoisted, scope, file);
    return [
      ...flow.returned,
      ...flow.normal.map((s): [State, Value] => [s, UNDEFINED]),
    ];
  }

  // Function declarations are hoisted
  #hoist(
    statements: ReadonlyArray<AnyNode>,
    states: Array<State>,
    scope: Scope,
    file: FileContext
  ): Array<State> {
    let current = states;
    for (const statement of statements) {
      if (statement.kind === SyntaxKind.FunctionDeclaration && statement.name) {
        const key = scope.declare(statement.name.text, statement.name);
        const value: Value = { kind: 'func', node: statement, scope, file };
        current = current.map(s => s.set(key, value));
      }
    }
    return current;
  }

  #execStatements(
    statements: ReadonlyArray<AnyNode>,
    states: Array<State>,
    scope: Scope,
    file: FileContext
  ): Flow {
    const flow = emptyFlow();
    let current = states;
    for (const statement of statements) {
      if (current.length === 0) {
        break;
      }
      const next: Array<State> = [];
      for (const state of current) {
        const result = this.#execStatement(statement, state, scope, file);
        next.push(...result.normal);
        flow.returned.push(...result.returned);
        flow.broke.push(...result.broke);
      }
      current = dedupe(next);
      if (current.length > MAX_STATES) {
        this.#warn(
          statement,
          file,
          `too many paths (> ${MAX_STATES}), analysis truncated`
        );
        current = current.slice(0, MAX_STATES);
      }
    }
    flow.normal = current;
    return flow;
  }

  #execStatement(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Flow {
    const flow = emptyFlow();
    switch (node.kind) {
      case SyntaxKind.Block: {
        const inner = new Scope(scope, scope.invocation);
        const hoisted = this.#hoist(node.statements, [state], inner, file);
        return this.#execStatements(node.statements, hoisted, inner, file);
      }
      case SyntaxKind.VariableStatement: {
        let states = [state];
        for (const decl of node.declarationList.declarations) {
          const next: Array<State> = [];
          for (const s of states) {
            if (decl.initializer) {
              for (const [s2, value] of this.#eval(
                decl.initializer,
                s,
                scope,
                file
              )) {
                next.push(this.#bind(decl.name, value, s2, scope, file));
              }
            } else {
              next.push(this.#bind(decl.name, UNDEFINED, s, scope, file));
            }
          }
          states = next;
        }
        flow.normal = states;
        return flow;
      }
      case SyntaxKind.FunctionDeclaration:
        // Already bound by #hoist
        flow.normal = [state];
        return flow;
      case SyntaxKind.ExpressionStatement: {
        flow.normal = this.#eval(node.expression, state, scope, file).map(
          ([s]) => s
        );
        return flow;
      }
      case SyntaxKind.IfStatement: {
        const { t, f } = this.#branch(node.expression, state, scope, file);
        const thenFlow = this.#execStatements(
          [node.thenStatement],
          t,
          scope,
          file
        );
        const elseFlow = node.elseStatement
          ? this.#execStatements([node.elseStatement], f, scope, file)
          : { normal: f, returned: [], broke: [] };
        return mergeFlows(thenFlow, elseFlow);
      }
      case SyntaxKind.ReturnStatement: {
        if (node.expression) {
          flow.returned = this.#eval(node.expression, state, scope, file);
        } else {
          flow.returned = [[state, UNDEFINED]];
        }
        return flow;
      }
      case SyntaxKind.ThrowStatement:
        // Paths that throw never reach a prepare() call after this point.
        this.#eval(node.expression, state, scope, file);
        return flow;
      case SyntaxKind.BreakStatement:
        flow.broke = [state];
        return flow;
      case SyntaxKind.ContinueStatement:
        // Only used inside loops, which we run once for discovery.
        return flow;
      case SyntaxKind.SwitchStatement:
        return this.#execSwitch(node, state, scope, file);
      case SyntaxKind.TryStatement: {
        const tryFlow = this.#execStatement(node.tryBlock, state, scope, file);
        let result = tryFlow;
        if (node.catchClause) {
          const inner = new Scope(scope, scope.invocation);
          let catchState = state;
          if (node.catchClause.variableDeclaration) {
            catchState = this.#bind(
              node.catchClause.variableDeclaration.name,
              UNKNOWN,
              state,
              inner,
              file
            );
          }
          const catchFlow = this.#execStatement(
            node.catchClause.block,
            catchState,
            inner,
            file
          );
          result = mergeFlows(tryFlow, catchFlow);
        }
        if (node.finallyBlock) {
          const finallyFlow = this.#execStatements(
            [node.finallyBlock],
            result.normal,
            scope,
            file
          );
          result = { ...result, normal: finallyFlow.normal };
        }
        return result;
      }
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
        return this.#execLoop(node, state, scope, file);
      case SyntaxKind.LabeledStatement:
        return this.#execStatement(node.statement, state, scope, file);
      default:
        // Type declarations, empty statements, etc.
        flow.normal = [state];
        return flow;
    }
  }

  #execSwitch(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Flow {
    const flow = emptyFlow();
    const inner = new Scope(scope, scope.invocation);
    const { clauses } = node.caseBlock;

    // States that haven't matched any clause yet
    let pending: Array<State> = [state];
    // States that matched and are falling through
    let falling: Array<State> = [];
    let defaultIndex = -1;

    const runFrom = (start: number, states: Array<State>) => {
      let current = states;
      for (let i = start; i < clauses.length && current.length > 0; i += 1) {
        const clauseFlow = this.#execStatements(
          clauses[i].statements,
          current,
          inner,
          file
        );
        flow.returned.push(...clauseFlow.returned);
        flow.normal.push(...clauseFlow.broke);
        current = clauseFlow.normal;
      }
      flow.normal.push(...current);
    };

    for (let i = 0; i < clauses.length; i += 1) {
      const clause = clauses[i];
      if (clause.kind === SyntaxKind.DefaultClause) {
        defaultIndex = i;
        continue;
      }
      const matched: Array<State> = [];
      const unmatched: Array<State> = [];
      for (const s of pending) {
        const { t, f } = this.#compare(
          node.expression,
          clause.expression,
          '===',
          s,
          scope,
          file
        );
        matched.push(...t);
        unmatched.push(...f);
      }
      pending = unmatched;
      falling = [...falling, ...matched];
      // Run fallthrough handled by runFrom when this clause has statements
      if (clause.statements.length > 0 && falling.length > 0) {
        runFrom(i, falling);
        falling = [];
      }
    }
    if (defaultIndex !== -1 && pending.length > 0) {
      runFrom(defaultIndex, pending);
    } else {
      flow.normal.push(...pending);
    }
    flow.normal = dedupe(flow.normal);
    return flow;
  }

  #execLoop(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Flow {
    const inner = new Scope(scope, scope.invocation);
    let bodyStates: Array<State> = [state];

    if (node.kind === SyntaxKind.ForStatement && node.initializer) {
      bodyStates = this.#execInitializer(node.initializer, state, inner, file);
    } else if (
      node.kind === SyntaxKind.ForOfStatement ||
      node.kind === SyntaxKind.ForInStatement
    ) {
      const iterated = this.#eval(node.expression, state, scope, file);
      bodyStates = [];
      for (const [s, value] of iterated) {
        const items =
          node.kind === SyntaxKind.ForOfStatement && value.kind === 'array'
            ? value.items
            : [
                node.kind === SyntaxKind.ForOfStatement &&
                value.kind === 'repeated'
                  ? value.item
                  : UNKNOWN,
              ];
        for (const item of items) {
          bodyStates.push(
            this.#bindForInitializer(node.initializer, item, s, inner, file)
          );
        }
      }
    }

    // Run the body once (per item for literal arrays) to discover queries.
    const bodyFlow = this.#execStatements(
      [node.statement],
      bodyStates,
      inner,
      file
    );

    // Afterwards, anything assigned in the loop body is no longer trustworthy.
    const assigned = collectAssignedNames(node.statement);
    let after = state;
    for (const name of assigned) {
      const key = scope.lookup(name);
      if (key != null) {
        after = after.set(key, opaque(`\`${name}\` is modified inside a loop`));
      }
    }
    return {
      normal: [after],
      returned: bodyFlow.returned,
      broke: [],
    };
  }

  #execInitializer(
    initializer: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Array<State> {
    if (initializer.kind === SyntaxKind.VariableDeclarationList) {
      let states = [state];
      for (const decl of initializer.declarations) {
        states = states.map(s =>
          this.#bind(decl.name, UNKNOWN, s, scope, file)
        );
      }
      return states;
    }
    return this.#eval(initializer, state, scope, file).map(([s]) => s);
  }

  #bindForInitializer(
    initializer: AnyNode,
    value: Value,
    state: State,
    scope: Scope,
    file: FileContext
  ): State {
    if (initializer.kind === SyntaxKind.VariableDeclarationList) {
      const decl = initializer.declarations[0];
      if (decl) {
        return this.#bind(decl.name, value, state, scope, file);
      }
    }
    return state;
  }

  // Bind a declaration name (identifier or destructuring pattern) to a value
  #bind(
    name: AnyNode,
    value: Value,
    state: State,
    scope: Scope,
    file: FileContext
  ): State {
    if (name.kind === SyntaxKind.Identifier) {
      const key = scope.declare(name.text, name);
      return state.set(key, value);
    }
    let next = state;
    if (name.kind === SyntaxKind.ArrayBindingPattern) {
      name.elements.forEach((element: AnyNode, index: number) => {
        if (element.kind === SyntaxKind.OmittedExpression || !element.name) {
          return;
        }
        let item: Value = UNKNOWN;
        if (value.kind === 'array' && !element.dotDotDotToken) {
          item = value.items[index] ?? UNDEFINED;
        } else if (value.kind === 'repeated') {
          item = element.dotDotDotToken ? value : value.item;
        }
        next = this.#bind(element.name, item, next, scope, file);
      });
    } else if (name.kind === SyntaxKind.ObjectBindingPattern) {
      for (const element of name.elements) {
        const propName =
          element.propertyName?.text ??
          (element.name.kind === SyntaxKind.Identifier
            ? element.name.text
            : undefined);
        let prop: Value = UNKNOWN;
        if (element.dotDotDotToken) {
          prop = UNKNOWN;
        } else if (value.kind === 'object' && propName != null) {
          prop = value.props.get(propName) ?? UNDEFINED;
        } else if (value.kind === 'sym' && propName != null) {
          const label = `${value.label}.${propName}`;
          prop = {
            kind: 'sym',
            id: `${value.id}.${propName}`,
            label,
            domain: this.#domainAt(element.name, file),
          };
        }
        next = this.#bind(element.name, prop, next, scope, file);
      }
    }
    return next;
  }

  #warn(node: AnyNode, file: FileContext, message: string): void {
    const key = `${this.#rootFile}\0${this.#rootName}\0warn`;
    let site = this.#sites.get(key);
    if (site == null) {
      site = {
        file: this.#rootFile,
        functionName: this.#rootName,
        pos: -1,
        line: lineOf(file.sourceFile, node.getStart()),
        sql: new Map(),
        issues: new Set(),
      };
      this.#sites.set(key, site);
    }
    site.issues.add(message);
  }

  // -------------------------------------------------------------------------
  // Conditions
  // -------------------------------------------------------------------------

  // Split a state into the states where `expr` is truthy and where it's falsy
  #branch(
    expr: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): { t: Array<State>; f: Array<State> } {
    const node = unwrap(expr);

    if (
      node.kind === SyntaxKind.PrefixUnaryExpression &&
      node.operator === SyntaxKind.ExclamationToken
    ) {
      const { t, f } = this.#branch(node.operand, state, scope, file);
      return { t: f, f: t };
    }

    if (node.kind === SyntaxKind.BinaryExpression) {
      const op = node.operatorToken.kind;
      if (op === SyntaxKind.AmpersandAmpersandToken) {
        const left = this.#branch(node.left, state, scope, file);
        const t: Array<State> = [];
        const f: Array<State> = [...left.f];
        for (const s of left.t) {
          const right = this.#branch(node.right, s, scope, file);
          t.push(...right.t);
          f.push(...right.f);
        }
        return { t: dedupe(t), f: dedupe(f) };
      }
      if (op === SyntaxKind.BarBarToken) {
        const left = this.#branch(node.left, state, scope, file);
        const t: Array<State> = [...left.t];
        const f: Array<State> = [];
        for (const s of left.f) {
          const right = this.#branch(node.right, s, scope, file);
          t.push(...right.t);
          f.push(...right.f);
        }
        return { t: dedupe(t), f: dedupe(f) };
      }
      const eqOps: Record<number, '===' | '!==' | '==' | '!='> = {
        [SyntaxKind.EqualsEqualsEqualsToken]: '===',
        [SyntaxKind.ExclamationEqualsEqualsToken]: '!==',
        [SyntaxKind.EqualsEqualsToken]: '==',
        [SyntaxKind.ExclamationEqualsToken]: '!=',
      };
      const eqOp = eqOps[op];
      if (eqOp) {
        return this.#compare(node.left, node.right, eqOp, state, scope, file);
      }
    }

    // Generic: evaluate and split on truthiness
    const t: Array<State> = [];
    const f: Array<State> = [];
    for (const [s, value] of this.#eval(node, state, scope, file)) {
      const split = this.#truthiness(value, s);
      const annotated = this.#annotate(node, split);
      t.push(...annotated.t);
      f.push(...annotated.f);
    }
    return { t, f };
  }

  // When a condition couldn't narrow anything, remember it for labels
  #annotate(
    node: AnyNode,
    split: { t: Array<State>; f: Array<State> }
  ): { t: Array<State>; f: Array<State> } {
    const shared = split.t.filter(s => split.f.includes(s));
    if (shared.length === 0) {
      return split;
    }
    const text = conditionText(node);
    if (text == null) {
      return split;
    }
    return {
      t: split.t.map(s => (shared.includes(s) ? s.assume(text, true) : s)),
      f: split.f.map(s => (shared.includes(s) ? s.assume(text, false) : s)),
    };
  }

  #currentDomain(sym: Value & { kind: 'sym' }, state: State): Domain | null {
    return state.refined.get(sym.id) ?? sym.domain;
  }

  #truthiness(
    value: Value,
    state: State
  ): { t: Array<State>; f: Array<State> } {
    switch (value.kind) {
      case 'lit':
        return litTruthy(value.value)
          ? { t: [state], f: [] }
          : { t: [], f: [state] };
      case 'frag':
      case 'array':
      case 'repeated':
      case 'object':
      case 'func':
        return { t: [state], f: [] };
      case 'sym': {
        const domain = this.#currentDomain(value, state);
        if (domain == null) {
          return { t: [state], f: [state] };
        }
        const truthy = domain.filter(
          e => e.kind === 'other' || litTruthy(e.value)
        );
        const falsy = domain.filter(
          e =>
            (e.kind === 'other' && !e.alwaysTruthy) ||
            (e.kind === 'lit' && !litTruthy(e.value))
        );
        return {
          t: this.#narrow(value, state, domain, truthy),
          f: this.#narrow(value, state, domain, falsy),
        };
      }
      default:
        return { t: [state], f: [state] };
    }
  }

  #narrow(
    sym: Value & { kind: 'sym' },
    state: State,
    before: Domain,
    after: Domain
  ): Array<State> {
    if (after.length === 0) {
      return [];
    }
    if (domainToString(after) === domainToString(before)) {
      return [state];
    }
    return [state.refine(sym.id, after)];
  }

  #compare(
    leftNode: AnyNode,
    rightNode: AnyNode,
    op: '===' | '!==' | '==' | '!=',
    state: State,
    scope: Scope,
    file: FileContext
  ): { t: Array<State>; f: Array<State> } {
    const t: Array<State> = [];
    const f: Array<State> = [];
    const negate = op === '!==' || op === '!=';
    const eq = op === '===' || op === '!==' ? strictEq : looseEq;

    for (const [s1, left] of this.#eval(leftNode, state, scope, file)) {
      for (const [s2, right] of this.#eval(rightNode, s1, scope, file)) {
        const result = this.#annotate(
          leftNode.parent,
          this.#compareValues(left, right, eq, s2)
        );
        if (negate) {
          t.push(...result.f);
          f.push(...result.t);
        } else {
          t.push(...result.t);
          f.push(...result.f);
        }
      }
    }
    return { t, f };
  }

  #compareValues(
    left: Value,
    right: Value,
    eq: (a: Lit, b: Lit) => boolean,
    state: State
  ): { t: Array<State>; f: Array<State> } {
    const resolvedLeft = this.#resolveSym(left, state);
    const resolvedRight = this.#resolveSym(right, state);
    if (resolvedLeft.kind === 'lit' && resolvedRight.kind === 'lit') {
      return eq(resolvedLeft.value, resolvedRight.value)
        ? { t: [state], f: [] }
        : { t: [], f: [state] };
    }
    // Fragments, arrays, objects and functions are never null/undefined
    const isObjectish = (v: Value) =>
      v.kind === 'frag' ||
      v.kind === 'array' ||
      v.kind === 'repeated' ||
      v.kind === 'object' ||
      v.kind === 'func';
    if (
      (isObjectish(resolvedLeft) &&
        resolvedRight.kind === 'lit' &&
        isNullish(resolvedRight.value)) ||
      (isObjectish(resolvedRight) &&
        resolvedLeft.kind === 'lit' &&
        isNullish(resolvedLeft.value))
    ) {
      return { t: [], f: [state] };
    }

    let sym: (Value & { kind: 'sym' }) | undefined;
    let other: Lit | undefined;
    let hasOther = false;
    if (resolvedLeft.kind === 'sym' && resolvedRight.kind === 'lit') {
      sym = resolvedLeft;
      other = resolvedRight.value;
      hasOther = true;
    } else if (resolvedRight.kind === 'sym' && resolvedLeft.kind === 'lit') {
      sym = resolvedRight;
      other = resolvedLeft.value;
      hasOther = true;
    }

    if (sym && hasOther) {
      const domain = this.#currentDomain(sym, state);
      if (domain == null) {
        return { t: [state], f: [state] };
      }
      const target = other;
      const matches: Array<DomainEntry> = [];
      const rest: Array<DomainEntry> = [];
      for (const entry of domain) {
        if (entry.kind === 'lit') {
          (eq(entry.value, target) ? matches : rest).push(entry);
        } else if (isNullish(target)) {
          // non-nullish `other` never equals null/undefined
          rest.push(entry);
        } else {
          matches.push({ kind: 'lit', value: target });
          rest.push(entry);
        }
      }
      return {
        t: this.#narrow(sym, state, domain, matches),
        f: this.#narrow(sym, state, domain, rest),
      };
    }

    return { t: [state], f: [state] };
  }

  // A sym narrowed down to a single literal behaves like that literal
  #resolveSym(value: Value, state: State): Value {
    if (value.kind !== 'sym') {
      return value;
    }
    const domain = this.#currentDomain(value, state);
    if (domain?.length === 1 && domain[0]?.kind === 'lit') {
      return lit(domain[0].value);
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  #eval(expr: AnyNode, state: State, scope: Scope, file: FileContext): Results {
    const node = unwrap(expr);
    switch (node.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return [[state, lit(node.text)]];
      case SyntaxKind.NumericLiteral:
        return [[state, lit(Number(node.text))]];
      case SyntaxKind.TrueKeyword:
        return [[state, lit(true)]];
      case SyntaxKind.FalseKeyword:
        return [[state, lit(false)]];
      case SyntaxKind.NullKeyword:
        return [[state, lit(null)]];
      case SyntaxKind.Identifier:
        return [[state, this.#lookup(node, state, scope, file)]];
      case SyntaxKind.TemplateExpression:
        return this.#evalTemplate(node, state, scope, file);
      case SyntaxKind.TaggedTemplateExpression:
        return this.#evalTaggedTemplate(node, state, scope, file);
      case SyntaxKind.ConditionalExpression: {
        const { t, f } = this.#branch(node.condition, state, scope, file);
        return collapse(state, [
          ...t.flatMap(s => this.#eval(node.whenTrue, s, scope, file)),
          ...f.flatMap(s => this.#eval(node.whenFalse, s, scope, file)),
        ]);
      }
      case SyntaxKind.PrefixUnaryExpression:
        return this.#evalPrefix(node, state, scope, file);
      case SyntaxKind.PostfixUnaryExpression:
        return this.#assign(node.operand, UNKNOWN, state, scope, file);
      case SyntaxKind.BinaryExpression:
        return this.#evalBinary(node, state, scope, file);
      case SyntaxKind.CallExpression:
        return this.#evalCall(node, state, scope, file);
      case SyntaxKind.PropertyAccessExpression:
        return this.#evalPropertyAccess(node, state, scope, file);
      case SyntaxKind.ElementAccessExpression:
        return this.#evalElementAccess(node, state, scope, file);
      case SyntaxKind.ArrayLiteralExpression:
        return this.#evalArrayLiteral(node, state, scope, file);
      case SyntaxKind.ObjectLiteralExpression:
        return this.#evalObjectLiteral(node, state, scope, file);
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
        return [[state, { kind: 'func', node, scope, file }]];
      case SyntaxKind.NewExpression:
        return this.#evalOpaqueCall(node, state, scope, file);
      case SyntaxKind.TypeOfExpression:
      case SyntaxKind.VoidExpression:
      case SyntaxKind.DeleteExpression:
        return this.#eval(node.expression, state, scope, file).map(
          ([s]): [State, Value] => [s, UNKNOWN]
        );
      default:
        return [[state, UNKNOWN]];
    }
  }

  #lookup(node: AnyNode, state: State, scope: Scope, file: FileContext): Value {
    const name: string = node.text;
    if (name === 'undefined') {
      return UNDEFINED;
    }
    const key = scope.lookup(name);
    if (key != null) {
      const value = state.values.get(key);
      if (value) {
        return this.#resolveSym(value, state);
      }
      // A hoisted function declared later in this scope
      return UNKNOWN;
    }
    const moduleValue = this.#moduleValue(name, file);
    if (moduleValue) {
      return moduleValue;
    }
    if (KNOWN_HELPERS.has(name)) {
      return UNKNOWN;
    }
    const imported = this.#importedValue(node);
    return imported ?? UNKNOWN;
  }

  #evalSequence(
    exprs: ReadonlyArray<AnyNode>,
    state: State,
    scope: Scope,
    file: FileContext
  ): Array<[State, Array<Value>]> {
    let results: Array<[State, Array<Value>]> = [[state, []]];
    for (const expr of exprs) {
      const next: Array<[State, Array<Value>]> = [];
      for (const [s, values] of results) {
        for (const [s2, value] of this.#eval(expr, s, scope, file)) {
          next.push([s2, [...values, value]]);
        }
      }
      results = next;
    }
    return results;
  }

  #evalTemplate(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const spans = node.templateSpans as ReadonlyArray<AnyNode>;
    return this.#evalSequence(
      spans.map(span => span.expression),
      state,
      scope,
      file
    ).map(([s, values]): [State, Value] => {
      let text: string = node.head.text;
      const holes: Array<string> = [];
      let poisoned: Value | undefined;
      spans.forEach((span, index) => {
        const value = values[index] ?? UNKNOWN;
        if (value.kind === 'lit') {
          text += String(value.value);
        } else if (value.kind === 'tmpl') {
          text += value.text;
          holes.push(...value.holes);
        } else if (value.kind === 'opaque') {
          poisoned = value;
        } else {
          text += '?';
          holes.push(`\`${span.expression.getText()}\``);
        }
        text += span.literal.text;
      });
      if (poisoned) {
        return [s, poisoned];
      }
      if (holes.length === 0) {
        return [s, lit(text)];
      }
      return [s, { kind: 'tmpl', text, holes }];
    });
  }

  #evalTaggedTemplate(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const tag = unwrap(node.tag);
    const tagName = tag.kind === SyntaxKind.Identifier ? tag.text : undefined;
    if (tagName !== 'sql' && tagName !== 'sqlFragment') {
      return [[state, UNKNOWN]];
    }
    const template = node.template;
    if (template.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      return [[state, this.#finishFragment(tagName, template.text, [])]];
    }
    const spans = template.templateSpans as ReadonlyArray<AnyNode>;
    return this.#evalSequence(
      spans.map(span => span.expression),
      state,
      scope,
      file
    ).map(([s, values]): [State, Value] => {
      let sql: string = template.head.text;
      const notes: Array<string> = [];
      for (const [index, span] of spans.entries()) {
        const value = values[index] ?? UNKNOWN;
        if (value.kind === 'frag') {
          sql += value.sql;
          notes.push(...value.notes);
        } else if (value.kind === 'opaque') {
          return [s, value];
        } else {
          sql += '?';
        }
        sql += span.literal.text;
      }
      return [s, this.#finishFragment(tagName, sql, notes)];
    });
  }

  #finishFragment(
    tagName: 'sql' | 'sqlFragment',
    sql: string,
    notes: ReadonlyArray<string>
  ): Value {
    const frag: Value = { kind: 'frag', sql, notes: [...new Set(notes)] };
    if (tagName === 'sql') {
      // QueryTemplate = [query, params]
      return { kind: 'array', items: [frag, UNKNOWN] };
    }
    return frag;
  }

  #evalPrefix(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    if (node.operator === SyntaxKind.ExclamationToken) {
      const { t, f } = this.#branch(node.operand, state, scope, file);
      return [
        ...t.map((s): [State, Value] => [s, lit(false)]),
        ...f.map((s): [State, Value] => [s, lit(true)]),
      ];
    }
    if (
      node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
    ) {
      return this.#assign(node.operand, UNKNOWN, state, scope, file);
    }
    return this.#eval(node.operand, state, scope, file).map(
      ([s, value]): [State, Value] => {
        if (value.kind === 'lit' && typeof value.value === 'number') {
          if (node.operator === SyntaxKind.MinusToken) {
            return [s, lit(-value.value)];
          }
          if (node.operator === SyntaxKind.PlusToken) {
            return [s, value];
          }
        }
        return [s, UNKNOWN];
      }
    );
  }

  #evalBinary(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const op = node.operatorToken.kind;
    switch (op) {
      case SyntaxKind.EqualsToken: {
        return this.#eval(node.right, state, scope, file).flatMap(
          ([s, value]) =>
            this.#assign(node.left, value, s, scope, file).map(
              ([s2]): [State, Value] => [s2, value]
            )
        );
      }
      case SyntaxKind.PlusEqualsToken: {
        const results: Results = [];
        for (const [s, current] of this.#eval(node.left, state, scope, file)) {
          for (const [s2, value] of this.#eval(node.right, s, scope, file)) {
            const sum = concat(current, value, node.right);
            results.push(...this.#assign(node.left, sum, s2, scope, file));
          }
        }
        return results;
      }
      case SyntaxKind.AmpersandAmpersandToken: {
        const { t, f } = this.#branch(node.left, state, scope, file);
        return collapse(state, [
          ...f.flatMap(s => this.#eval(node.left, s, scope, file)),
          ...t.flatMap(s => this.#eval(node.right, s, scope, file)),
        ]);
      }
      case SyntaxKind.BarBarToken: {
        const { t, f } = this.#branch(node.left, state, scope, file);
        return collapse(state, [
          ...t.flatMap(s => this.#eval(node.left, s, scope, file)),
          ...f.flatMap(s => this.#eval(node.right, s, scope, file)),
        ]);
      }
      case SyntaxKind.QuestionQuestionToken: {
        const results: Results = [];
        for (const [s, value] of this.#eval(node.left, state, scope, file)) {
          if (value.kind === 'lit' && isNullish(value.value)) {
            results.push(...this.#eval(node.right, s, scope, file));
          } else if (value.kind === 'sym') {
            const split = this.#compareValues(value, lit(null), looseEq, s);
            for (const s2 of split.t) {
              results.push(...this.#eval(node.right, s2, scope, file));
            }
            for (const s2 of split.f) {
              results.push([s2, this.#resolveSym(value, s2)]);
            }
          } else if (value.kind === 'unknown') {
            const right = this.#eval(node.right, s, scope, file);
            const interesting = right.some(
              ([, v]) => v.kind === 'frag' || v.kind === 'array'
            );
            if (interesting) {
              results.push([s, UNKNOWN], ...right);
            } else {
              results.push([s, UNKNOWN]);
            }
          } else {
            results.push([s, value]);
          }
        }
        return collapse(state, results);
      }
      case SyntaxKind.EqualsEqualsEqualsToken:
      case SyntaxKind.ExclamationEqualsEqualsToken:
      case SyntaxKind.EqualsEqualsToken:
      case SyntaxKind.ExclamationEqualsToken: {
        const { t, f } = this.#branch(node, state, scope, file);
        return [
          ...t.map((s): [State, Value] => [s, lit(true)]),
          ...f.map((s): [State, Value] => [s, lit(false)]),
        ];
      }
      case SyntaxKind.PlusToken: {
        const results: Results = [];
        for (const [s, left] of this.#eval(node.left, state, scope, file)) {
          for (const [s2, right] of this.#eval(node.right, s, scope, file)) {
            if (
              left.kind === 'lit' &&
              right.kind === 'lit' &&
              typeof left.value === 'number' &&
              typeof right.value === 'number'
            ) {
              results.push([s2, lit(left.value + right.value)]);
            } else if (
              (left.kind === 'lit' && typeof left.value === 'string') ||
              (right.kind === 'lit' && typeof right.value === 'string') ||
              left.kind === 'tmpl' ||
              right.kind === 'tmpl'
            ) {
              results.push([s2, concat(left, right, node.right)]);
            } else {
              results.push([s2, UNKNOWN]);
            }
          }
        }
        return results;
      }
      case SyntaxKind.CommaToken:
        return this.#eval(node.left, state, scope, file).flatMap(([s]) =>
          this.#eval(node.right, s, scope, file)
        );
      default: {
        // Arithmetic, comparisons, etc. Evaluate for side effects only.
        const results: Results = [];
        for (const [s] of this.#eval(node.left, state, scope, file)) {
          for (const [s2] of this.#eval(node.right, s, scope, file)) {
            results.push([s2, UNKNOWN]);
          }
        }
        return results;
      }
    }
  }

  #assign(
    target: AnyNode,
    value: Value,
    state: State,
    scope: Scope,
    _file: FileContext
  ): Results {
    const node = unwrap(target);
    if (node.kind === SyntaxKind.Identifier) {
      const key = scope.lookup(node.text);
      if (key != null) {
        return [[state.set(key, value), value]];
      }
      return [[state, value]];
    }
    if (
      node.kind === SyntaxKind.PropertyAccessExpression &&
      unwrap(node.expression).kind === SyntaxKind.Identifier
    ) {
      const key = scope.lookup(unwrap(node.expression).text);
      const current = key != null ? state.values.get(key) : undefined;
      if (key != null && current?.kind === 'object') {
        const props = new Map(current.props);
        props.set(node.name.text, value);
        return [[state.set(key, { kind: 'object', props }), value]];
      }
    }
    if (
      node.kind === SyntaxKind.ArrayLiteralExpression ||
      node.kind === SyntaxKind.ObjectLiteralExpression
    ) {
      // Destructuring assignment, not worth modeling precisely
      let next = state;
      for (const name of collectAssignedNames(node)) {
        const key = scope.lookup(name);
        if (key != null) {
          next = next.set(key, UNKNOWN);
        }
      }
      return [[next, value]];
    }
    return [[state, value]];
  }

  #evalPropertyAccess(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const propName: string = node.name.text;
    return this.#eval(node.expression, state, scope, file).map(
      ([s, base]): [State, Value] => {
        if (base.kind === 'object') {
          return [s, base.props.get(propName) ?? UNDEFINED];
        }
        if (base.kind === 'sym') {
          const sym: Value = {
            kind: 'sym',
            id: `${base.id}.${propName}`,
            label: `${base.label}.${propName}`,
            domain: this.#domainAt(node, file),
          };
          return [s, this.#resolveSym(sym, s)];
        }
        if (base.kind === 'array' && propName === 'length') {
          return [s, lit(base.items.length)];
        }
        if (base.kind === 'lit' && isNullish(base.value)) {
          return [s, UNDEFINED];
        }
        if (base.kind === 'unknown') {
          return [s, this.#constantValue(node, file)];
        }
        return [s, UNKNOWN];
      }
    );
  }

  // Enum members and other compile-time constants (e.g. `CallStatusValue.Deleted`)
  readonly #constantCache = new Map<string, Value>();
  #constantValue(node: AnyNode, file: FileContext): Value {
    if (unwrap(node.expression).kind !== SyntaxKind.Identifier) {
      return UNKNOWN;
    }
    const key = `${file.path}:${node.pos}:${node.end}`;
    const cached = this.#constantCache.get(key);
    if (cached) {
      return cached;
    }
    let value: Value = UNKNOWN;
    try {
      const constant = this.#checker.getConstantValue(node);
      if (constant !== undefined) {
        value = lit(constant);
      } else {
        // tsgo doesn't return constant values for enum member accesses, but
        // their type is the literal itself.
        const domain = this.#domainAt(node, file);
        if (domain?.length === 1 && domain[0]?.kind === 'lit') {
          value = lit(domain[0].value);
        }
      }
    } catch {
      value = UNKNOWN;
    }
    this.#constantCache.set(key, value);
    return value;
  }

  #evalElementAccess(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const results: Results = [];
    for (const [s, base] of this.#eval(node.expression, state, scope, file)) {
      for (const [s2, index] of this.#eval(
        node.argumentExpression,
        s,
        scope,
        file
      )) {
        if (base.kind === 'array' && index.kind === 'lit') {
          results.push([s2, base.items[Number(index.value)] ?? UNDEFINED]);
        } else if (base.kind === 'repeated') {
          results.push([s2, base.item]);
        } else if (base.kind === 'object' && index.kind === 'lit') {
          results.push([s2, base.props.get(String(index.value)) ?? UNDEFINED]);
        } else {
          results.push([s2, UNKNOWN]);
        }
      }
    }
    return results;
  }

  #evalArrayLiteral(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const elements = node.elements as ReadonlyArray<AnyNode>;
    return this.#evalSequence(
      elements.map(e =>
        e.kind === SyntaxKind.SpreadElement ? e.expression : e
      ),
      state,
      scope,
      file
    ).map(([s, values]): [State, Value] => {
      const items: Array<Value> = [];
      let repeated: Value | undefined;
      elements.forEach((element, index) => {
        const value = values[index] ?? UNKNOWN;
        if (element.kind === SyntaxKind.SpreadElement) {
          if (value.kind === 'array') {
            items.push(...value.items);
          } else if (value.kind === 'repeated') {
            repeated = value;
          } else {
            repeated = { kind: 'repeated', item: UNKNOWN };
          }
        } else {
          items.push(value);
        }
      });
      if (repeated) {
        return [s, repeated];
      }
      return [s, { kind: 'array', items }];
    });
  }

  #evalObjectLiteral(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    let results: Array<[State, Map<string, Value>]> = [[state, new Map()]];
    for (const prop of node.properties as ReadonlyArray<AnyNode>) {
      const next: Array<[State, Map<string, Value>]> = [];
      for (const [s, props] of results) {
        if (prop.kind === SyntaxKind.PropertyAssignment) {
          const name =
            prop.name.kind === SyntaxKind.Identifier ||
            prop.name.kind === SyntaxKind.StringLiteral
              ? prop.name.text
              : undefined;
          for (const [s2, value] of this.#eval(
            prop.initializer,
            s,
            scope,
            file
          )) {
            const copy = new Map(props);
            if (name != null) {
              copy.set(name, value);
            }
            next.push([s2, copy]);
          }
        } else if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
          const copy = new Map(props);
          copy.set(prop.name.text, this.#lookup(prop.name, s, scope, file));
          next.push([s, copy]);
        } else if (prop.kind === SyntaxKind.SpreadAssignment) {
          for (const [s2, value] of this.#eval(
            prop.expression,
            s,
            scope,
            file
          )) {
            const copy = new Map(props);
            if (value.kind === 'object') {
              for (const [k, v] of value.props) {
                copy.set(k, v);
              }
            }
            next.push([s2, copy]);
          }
        } else if (prop.kind === SyntaxKind.MethodDeclaration) {
          const copy = new Map(props);
          if (prop.name.kind === SyntaxKind.Identifier) {
            copy.set(prop.name.text, { kind: 'func', node: prop, scope, file });
          }
          next.push([s, copy]);
        } else {
          next.push([s, props]);
        }
      }
      results = next;
    }
    return results.map(([s, props]) => [s, { kind: 'object', props }]);
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  #evalCall(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const callee = unwrap(node.expression);
    const args = node.arguments as ReadonlyArray<AnyNode>;

    if (callee.kind === SyntaxKind.Identifier) {
      const special = this.#evalHelperCall(
        callee.text,
        node,
        state,
        scope,
        file
      );
      if (special) {
        return special;
      }
    }

    if (callee.kind === SyntaxKind.PropertyAccessExpression) {
      const method: string = callee.name.text;

      if (method === 'exec' && args.length > 0) {
        for (const [s, values] of this.#evalSequence(
          args,
          state,
          scope,
          file
        )) {
          const query = this.#queryText(values[0] ?? UNKNOWN);
          if (query.issue == null && /CREATE\s+TEMP/i.test(query.sql)) {
            const key = `${this.#rootFile}\0${this.#rootName}`;
            let setup = this.#setup.get(key);
            if (setup == null) {
              setup = new Set();
              this.#setup.set(key, setup);
            }
            setup.add(query.sql);
          }
          void s;
        }
        return [[state, UNKNOWN]];
      }

      if (method === 'prepare' && args.length > 0) {
        const results: Results = [];
        for (const [s, values] of this.#evalSequence(
          args,
          state,
          scope,
          file
        )) {
          this.#record(node, file, s, values[0] ?? UNKNOWN);
          results.push([s, UNKNOWN]);
        }
        return results;
      }

      const results: Results = [];
      for (const [s, base] of this.#eval(
        callee.expression,
        state,
        scope,
        file
      )) {
        results.push(
          ...this.#evalMethodCall(base, method, callee, node, s, scope, file)
        );
      }
      return results;
    }

    // Call to something we can evaluate (closures, local helpers)
    const results: Results = [];
    for (const [s, fn] of this.#eval(callee, state, scope, file)) {
      if (fn.kind === 'func' && this.#shouldInline(fn)) {
        for (const [s2, values] of this.#evalSequence(args, s, scope, file)) {
          results.push(...this.#invoke(fn, values, s2));
        }
      } else {
        results.push(...this.#evalOpaqueCall(node, s, scope, file));
      }
    }
    return results;
  }

  #shouldInline(fn: Value & { kind: 'func' }): boolean {
    if (this.#depth >= MAX_CALL_DEPTH) {
      return false;
    }
    if (fn.scope !== contextOf(fn.file).moduleScope) {
      // closures are always inlined
      return true;
    }
    return this.#isFragmentFunction(fn.node, contextOf(fn.file));
  }

  #invoke(
    fn: Value & { kind: 'func' },
    args: ReadonlyArray<Value>,
    state: State
  ): Results {
    const scope = new Scope(fn.scope, (this.#invocation += 1));
    let current = state;
    (fn.node.parameters as ReadonlyArray<AnyNode>).forEach((param, index) => {
      let value: Value = param.dotDotDotToken
        ? { kind: 'array', items: args.slice(index) }
        : (args[index] ?? UNDEFINED);
      if (
        param.initializer &&
        value.kind === 'lit' &&
        value.value === undefined
      ) {
        const init = this.#eval(
          param.initializer,
          current,
          scope,
          contextOf(fn.file)
        );
        value = init[0]?.[1] ?? UNKNOWN;
      }
      current = this.#bind(
        param.name,
        value,
        current,
        scope,
        contextOf(fn.file)
      );
    });
    this.#depth += 1;
    try {
      return this.#runBody(fn.node, [current], scope, contextOf(fn.file));
    } finally {
      this.#depth -= 1;
    }
  }

  // Calls we don't model. Evaluate arguments (they might contain prepare()
  // calls) and explore any callbacks once.
  #evalOpaqueCall(
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const args = (node.arguments ?? []) as ReadonlyArray<AnyNode>;
    const results: Results = [];
    const calleeResults =
      node.kind === SyntaxKind.CallExpression
        ? this.#eval(node.expression, state, scope, file)
        : [[state, UNKNOWN] as [State, Value]];
    for (const [s0] of calleeResults) {
      for (const [s, values] of this.#evalSequence(args, s0, scope, file)) {
        for (const value of values) {
          this.#explore(value, s);
        }
        results.push([s, UNKNOWN]);
      }
    }
    return results;
  }

  #explore(value: Value, state: State): void {
    if (value.kind === 'func') {
      const key = `${value.file.path}:${value.node.pos}`;
      if (this.#explored.has(key) || this.#depth >= MAX_CALL_DEPTH) {
        return;
      }
      this.#explored.add(key);
      const args = (value.node.parameters as ReadonlyArray<AnyNode>).map(
        () => UNKNOWN
      );
      this.#invoke(value, args, state);
    } else if (value.kind === 'object') {
      for (const prop of value.props.values()) {
        if (prop.kind === 'func') {
          this.#explore(prop, state);
        }
      }
    }
  }

  #evalMethodCall(
    base: Value,
    method: string,
    callee: AnyNode,
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results {
    const args = node.arguments as ReadonlyArray<AnyNode>;
    const results: Results = [];
    for (const [s, values] of this.#evalSequence(args, state, scope, file)) {
      const fn = values[0];

      if (method === 'map' && fn?.kind === 'func') {
        if (base.kind === 'array') {
          let mapped: Array<[State, Array<Value>]> = [[s, []]];
          base.items.forEach((item, index) => {
            const next: Array<[State, Array<Value>]> = [];
            for (const [s2, items] of mapped) {
              for (const [s3, value] of this.#invoke(
                fn,
                [item, lit(index)],
                s2
              )) {
                next.push([s3, [...items, value]]);
              }
            }
            mapped = next;
          });
          for (const [s2, items] of mapped) {
            results.push([s2, { kind: 'array', items }]);
          }
          continue;
        }
        if (
          base.kind === 'repeated' ||
          base.kind === 'unknown' ||
          base.kind === 'sym'
        ) {
          const item = base.kind === 'repeated' ? base.item : UNKNOWN;
          for (const [s2, value] of this.#invoke(fn, [item, UNKNOWN], s)) {
            results.push([s2, { kind: 'repeated', item: value }]);
          }
          continue;
        }
      }

      if (method === 'filter' && fn?.kind === 'func') {
        if (base.kind === 'array') {
          const kept: Array<Value> = [];
          let ambiguous = false;
          base.items.forEach((item, index) => {
            const returned = this.#invoke(fn, [item, lit(index)], s);
            let keep = false;
            let drop = false;
            for (const [s2, value] of returned) {
              const split = this.#truthiness(value, s2);
              keep ||= split.t.length > 0;
              drop ||= split.f.length > 0;
            }
            if (keep && drop) {
              ambiguous = true;
            } else if (keep) {
              kept.push(item);
            }
          });
          results.push([
            s,
            ambiguous
              ? { kind: 'repeated', item: base.items[0] ?? UNKNOWN }
              : { kind: 'array', items: kept },
          ]);
          continue;
        }
        if (base.kind === 'repeated') {
          results.push([s, base]);
          continue;
        }
      }

      if (method === 'join') {
        const separator =
          values[0]?.kind === 'lit' ? String(values[0].value) : ',';
        if (base.kind === 'array') {
          let joined: Value = lit('');
          base.items.forEach((item, index) => {
            if (index > 0) {
              joined = concat(joined, lit(separator), callee);
            }
            joined = concat(joined, item, callee);
          });
          results.push([s, joined]);
          continue;
        }
        if (base.kind === 'repeated' && base.item.kind === 'lit') {
          // Normalize variable-length lists to a single element
          results.push([s, lit(String(base.item.value))]);
          continue;
        }
      }

      if (
        method === 'push' &&
        unwrap(callee.expression).kind === SyntaxKind.Identifier
      ) {
        const key = scope.lookup(unwrap(callee.expression).text);
        if (key != null && base.kind === 'array') {
          results.push([
            s.set(key, { kind: 'array', items: [...base.items, ...values] }),
            UNKNOWN,
          ]);
          continue;
        }
      }

      if (base.kind === 'object') {
        const member = base.props.get(method);
        if (member?.kind === 'func' && this.#depth < MAX_CALL_DEPTH) {
          results.push(...this.#invoke(member, values, s));
          continue;
        }
      }

      for (const value of values) {
        this.#explore(value, s);
      }
      results.push([s, UNKNOWN]);
    }
    return results;
  }

  #evalHelperCall(
    name: string,
    node: AnyNode,
    state: State,
    scope: Scope,
    file: FileContext
  ): Results | undefined {
    const args = node.arguments as ReadonlyArray<AnyNode>;
    switch (name) {
      case 'sqlJoin': {
        return this.#evalSequence(args, state, scope, file).map(
          ([s, values]): [State, Value] => [s, sqlJoin(values[0] ?? UNKNOWN)]
        );
      }
      case 'sqlConstant': {
        return this.#evalSequence(args, state, scope, file).map(
          ([s, values]): [State, Value] => {
            const value = values[0] ?? UNKNOWN;
            if (value.kind === 'lit') {
              return [
                s,
                { kind: 'frag', sql: sqlConstant(value.value), notes: [] },
              ];
            }
            return [
              s,
              {
                kind: 'frag',
                sql: '?',
                notes: [
                  'sqlConstant() with a non-constant value (rendered as `?`)',
                ],
              },
            ];
          }
        );
      }
      case 'sqlId': {
        return this.#evalSequence(args, state, scope, file).map(
          ([s, values]): [State, Value] => {
            const value = values[0] ?? UNKNOWN;
            if (value.kind === 'lit' && typeof value.value === 'string') {
              return [
                s,
                { kind: 'frag', sql: `\`${value.value}\``, notes: [] },
              ];
            }
            return [
              s,
              opaque(
                `sqlId(${args[0]?.getText() ?? ''}) with a non-constant identifier`
              ),
            ];
          }
        );
      }
      case 'strictAssert':
      case 'assertDev':
      case 'assert': {
        const condition = args[0];
        if (condition == null) {
          return undefined;
        }
        return this.#branch(condition, state, scope, file).t.map(
          (s): [State, Value] => [s, UNDEFINED]
        );
      }
      case 'missingCaseError':
        return [[state, UNKNOWN]];
      default:
        return undefined;
    }
  }
}

const KNOWN_HELPERS = new Set([
  'sql',
  'sqlFragment',
  'sqlJoin',
  'sqlConstant',
  'sqlId',
  'strictAssert',
  'assertDev',
  'missingCaseError',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function mergeFlows(a: Flow, b: Flow): Flow {
  return {
    normal: dedupe([...a.normal, ...b.normal]),
    returned: [...a.returned, ...b.returned],
    broke: [...a.broke, ...b.broke],
  };
}

function concat(left: Value, right: Value, node: AnyNode): Value {
  const parts = [left, right];
  let text = '';
  const holes: Array<string> = [];
  for (const part of parts) {
    if (part.kind === 'lit') {
      text += String(part.value);
    } else if (part.kind === 'tmpl') {
      text += part.text;
      holes.push(...part.holes);
    } else if (part.kind === 'opaque') {
      return part;
    } else {
      text += '?';
      holes.push(`\`${node.getText()}\``);
    }
  }
  if (holes.length === 0) {
    return lit(text);
  }
  return { kind: 'tmpl', text, holes };
}

function sqlJoin(value: Value): Value {
  const render = (
    item: Value
  ): { sql: string; notes: ReadonlyArray<string> } | Value => {
    if (item.kind === 'frag') {
      return { sql: item.sql, notes: item.notes };
    }
    if (item.kind === 'opaque') {
      return item;
    }
    return { sql: '?', notes: [] };
  };

  if (value.kind === 'array') {
    const sqls: Array<string> = [];
    const notes: Array<string> = [];
    for (const item of value.items) {
      const rendered = render(item);
      if ('kind' in rendered) {
        return rendered;
      }
      sqls.push(rendered.sql);
      notes.push(...rendered.notes);
    }
    return { kind: 'frag', sql: sqls.join(','), notes };
  }
  if (value.kind === 'repeated') {
    const rendered = render(value.item);
    if ('kind' in rendered) {
      return rendered;
    }
    return {
      kind: 'frag',
      sql: rendered.sql,
      notes: [
        ...rendered.notes,
        'variable-length sqlJoin() list rendered as one item',
      ],
    };
  }
  if (value.kind === 'opaque') {
    return value;
  }
  return {
    kind: 'frag',
    sql: '?',
    notes: ['variable-length sqlJoin() list rendered as one item'],
  };
}

// Mirrors `sqlConstant` in ts/sql/util.std.ts
function sqlConstant(value: Lit): string {
  if (value == null) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${value}`;
  }
  return `'${String(value)}'`;
}

function collectAssignedNames(root: AnyNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: AnyNode): void => {
    if (
      node.kind === SyntaxKind.BinaryExpression &&
      node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= SyntaxKind.LastAssignment
    ) {
      collectTargets(node.left, names);
    } else if (
      (node.kind === SyntaxKind.PrefixUnaryExpression ||
        node.kind === SyntaxKind.PostfixUnaryExpression) &&
      (node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken)
    ) {
      collectTargets(node.operand, names);
    } else if (
      node.kind === SyntaxKind.CallExpression &&
      node.expression.kind === SyntaxKind.PropertyAccessExpression &&
      ['push', 'unshift', 'splice', 'pop', 'shift'].includes(
        node.expression.name.text
      )
    ) {
      collectTargets(node.expression.expression, names);
    }
    node.forEachChild(visit);
  };
  if (
    root.kind === SyntaxKind.ArrayLiteralExpression ||
    root.kind === SyntaxKind.ObjectLiteralExpression
  ) {
    collectTargets(root, names);
  } else {
    visit(root);
  }
  return names;
}

function collectTargets(node: AnyNode, names: Set<string>): void {
  const target = unwrap(node);
  if (target.kind === SyntaxKind.Identifier) {
    names.add(target.text);
  } else if (
    target.kind === SyntaxKind.PropertyAccessExpression ||
    target.kind === SyntaxKind.ElementAccessExpression
  ) {
    collectTargets(target.expression, names);
  } else if (target.kind === SyntaxKind.ArrayLiteralExpression) {
    for (const element of target.elements) {
      collectTargets(element, names);
    }
  } else if (target.kind === SyntaxKind.ObjectLiteralExpression) {
    for (const prop of target.properties) {
      if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
        names.add(prop.name.text);
      } else if (prop.kind === SyntaxKind.PropertyAssignment) {
        collectTargets(prop.initializer, names);
      }
    }
  } else if (target.kind === SyntaxKind.SpreadElement) {
    collectTargets(target.expression, names);
  }
}

function describeConditions(state: State): PathConditions {
  const refined: Array<string> = [];
  for (const [id, domain] of state.refined) {
    refined.push(describeDomain(id, domain));
  }
  const trail: Array<string> = [];
  for (const [condition, truthy] of state.trail) {
    trail.push(truthy ? condition : `!(${condition})`);
  }
  return { refined: refined.sort(), trail: trail.sort() };
}

function describeDomain(label: string, domain: Domain): string {
  const lits = domain.filter(
    (e): e is { kind: 'lit'; value: Lit } => e.kind === 'lit'
  );
  const hasOther = domain.some(e => e.kind === 'other');
  if (!hasOther && lits.length === 1) {
    return `${label} = ${formatLit(lits[0]?.value)}`;
  }
  if (!hasOther) {
    return `${label} ∈ {${lits.map(e => formatLit(e.value)).join(', ')}}`;
  }
  const nonNull = lits.filter(e => !isNullish(e.value));
  if (lits.length === nonNull.length && nonNull.length === 0) {
    return `${label} != null`;
  }
  if (lits.length === 0) {
    return `${label} != null`;
  }
  return `${label} ∈ {${[...lits.map(e => formatLit(e.value)), '…'].join(', ')}}`;
}

// Summarize the condition sets of every path that produced one SQL string
function alternatives(
  paths: ReadonlyArray<ReadonlyArray<string>>,
  siteCommon: ReadonlyArray<string>
): ReadonlyArray<ReadonlyArray<string>> {
  const strip = (list: ReadonlyArray<string>) =>
    list.filter(c => !siteCommon.includes(c));
  const common = strip(intersect(paths));
  const distinct = new Map<string, ReadonlyArray<string>>();
  for (const path of paths) {
    const stripped = strip(path);
    distinct.set(stripped.join('\0'), stripped);
  }
  const sets = [...distinct.values()];
  // Drop sets that are supersets of another set (A | A,B => A)
  const minimal = sets.filter(
    set =>
      !sets.some(
        other =>
          other !== set &&
          other.length < set.length &&
          other.every(c => set.includes(c))
      )
  );
  if (minimal.length === 1 || minimal.length > 4) {
    return common.length > 0 ? [common] : [];
  }
  if (minimal.some(set => set.length === 0)) {
    return [];
  }
  return minimal.sort((a, b) => a.join().localeCompare(b.join()));
}

// Could both condition summaries describe the same path?
function overlaps(
  a: ReadonlyArray<ReadonlyArray<string>>,
  b: ReadonlyArray<ReadonlyArray<string>>
): boolean {
  if (a.length === 0 || b.length === 0) {
    return true;
  }
  return a.some(setA =>
    b.some(
      setB =>
        setA.every(c => setB.includes(c)) || setB.every(c => setA.includes(c))
    )
  );
}

function intersect(
  lists: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> {
  const [first, ...rest] = lists;
  if (first == null) {
    return [];
  }
  return first.filter(item => rest.every(list => list.includes(item)));
}
