import {describe, it} from 'vitest';
import {WeakRefMap} from './weak-ref-map.js';
import {WeakRefMap2} from './weak-ref-map-2.js';
import {runGcCommandSuite} from './test-utils/gc-commands.js';
import type {TestedCollection} from './test-utils/gc-commands.js';
import type {SeededGCHarness} from './test-utils/gc-harness.js';

describe('WeakRefMap GC property', () => {
  it('preserves pinned targets and drops released ones', async () => {
    await runGcCommandSuite(makeWeakRefMapCollection, {
      factory: () => ({}),
      numRuns: 100,
    });
  }, 60_000);
});

describe('WeakRefMap2 GC property', () => {
  it('preserves pinned targets and drops released ones', async () => {
    await runGcCommandSuite(makeWeakRefMap2Collection, {
      factory: () => ({}),
      numRuns: 100,
    });
  }, 60_000);
});

function makeWeakRefMapCollection(harness: SeededGCHarness): TestedCollection<object> {
  return new WeakRefMapCollection(harness.WeakRef, harness.FinalizationRegistry);
}

function makeWeakRefMap2Collection(harness: SeededGCHarness): TestedCollection<object> {
  return new WeakRefMap2<string, object>(null, harness.WeakRef, harness.FinalizationRegistry);
}

/**
 * Adapts {@link WeakRefMap} to the {@link TestedCollection} interface by hiding
 * the `WeakRef` from its API, since `Map`'s `has` reports entries which have
 * not yet been cleaned up.
 *
 * Values are wrapped in the injected `WeakRef` class, which pins them in the
 * harness the moment they enter a `WeakRef`.
 */
class WeakRefMapCollection implements TestedCollection<object> {
  private readonly map: WeakRefMap<string, object>;
  private readonly WeakRef: typeof globalThis.WeakRef;

  constructor(
    WeakRef: typeof globalThis.WeakRef,
    FinalizationRegistry: typeof globalThis.FinalizationRegistry,
  ) {
    this.map = new WeakRefMap<string, object>(FinalizationRegistry);
    this.WeakRef = WeakRef;
  }

  set(key: string, value: object): void {
    this.map.set(key, new this.WeakRef(value));
  }

  get(key: string): object | undefined {
    return this.map.get(key)?.deref();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    return this.map.size;
  }
}
