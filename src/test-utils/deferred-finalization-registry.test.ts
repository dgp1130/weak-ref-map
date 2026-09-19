import * as fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {DeferredFinalizationRegistry, bindInstanceTracking} from './deferred-finalization-registry.js';
import {gc} from './gc.js';

const keys = ['a', 'b', 'c', 'd', 'e', 'f'];

const seedArbitrary = fc.array(
  fc.float({min: 0.0, max: 1.0, maxExcluded: true}),
  {maxLength: 10},
);
function toSeedFn(arbitrary: number[]): () => number {
  let index = -1;
  return () => {
    index = (index + 1) % arbitrary.length;
    return arbitrary[index]!;
  };
}

describe('deferred-finalization-registry', () => {
  describe('DeferredFinalizationRegistry', () => {
    it('queues the held value and defers the callback until flushAll', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);

      registry.register({}, 'foo');
      expect(registry.pendingCount).toBe(0);

      await gc();

      // Reclaimed, so queued, but the cleanup callback must not run yet.
      expect(registry.pendingCount).toBe(1);
      expect(cb).not.toHaveBeenCalled();

      registry.flushAll(() => 0.999);
      expect(cb).toHaveBeenCalledExactlyOnceWith('foo');
      expect(registry.pendingCount).toBe(0);
    });

    it('unregister unregisters the object', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);

      const token = {};
      registry.register({}, 'foo', token);
      expect(registry.unregister(token)).toBe(true);

      await gc();
      expect(registry.pendingCount).toBe(0);
      registry.flushAll(() => 0.999);
      expect(cb).not.toHaveBeenCalled();

      // Nothing to unregister.
      expect(registry.unregister({})).toBe(false);
    });

    it('flushAll delivers every queued callback exactly once', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);

      registry.register({}, 'a');
      registry.register({}, 'b');

      await gc();
      registry.flushAll(incremental());
      expect(registry.pendingCount).toBe(0);

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenCalledWith('a');
      expect(cb).toHaveBeenCalledWith('b');
    });

    it('flushSome delivers a subset and keeps the rest queued', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);
      for (const key of keys) registry.register({}, key);
      await gc();

      registry.flushSome(incremental(0.5));

      expect(registry.pendingCount).toBe(3);
      expect(cb).toHaveBeenCalledTimes(3);
      expect(cb).toHaveBeenCalledWith('a');
      expect(cb).toHaveBeenCalledWith('b');
      expect(cb).toHaveBeenCalledWith('c');
    });

    it('flushSome may deliver nothing, keeping the whole queue', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);
      for (const key of keys) registry.register({}, key);
      await gc();

      registry.flushSome(() => 0);
      expect(cb).not.toHaveBeenCalled();
      expect(registry.pendingCount).toBe(keys.length);
    });

    it('flushSome may deliver everything, emptying the whole queue', async () => {
      const cb = vi.fn<ConstructorParameters<typeof DeferredFinalizationRegistry>[0]>();
      const registry = new DeferredFinalizationRegistry(cb);
      for (const key of keys) registry.register({}, key);
      await gc();

      registry.flushSome(() => 0.999);
      expect(cb).toHaveBeenCalledTimes(keys.length);
      expect(registry.pendingCount).toBe(0);
    });

    it('is a no-op on an empty queue without drawing', () => {
      const cb = vi.fn<() => number>();

      const registry = new DeferredFinalizationRegistry(() => {});
      registry.flushAll(cb);
      registry.flushSome(cb);

      expect(cb).not.toHaveBeenCalled();
    });

    it('delivers the same flush order for the same draw seed', async () => {
      await fc.assert(fc.asyncProperty(seedArbitrary, async (seed) => {
        const seedFn = toSeedFn(seed);
        const first = await flushOrder(seedFn);
        const second = await flushOrder(seedFn);
        expect(first).toEqual(second);
      }));
    });
  });

  describe('bindInstanceTracking', () => {
    it('records every created registry in creation order', () => {
      const cb = vi.fn<Parameters<typeof bindInstanceTracking>[0]>();
      const FinalizationRegistry = bindInstanceTracking(cb);

      const a = new FinalizationRegistry(() => {});
      expect(cb).toHaveBeenCalledWith(a);

      const b = new FinalizationRegistry(() => {});
      expect(cb).toHaveBeenCalledWith(b);

      const c = new FinalizationRegistry(() => {});
      expect(cb).toHaveBeenCalledWith(c);
    });
  });
});

/** Registers every key, reclaims all targets, and returns the delivery order. */
async function flushOrder(seed: () => number): Promise<string[]> {
  const reclaimed = new Array<string>();
  const registry = new DeferredFinalizationRegistry((key: string) => reclaimed.push(key));

  for (const key of keys) registry.register({}, key);
  await gc();
  registry.flushAll(seed);
  return reclaimed;
}

/** Loops from 0 to 1 in by steps of {@link interval}. */
function incremental(start: number = 0, interval: number = 0.1): () => number {
  if (start < 0 || start >= 1) {
    expect.fail(`Start must be between 0 and 1`);
  }
  if (interval < 0 || interval >= 1) {
    expect.fail(`Interval must be between 0 and 1`);
  }

  let curr = start - interval;
  return () => {
    curr = curr + interval % 1;
    return curr;
  };
}
