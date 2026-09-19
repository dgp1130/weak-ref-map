import {describe, expect, it, vi} from 'vitest';
import {bindInstanceTracking, DeferredWeakRef} from './deferred-weak-ref.js';
import {gc} from './gc.js';

describe('deferred-weak-ref', () => {
  describe('DeferredWeakRef', () => {
    it('returns the same pinned target it was constructed with', () => {
      const target = {};
      const ref = new DeferredWeakRef(target);
      expect(ref.deref()).toBe(target);
    });

    it('pins the target: deref keeps returning it across a forced GC', async () => {
      // The object literal is only reachable through the reference's pin, yet a
      // forced GC must not reclaim it: the pin holds it strongly.
      const ref = new DeferredWeakRef({});
      await gc();
      expect(ref.deref()).toBeDefined();
    });

    it('unpin drops the strong reference and lets the engine reclaim the target', async () => {
      // The variable keeps the target alive past release, so the released state
      // is observable before the last strong reference is dropped.
      const ref = new DeferredWeakRef({});

      ref.unpin();
      expect(ref.deref()).toBeDefined();
      await gc();
      expect(ref.deref()).toBeUndefined();
    });
  });

  describe('bindInstanceTracking', () => {
    it('records every created object reference', () => {
      const cb = vi.fn<Parameters<typeof bindInstanceTracking>[0]>();
      const DeferredWeakRef = bindInstanceTracking(cb);

      const a = new DeferredWeakRef({});
      expect(cb).toHaveBeenCalledWith(a);

      const b = new DeferredWeakRef({});
      expect(cb).toHaveBeenCalledWith(b);

      const c = new DeferredWeakRef({});
      expect(cb).toHaveBeenCalledWith(c);
    });
  });
});
