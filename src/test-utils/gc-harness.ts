import seedrandom from 'seedrandom';
import {DeferredWeakRef, bindInstanceTracking as bindWeakRefInstances} from './deferred-weak-ref.js';
import {DeferredFinalizationRegistry, bindInstanceTracking as bindFinalizationRegistryInstances} from './deferred-finalization-registry.js';

/**
 * A deterministic, seed-based orchestrator for the deferred doubles.
 *
 * The harness owns the two seeded PRNG streams and exposes simulated engine
 * classes matching the global `WeakRef` and `FinalizationRegistry`
 * constructors. It does not implement any engine behavior itself; that lives in
 * {@link DeferredWeakRef} and {@link DeferredFinalizationRegistry}, which the
 * harness drives entirely through their public control methods. In particular:
 *
 * - Constructing a `WeakRef` to a live target *pins* it through a real strong
 *   reference until the harness {@link release}s it, so the collection under
 *   test can always serve a pinned value even across forced garbage collection.
 * - {@link release} picks a seeded pseudo-random subset of the held targets,
 *   calls `release()` on their references, and returns those targets. The
 *   caller must drop its own strong references to match, mirroring what a real
 *   engine does between GC steps.
 * - {@link collect} runs a real forced GC, reclaiming every released target the
 *   caller stopped referencing. From then on each such mock `WeakRef` derefs to
 *   `undefined`.
 * - Reclaimed targets queue cleanup callbacks in their mock
 *   `FinalizationRegistry`, which {@link flushSome} / {@link flushAll} deliver
 *   in a seeded pseudo-random order. Callbacks for targets which are still
 *   alive are never delivered.
 *
 * Registering a target with a mock `FinalizationRegistry` does *not* pin it;
 * the collection under test must hold values through the mock `WeakRef` class.
 * {@link release} works on *targets* rather than ids, so callers (such as a
 * property-test model) must reverse-map the released targets to their own keys
 * and drop the corresponding strong references symmetrically.
 *
 * Two independent seeded streams are kept (via `seedrandom`), so a given seed
 * reproduces every decision exactly:
 *
 * - The *release* stream picks which targets become eligible for collection.
 * - The *finalizer* stream drives cleanup delivery, so a derived use of
 *   delivery cannot perturb release decisions (and vice versa).
 *
 * Use a single harness instance for all collections under test in a property
 * run, and call {@link reset} before each run.
 */
export class SeededGCHarness {
  readonly seed: string;

  /**
   * Deterministic stand-in for `WeakRef`. Targets are pinned on construction,
   * become eligible once {@link release}d, and deref to `undefined` once the
   * engine actually reclaims them via {@link collect}.
   */
  readonly WeakRef: typeof globalThis.WeakRef;

  /**
   * Deterministic stand-in for `FinalizationRegistry`. Wraps the real registry
   * and queues cleanup callbacks for reclaimed targets, deferring delivery to
   * {@link flushSome}/{@link flushAll}.
   */
  readonly FinalizationRegistry: typeof globalThis.FinalizationRegistry;

  private releaseRng: () => number;
  private finalizerRng: () => number;
  private readonly weakRefs = new Set<DeferredWeakRef<WeakKey>>();
  private readonly registries = new Set<DeferredFinalizationRegistry<unknown>>();

  constructor(seed: string | number) {
    this.seed = String(seed);
    this.releaseRng = seedrandom(this.seed);
    this.finalizerRng = seedrandom(`${this.seed}:finalizer`);

    this.WeakRef = bindWeakRefInstances((ref) => {
      this.weakRefs.add(ref);
    });
    this.FinalizationRegistry = bindFinalizationRegistryInstances((registry) => {
      this.registries.add(registry);
    });
  }

  /**
   * Resets the harness to its initial state: every target and registry is
   * forgotten and both PRNG streams are re-seeded.
   */
  reset(): void {
    this.weakRefs.clear();
    this.registries.clear();
    this.releaseRng = seedrandom(this.seed);
    this.finalizerRng = seedrandom(`${this.seed}:finalizer`);
  }

  /**
   * Releases a seeded pseudo-random subset of the held targets. Released
   * targets become eligible for reclamation but are *not* reclaimed here; call
   * {@link collect} once every strong reference has been dropped.
   *
   * @param unpinProbability - Probability that any given held target is
   *     released on this step, in `[0, 1]`.
   * @returns The released targets, so the caller can mirror the release
   *     decisions in its own state by dropping matching strong references.
   */
  release(unpinProbability = 0.5): readonly object[] {
    const released = new Array<object>();
    for (const ref of this.weakRefs) {
      if (this.releaseRng() < unpinProbability) {
        const target = asObject(ref.deref());
        if (target !== undefined) released.push(target);
        ref.unpin();
        this.weakRefs.delete(ref);
      }
    }
    return released;
  }

  /**
   * Runs a real forced GC, reclaiming every released target the caller stopped
   * referencing. From now on every mock `WeakRef` to such a target derefs to
   * `undefined`. Callers must drop their own references to released targets
   * (via {@link release}) *before* invoking this.
   *
   * Asynchronous because the engine only observes `WeakRef` liveness, runs its
   * forced GC, and dispatches `FinalizationRegistry` callbacks at job
   * boundaries: we yield a macrotask before the GC and several afterwards so
   * every cleanup callback the GC scheduled has been queued before we return.
   */
  async collect(): Promise<void> {
    await macroTask();
    globalThis.gc!();
    for (let i = 0; i < 3; i++) await macroTask();
  }

  /**
   * Draws a number in `[0, 1)` from the seeded finalizer stream.
   *
   * Cleanup delivery in the mock `FinalizationRegistry` draws from this stream
   * so that finalization decisions stay independent of, and reproducible
   * against, the release decisions.
   */
  finalizerDraw(): number {
    return this.finalizerRng();
  }

  /** Delivers a pseudo-random subset of the queued cleanups in every registry. */
  flushSome(): void {
    for (const registry of this.registries) {
      registry.flushSome(() => this.finalizerRng());
    }
  }

  /** Delivers every queued cleanup for a reclaimed target in every registry. */
  flushAll(): void {
    for (const registry of this.registries) {
      registry.flushAll(() => this.finalizerRng());
    }
  }

  /** Number of reclaimed targets whose callbacks are queued but not yet flushed. */
  get pendingCount(): number {
    let count = 0;
    for (const registry of this.registries) count += registry.pendingCount;
    return count;
  }
}

/**
 * Narrows a possibly-non-object `WeakKey` back to `object`. The harness's bound
 * `WeakRef` class only tracks object targets, so this never narrows past a
 * value the harness actually saw.
 */
function asObject(
  value: WeakKey | undefined,
): object | undefined {
  if (typeof value === 'object' && value !== null) return value;
  return undefined;
}

/** Yields to the event loop so the engine advances at least one job boundary. */
function macroTask(): Promise<void> {
  return new Promise((resolve) => void setTimeout(resolve));
}
