// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates DATABASE_QUERY_PLANS.md: the `EXPLAIN QUERY PLAN` output for every
 * SQL query shape that can reach `db.prepare()` in the files below, run
 * against a fresh database with every migration applied.
 *
 * Usage:
 *   pnpm build:db-query-plans          # regenerate
 *   pnpm build:db-query-plans --check  # fail if out of date
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { globSync } from 'node:fs';
import * as Prettier from 'prettier';
import * as SqlFormatter from 'sql-formatter';

import type { WritableDB } from '../../ts/sql/Interface.std.ts';
import { analyze } from './analyzer.node.ts';
import type { QuerySite, QueryVariant } from './analyzer.node.ts';

const IS_CI = process.env.CI != null;
const REPO_ROOT = join(__dirname, '..', '..');
const FILE_NAME = 'DATABASE_QUERY_PLANS.md';

const FILES = [
  'ts/sql/Server.node.ts',
  'ts/sql/hydration.std.ts',
  ...globSync('ts/sql/server/*.ts', { cwd: REPO_ROOT }).sort(),
];

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function createMigratedDB(): Promise<WritableDB> {
  // Imported lazily so the analyzer can run without native modules loaded
  const { createDB, updateToVersion } =
    await import('../../ts/test-node/sql/helpers.node.ts');
  const { SCHEMA_VERSIONS } =
    await import('../../ts/sql/migrations/index.node.ts');
  const maxVersion = SCHEMA_VERSIONS.at(-1)?.version;
  if (maxVersion == null) {
    throw new Error('Missing SCHEMA_VERSIONS');
  }
  const db = createDB();
  updateToVersion(db, maxVersion);
  return db;
}

type PlanRow = { id: number; parent: number; detail: string };

type Explained = { ok: true; plan: string } | { ok: false; error: string };

