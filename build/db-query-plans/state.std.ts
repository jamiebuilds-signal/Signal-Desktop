// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Domain, Value } from './values.std.ts';

/**
 * The interpreter state along one path. Immutable: every update returns a
 * copy, so forked paths never affect each other.
 */
export class State {
  // variable key -> value
  readonly values: Map<string, Value>;
  // sym id -> narrowed domain
  readonly refined: Map<string, Domain>;
  // Conditions we couldn't narrow anything from (e.g. `limit > 0`), kept
  // only to label variants. Not part of the fingerprint: when two states
  // merge, only the conditions true on both paths survive.
  readonly trail: Map<string, boolean>;

  constructor(
    values = new Map<string, Value>(),
    refined = new Map<string, Domain>(),
    trail = new Map<string, boolean>()
  ) {
    this.values = values;
    this.refined = refined;
    this.trail = trail;
  }

  clone(): State {
    return new State(
      new Map(this.values),
      new Map(this.refined),
      new Map(this.trail)
    );
  }

  assume(condition: string, truthy: boolean): State {
    const next = this.clone();
    next.trail.set(condition, truthy);
    return next;
  }

  set(key: string, value: Value): State {
    const next = this.clone();
    next.values.set(key, value);
    return next;
  }

  refine(id: string, domain: Domain): State {
    const next = this.clone();
    next.refined.set(id, domain);
    return next;
  }
}
