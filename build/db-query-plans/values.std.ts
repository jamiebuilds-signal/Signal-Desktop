// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Scope } from './scope.std.ts';

// The AST types from the tsgo API are precise unions, but the interpreter
// switches on `kind` and reads properties directly, so we use a loose alias.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyNode = any;

// Where a function value was defined (opaque to this module)
export type FileRef = { readonly path: string };

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type Lit = string | number | boolean | bigint | null | undefined;

export type DomainEntry =
  | { kind: 'lit'; value: Lit }
  // Some non-nullish, non-literal value (e.g. `string`, `number`, an object).
  | { kind: 'other'; alwaysTruthy: boolean };

export type Domain = ReadonlyArray<DomainEntry>;

export type Value =
  | { kind: 'lit'; value: Lit }
  // A plain JS string with unresolvable `${}` holes (legacy SQL strings)
  | { kind: 'tmpl'; text: string; holes: ReadonlyArray<string> }
  // A QueryFragment
  | { kind: 'frag'; sql: string; notes: ReadonlyArray<string> }
  // A value derived from a function parameter
  | { kind: 'sym'; id: string; label: string; domain: Domain | null }
  | { kind: 'unknown' }
  // Something the analysis definitely can't follow, poisons queries using it
  | { kind: 'opaque'; reason: string }
  | { kind: 'array'; items: ReadonlyArray<Value> }
  // An array of unknown length whose items all look like `item`
  | { kind: 'repeated'; item: Value }
  | { kind: 'object'; props: ReadonlyMap<string, Value> }
  | { kind: 'func'; node: AnyNode; scope: Scope; file: FileRef };

export const UNKNOWN: Value = { kind: 'unknown' };
export const UNDEFINED: Value = { kind: 'lit', value: undefined };

export function lit(value: Lit): Value {
  return { kind: 'lit', value };
}

export function opaque(reason: string): Value {
  return { kind: 'opaque', reason };
}