// Placeholder values don't affect the plan, so bind NULL to all of them.
function nullParams(
  sql: string
): Array<null> | Record<string, null> | undefined {
  const named = new Set(
    [...sql.matchAll(/(?<![\w'"])[$:@]([A-Za-z_]\w*)/g)].map(m => m[1] ?? '')
  );
  if (named.size > 0) {
    return Object.fromEntries([...named].map(name => [name, null]));
  }
  const positional = [...sql.matchAll(/\?/g)].length;
  return positional > 0 ? new Array(positional).fill(null) : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

function explain(db: WritableDB, sql: string): Explained {
  const statement = `EXPLAIN QUERY PLAN ${sql}`;
  try {
    let rows: Array<PlanRow>;
    try {
      rows = db.prepare(statement).all<PlanRow>();
    } catch (error) {
      if (!/Expected \d+ parameters/.test(errorMessage(error))) {
        throw error;
      }
      rows = db.prepare(statement).all<PlanRow>(nullParams(sql) as never);
    }
    return { ok: true, plan: formatPlan(rows) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function withSetup<T>(
  db: WritableDB,
  setup: ReadonlyArray<string>,
  fn: () => T
): T {
  const tables: Array<string> = [];
  for (const sql of setup) {
    for (const match of sql.matchAll(
      /CREATE\s+TEMP(?:ORARY)?\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"`]+)/gi
    )) {
      tables.push(match[1] ?? '');
    }
    try {
      db.exec(sql);
    } catch {
      // EXPLAIN will report the missing table
    }
  }
  try {
    return fn();
  } finally {
    for (const table of tables) {
      db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    }
  }
}

function formatPlan(rows: ReadonlyArray<PlanRow>): string {
  const children = new Map<number, Array<PlanRow>>();
  for (const row of rows) {
    let list = children.get(row.parent);
    if (list == null) {
      list = [];
      children.set(row.parent, list);
    }
    list.push(row);
  }
  const lines: Array<string> = [];
  const visit = (parent: number, depth: number) => {
    for (const row of children.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth)}${row.detail}`);
      visit(row.id, depth + 1);
    }
  };
  visit(0, 0);
  return lines.length > 0 ? lines.join('\n') : '(no plan)';
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function formatSql(sql: string): string {
  try {
    return SqlFormatter.format(sql, {
      language: 'sqlite',
      useTabs: false,
      tabWidth: 2,
      expressionWidth: 60,
      paramTypes: { positional: true, named: ['$', ':', '@'] },
    });
  } catch {
    return sql
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim() !== '')
      .join('\n');
  }
}

function codeBlock(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

function details(summary: string, contents: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${contents}\n</details>\n`;
}

const PLAN_WARNINGS: ReadonlyArray<[RegExp, string]> = [
  [/^SCAN (?!CONSTANT ROW)\S+(?! USING (COVERING )?INDEX)( |$)/m, 'full scan'],
  [/USE TEMP B-TREE/m, 'temp b-tree'],
];

function planWarnings(plan: string): Array<string> {
  return PLAN_WARNINGS.filter(([regex]) => regex.test(plan)).map(
    ([, label]) => label
  );
}

class Stats {
  sites = 0;
  variants = 0;
  issues = 0;
  errors = 0;

  addSite(site: QuerySite): void {
    this.sites += 1;
    this.variants += site.variants.length;
    this.issues += site.issues.length;
  }

  addError(): void {
    this.errors += 1;
  }
}

function variantLabel(variant: QueryVariant): string {
  return variant.conditions
    .map(set => set.map(c => `\`${c}\``).join(', '))
    .join(' **or** ');
}

function printVariant(
  db: WritableDB,
  variant: QueryVariant,
  label: string,
  stats: Stats
): string {
  let out = '';
  if (label) {
    out += `**${label}**\n\n`;
  }

  const result = explain(db, variant.sql);
  if (result.ok) {
    const warnings = planWarnings(result.plan);
    if (warnings.length > 0) {
      out += `> ⚠️ ${warnings.join(', ')}\n\n`;
    }
    out += codeBlock('text', result.plan);
  } else {
    stats.addError();
    out += `> ❌ EXPLAIN failed: \`${result.error}\`\n\n`;
  }
  for (const note of variant.notes) {
    out += `- _${note}_\n`;
  }
  if (variant.notes.length > 0) {
    out += '\n';
  }
  out += details('SQL', codeBlock('sql', formatSql(variant.sql)));
  return out;
}

function printSite(db: WritableDB, site: QuerySite, stats: Stats): string {
  stats.addSite(site);

  let out = `### \`${site.functionName}\` #${site.ordinal}\n\n`;
  for (const issue of site.issues) {
    out += `> ❓ ${issue}\n\n`;
  }
  // Variants can differ by conditions the analyzer can't name (e.g.
  // `limit > 0`), so number any labels that would otherwise repeat.
  const labels = site.variants.map(variantLabel);
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const uniqueLabels = labels.map(label => {
    if (site.variants.length === 1 || (counts.get(label) ?? 0) === 1) {
      return label;
    }
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return label ? `${label} (variant ${n})` : `variant ${n}`;
  });

  withSetup(db, site.setup, () => {
    site.variants.forEach((variant, index) => {
      out += printVariant(db, variant, uniqueLabels[index] ?? '', stats);
      out += '\n';
    });
  });
  return out;
}

function printDocument(
  db: WritableDB,
  sites: ReadonlyArray<QuerySite>
): string {
  const stats = new Stats();
  let body = '';
  let currentFile = '';
  for (const site of sites) {
    if (site.file !== currentFile) {
      currentFile = site.file;
      body += `## ${currentFile}\n\n`;
    }
    body += printSite(db, site, stats);
  }

  let out = '';
  out += '<!-- Copyright 2026 Signal Messenger, LLC -->\n';
  out += '<!-- SPDX-License-Identifier: AGPL-3.0-only -->\n';
  out += '\n';
  out += '# Database Query Plans\n';
  out += '\n';
  out += `Generated by \`pnpm build:db-query-plans\`. Every query shape that can reach \`db.prepare()\` is found statically and run through \`EXPLAIN QUERY PLAN\` against a database with all migrations applied.\n`;
  out += '\n';
  out += `- ${stats.sites} prepare() call sites, ${stats.variants} query variants\n`;
  out += `- ${stats.issues} sites (or parts of sites) the analyzer couldn't follow (❓)\n`;
  out += `- ${stats.errors} variants where EXPLAIN failed (❌)\n`;
  out += '\n';
  out += body.trimEnd();
  out += '\n';
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (IS_CI && !args.check) {
    // oxlint-disable-next-line no-console
    console.log('Skipping `pnpm build:db-query-plans` in CI without --check.');
    return;
  }

  const sites = analyze({
    cwd: REPO_ROOT,
    tsconfig: join(REPO_ROOT, 'tsconfig.json'),
    files: FILES,
  });

  const db = await createMigratedDB();
  const filePath = join(REPO_ROOT, FILE_NAME);
  // Format like the rest of the repo so `lint-prettier` agrees with --check
  const contents = await Prettier.format(printDocument(db, sites), {
    ...(await Prettier.resolveConfig(filePath)),
    filepath: filePath,
  });
  db.close();

  let current: string | null;
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    current = null;
  }

  if (current === contents) {
    // oxlint-disable-next-line no-console
    console.log(styleText('dim', `${FILE_NAME} was unchanged.\n`));
    return;
  }

  if (args.check) {
    if (IS_CI) {
      // oxlint-disable-next-line no-console
      console.log(
        `::error file=${FILE_NAME}::${FILE_NAME} is out of date, run \`pnpm build:db-query-plans\` to update.`
      );
    } else {
      // oxlint-disable-next-line no-console
      console.log(
        styleText(
          'red',
          `${FILE_NAME} is out of date, run ${styleText('magenta', '`pnpm build:db-query-plans`')} to update.\n`
        )
      );
    }
    process.exitCode = 1;
    return;
  }

  await writeFile(filePath, contents);
  // oxlint-disable-next-line no-console
  console.log(styleText('green', `${FILE_NAME} was updated.\n`));
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
}

void run();
