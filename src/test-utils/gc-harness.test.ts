import {describe, expect, it} from 'vitest';
import {SeededGCHarness} from './gc-harness.js';

const keys = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('SeededGCHarness engine', () => {
  it('pins targets passed into a mock WeakRef until released', async () => {
    const harness = new SeededGCHarness(0);
    const {WeakRef} = harness;
    let ref!: WeakRef<object>;
    (() => {
      ref = new WeakRef({});
    })();

    // Pinned strongly: even a forced GC cannot reclaim it.
    await harness.collect();
    expect(ref.deref()).toBeDefined();

    // Once released and unreferenced, a forced GC really reclaims it.
    harness.release(1);
    await harness.collect();
    expect(ref.deref()).toBeUndefined();
  });

  it('reproduces the same release decisions for the same seed', () => {
    const first = releases(1234);
    const second = releases(1234);
    expect(first).toEqual(second);
  });

  it('produces different release decisions for different seeds', () => {
    expect(releases(1234)).not.toEqual(releases(4321));
  });

  it('reset restores the PRNG stream and clears engine state', () => {
    const harness = new SeededGCHarness(1234);
    const firstTargets = heldTargets(5, harness);
    const first = releaseIndices(firstTargets, harness.release(1));

    harness.reset();
    expect(harness.pendingCount).toBe(0);

    const secondTargets = heldTargets(5, harness);
    expect(releaseIndices(secondTargets, harness.release(1))).toEqual(first);
  });
});

describe('SeededGCHarness FinalizationRegistry', () => {
  it('queues callbacks and delivers them only once targets are reclaimed', async () => {
    const harness = new SeededGCHarness(1);
    const {WeakRef, FinalizationRegistry} = harness;
    const reclaimed = new Array<string>();
    const registry = new FinalizationRegistry((key: string) => reclaimed.push(key));

    (() => {
      const foo = {};
      new WeakRef(foo);
      registry.register(foo, 'foo');
      const token = {};
      const bar = {};
      new WeakRef(bar);
      registry.register(bar, 'bar', token);
      expect(registry.unregister(token)).toBe(true);
    })();

    // Nothing is reclaimed yet: registration defers delivery, nothing is queued.
    expect(harness.pendingCount).toBe(0);
    harness.flushAll();
    expect(reclaimed).toEqual([]);
    expect(harness.pendingCount).toBe(0);

    harness.release(1);
    await harness.collect();
    harness.flushAll();

    // Unregistered targets are never delivered.
    expect(reclaimed).toEqual(['foo']);
    expect(harness.pendingCount).toBe(0);
  });

  it('never delivers callbacks for targets which are still referenced', async () => {
    const harness = new SeededGCHarness(2);
    const {WeakRef, FinalizationRegistry} = harness;
    const reclaimed = new Array<string>();
    const registry = new FinalizationRegistry((key: string) => reclaimed.push(key));

    let live: object | undefined = {};
    new WeakRef(live);
    registry.register(live, 'live');

    // Registered but pinned: the engine never reclaims it, flush has nothing.
    harness.flushSome();
    expect(reclaimed).toEqual([]);
    expect(harness.pendingCount).toBe(0);

    // Released, but this test still holds a strong reference, so even a forced
    // GC cannot reclaim it and its callback must not be delivered.
    harness.release(1);
    await harness.collect();
    harness.flushAll();
    expect(reclaimed).toEqual([]);
    expect(harness.pendingCount).toBe(0);

    // Dropping the last strong reference lets the next forced GC reclaim it.
    live = undefined;
    await harness.collect();
    harness.flushAll();
    expect(reclaimed).toEqual(['live']);
    expect(harness.pendingCount).toBe(0);
  });

  it('flushSome delivers a subset and keeps the rest queued', async () => {
    const harness = new SeededGCHarness(3);
    const {WeakRef, FinalizationRegistry} = harness;
    const reclaimed = new Array<string>();
    const registry = new FinalizationRegistry((key: string) => reclaimed.push(key));

    for (const key of keys) {
      registerKey(registry, WeakRef, key);
    }

    harness.release(1);
    await harness.collect();
    harness.flushSome();

    expect(harness.pendingCount).toBe(keys.length - reclaimed.length);

    harness.flushAll();
    expect(harness.pendingCount).toBe(0);
    expect([...reclaimed].sort()).toEqual(keys);
  });

  it('flushAll drains every registry exactly once', async () => {
    const harness = new SeededGCHarness(5);
    const {WeakRef, FinalizationRegistry} = harness;
    const reclaimed = new Array<string>();
    const registryA = new FinalizationRegistry((key: string) => reclaimed.push(key));
    const registryB = new FinalizationRegistry((key: string) => reclaimed.push(key));

    (() => {
      const a = {};
      new WeakRef(a);
      registryA.register(a, 'a');
      const b = {};
      new WeakRef(b);
      registryB.register(b, 'b');
      const c = {};
      new WeakRef(c);
      registryA.register(c, 'c');
    })();

    // Nothing is reclaimed yet; pendingCount aggregates across all registries.
    expect(harness.pendingCount).toBe(0);
    harness.flushAll();
    expect(harness.pendingCount).toBe(0);

    harness.release(1);
    await harness.collect();
    harness.flushSome();
    expect(harness.pendingCount).toBe(3 - reclaimed.length);

    harness.flushAll();
    expect(harness.pendingCount).toBe(0);
    expect([...reclaimed].sort()).toEqual(['a', 'b', 'c']);
  });

  // TODO: flaky
  it('delivers the same flush order for the same seed', async () => {
    expect(await flushOrder(1234)).toEqual(await flushOrder(1234));
  });

  it('delivers a different flush order for different seeds', async () => {
    expect(await flushOrder(1234)).not.toEqual(await flushOrder(4321));
  });
});

