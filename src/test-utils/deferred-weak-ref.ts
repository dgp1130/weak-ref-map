// Store eager reference in case the real implementation gets overwritten with
// the deferred variant below.
const WeakRef = globalThis.WeakRef;

/**
 * A stand-in for {@link WeakRef} built on top of the real engine class.
 *
 * The double mirrors the real constructor signature, so a bound class can be
 * injected wherever the global `WeakRef` is used. It delegates to a *real*
 * `WeakRef` internally, and additionally retains a strong reference to the
 * target until {@link unpin} drops it:
 *
 * - Constructing a `DeferredWeakRef` to a live target pins it strongly, so
 *   {@link deref} keeps returning it no matter what the garbage collector does.
 * - {@link unpin} drops the strong reference. From then on the target is an
 *   orphan and really can be reclaimed by the engine at any point in the
 *   synchronous execution, exactly like a plain `WeakRef`.
 * - `deref()` returns `undefined` once the engine has actually reclaimed the
 *   target.
 *
 * The onus is on the caller to drop its own strong references to a released
 * target; otherwise it will stay alive indefinitely.
 */
export class DeferredWeakRef<T extends WeakKey> extends WeakRef<T> {
  /**
   * Keep a strong reference to the target to prevent GC until it is explicitly
   * unpinned. This value is very actually used to _do_ anything, just keeping
   * the reference around is all that's necessary.
   */
  private _pinned: T | undefined;

  constructor(target: T) {
    super(target);
    this._pinned = target;
  }

  /**
   * Drops the strong reference to the target, making it eligible for real
   * reclamation by the engine.
   */
  unpin(): void {
    this._pinned = undefined;
  }
}

/**
 * Returns a `DeferredWeakRef` class bound to invoke the given callback every
 * time a new instance is constructed. This allows tracking all created objects
 * so they can be centrally unpinned as appropriate.
 */
export function bindInstanceTracking(
  cb: (ref: DeferredWeakRef<WeakKey>) => void,
): WeakRefConstructor {
  return class BoundDeferredWeakRef<Target extends WeakKey>
      extends DeferredWeakRef<Target> {
    constructor(target: Target) {
      super(target);
      cb(this);
    }
  }
}
