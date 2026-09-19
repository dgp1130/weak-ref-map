import {describe, expect, it, vi} from 'vitest';

describe('WeakRefMap', () => {
  it('should reclaim on gc', async () => {
    for (const index of times(1_000)) {
      const finalizer = vi.fn();
      let ref: WeakRef<{}>;
      const registry = new FinalizationRegistry(finalizer);
      (() => {
        const obj = {};
        ref = new WeakRef(obj);
        registry.register(obj, 'held value');
      })();

      await gc();

      expect(ref.deref(), `Index: ${index}`).toBeUndefined();
      expect(finalizer, `Index: ${index}`)
          .toHaveBeenCalledExactlyOnceWith('held value');
    }
  }, 10_000);
});

function* times(n: number): Generator<number, void, void> {
  for (let i = 0; i < n; i++) yield i;
}

function macroTask(): Promise<void> {
  return new Promise((resolve) => void setTimeout(resolve));
}

async function gc(): Promise<void> {
  // Wait for current references to fall out of the keep alive grant.
  await macroTask();

  // Trigger GC, clears all unreachable objects behind `WeakRef`.
  globalThis.gc!();

  // Wait for all `FinalizationRegistry` callbacks to be invoked.
  await macroTask();
}