describe('SeededGCHarness streams', () => {
  it('finalizer draws do not perturb the release stream', () => {
    const control = releases(1234);

    const harness = new SeededGCHarness(1234);
    const targets = heldTargets(5, harness);
    for (let i = 0; i < 10; i++) harness.finalizerDraw();

    expect(releaseIndices(targets, harness.release(0.5))).toEqual(control);
  });

  it('release decisions do not perturb the finalizer stream', () => {
    const control = finalizerDraws(new SeededGCHarness(1234));

    const harness = new SeededGCHarness(1234);
    heldTargets(5, harness);
    for (let i = 0; i < 10; i++) harness.release(0.5);

    expect(finalizerDraws(harness)).toEqual(control);
  });

  it('reset re-seeds the finalizer stream', () => {
    const harness = new SeededGCHarness(42);

    const first = harness.finalizerDraw();
    harness.finalizerDraw();

    harness.reset();
    expect(harness.finalizerDraw()).toBe(first);
  });
});

/**
 * Holds `count` fresh targets in `harness` by routing them through its mock
 * `WeakRef` class, then releases them once with `release(0.5)`: pairs each
 * released target back to its index. All steps share one call.
 */
function releases(seed: string | number): readonly number[] {
  const harness = new SeededGCHarness(seed);
  const targets = heldTargets(5, harness);
  return releaseIndices(targets, harness.release(0.5));
}

/** Holds `count` fresh targets by routing them through the harness mock `WeakRef`. */
function heldTargets(count: number, harness: SeededGCHarness): object[] {
  const targets = Array.from({length: count}, () => ({} as object));
  const {WeakRef} = harness;
  for (const target of targets) new WeakRef(target);
  return targets;
}

/** Maps released targets back to their hold indices, sorted ascending. */
function releaseIndices(targets: readonly object[], released: readonly object[]): number[] {
  const index = new Map(targets.map((target, i) => [target, i] as const));
  return released.map((target) => index.get(target)!).sort((a, b) => a - b);
}

/** Registers every key, reclaims everything, and returns the delivery order. */
async function flushOrder(seed: string | number): Promise<string[]> {
  const harness = new SeededGCHarness(seed);
  const {WeakRef, FinalizationRegistry} = harness;
  const reclaimed = new Array<string>();
  const registry = new FinalizationRegistry((key: string) => reclaimed.push(key));

  for (const key of keys) {
    registerKey(registry, WeakRef, key);
  }

  harness.release(1);
  await harness.collect();
  harness.flushAll();

  return reclaimed;
}

/**
 * Registers a fresh target for `key` through an injected function body, so the
 * target is (and stays) unreferenced the moment the call returns even when the
 * loop this runs inside keeps its own bindings alive.
 */
function registerKey(
  registry: FinalizationRegistry<string>,
  WeakRef: typeof globalThis.WeakRef,
  key: string,
): void {
  const target = {};
  new WeakRef(target);
  registry.register(target, key);
}

function finalizerDraws(harness: SeededGCHarness): readonly number[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map(() => harness.finalizerDraw());
}
