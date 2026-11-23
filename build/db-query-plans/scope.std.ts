// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { AnyNode } from './values.std.ts';

/**
 * A lexical scope. Maps variable names to keys that index into a `State`.
 * Each function invocation gets unique keys, so inlining the same closure
 * twice doesn't mix up its variables.
 */
export class Scope {
  readonly vars = new Map<string, string>();
  readonly parent: Scope | null;
  readonly invocation: number;

  constructor(parent: Scope | null, invocation: number) {
    this.parent = parent;
    this.invocation = invocation;
  }

  lookup(name: string): string | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  declare(name: string, node: AnyNode): string {
    const key = `${this.invocation}:${name}@${node.pos}`;
    this.vars.set(name, key);
    return key;
  }
}
