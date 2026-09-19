// Store eager reference in case the real implementation gets overwritten with
// the deferred variant below.
const FinalizationRegistry = globalThis.FinalizationRegistry;

/**
 * A stand-in for `FinalizationRegistry` built on top of the real engine class.
 *
 * The double mirrors the real constructor signature, so a bound class can be
 * injected wherever the global `FinalizationRegistry` is used. It delegates to
 * a *real* `FinalizationRegistry`: the engine decides when a target is
 * reclaimed and, at that point, the real registry hands the held value to this
 * class's queue. Delivery from that queue is deferred until the caller drains
 * it explicitly:
 *
 * - `register`/`unregister` are forwarded to the real registry, so the target
 *   is held (and released) exactly as the engine does and nothing here can pin
 *   it.
 * - When the engine reclaims a registered target, the held value is queued but
 *   its cleanup callback is *not* invoked yet.
 * - {@link flushAll} invokes every queued callback, in a caller-seeded
 *   pseudo-random order.
 * - {@link flushSome} invokes a caller-randomized subset of those callbacks,
 *   keeping the rest queued.
 *
 * Because delivery is deferred, order cannot be anchored to registration
 * sequence (the real registry only hands back the held value). Instead each
 * flush assigns the queued callbacks fresh priorities drawn from the caller's
 * draw function, so a seeded caller reproduces the exact same delivery order.
 */
export class DeferredFinalizationRegistry<HeldValue>
    extends FinalizationRegistry<HeldValue> {
  private heldValues: Array<{held: HeldValue, finalized: boolean}> = [];

  constructor(private readonly callback: (heldValue: HeldValue) => void) {
    super((heldValue) => {
      const held = this.heldValues.find(({held}) => heldValue === held);
      if (!held) throw new Error('Could not find registered held value.');
      held.finalized = true;
    });
  }

  override register(target: WeakKey, heldValue: HeldValue, unregisterToken?: WeakKey): void {
    super.register(target, heldValue, unregisterToken);
    // Order at register time, not finalize time.
    this.heldValues.push({held: heldValue, finalized: false});
  }

  /**
   * Invokes every queued cleanup callback, in an order shuffled by `draw`.
   */
  flushAll(draw: () => number): void {
    this.drain(true, draw);
  }

  /**
   * Invokes a `draw`-randomized subset of the queued cleanup callbacks. The
   * subset may be empty; the rest stay queued for a later flush.
   */
  flushSome(draw: () => number): void {
    this.drain(false, draw);
  }

  /** Number of reclaimed targets whose callback is queued but not yet flushed. */
  get pendingCount(): number {
    return this.heldValues.filter(({finalized}) => finalized).length;
  }

  /**
   * Orders the queued callbacks by fresh `draw`-derived priorities, then
   * invokes `all` or a `draw`-randomized subset of them. The delivered
   * callbacks leave the queue; the rest stay queued for a later flush.
   */
  private drain(all: boolean, draw: () => number): void {
    // TODO: Too aggressive?
    const finalizeCount = this.heldValues
        .filter((heldValue) => heldValue.finalized)
        .length;
    console.error({finalizeCount}); // DEBUG
    const limit = finalizeCount === 0 ? 0 : Math.floor(draw() * (finalizeCount + 1));
    const pending = extractFinalized(this.heldValues, all ? finalizeCount : limit);
    const order = randomOrder(pending, draw);
    for (const heldValue of order) this.callback(heldValue);
  }
}

/**
 * Extracts all the finalized held values, maintaining their existing order.
 * Note: Mutates the input {@link heldValues} array!
 */
function extractFinalized<HeldValue>(
  heldValues: Array<{held: HeldValue, finalized: boolean}>,
  limit: number,
): HeldValue[] {
  console.error({limit}); // DEBUG
  const finalized: HeldValue[] = [];
  for (let i = 0; i < limit; ++i) {
    const nextIndex = heldValues.findIndex((heldValue) => heldValue.finalized);
    console.error(heldValues, nextIndex); // DEBUG
    if (nextIndex === -1) throw new Error('Ran out of finalized held values.');
    finalized.push(heldValues[nextIndex]!.held);
    heldValues.splice(nextIndex, 1);
  }

  return finalized;
}

function randomOrder<T>(inputs: T[], draw: () => number): T[] {
  const result: T[] = [];

  const list = Array.from(inputs); // Clone array.
  while (list.length > 0) {
    const index = Math.floor(draw() * list.length);
    result.push(list[index]!);
    list.splice(index, 1);
  }

  return result;
}

/**
 * Returns a {@link DeferredFinalizationRegistry} class bound to invoke the
 * given callback every * time a new instance is constructed. This allows
 * tracking all created objects so they can be centrally flushed as appropriate.
 */
export function bindInstanceTracking(
  callback: (registry: DeferredFinalizationRegistry<any>) => void,
): FinalizationRegistryConstructor {
  return class DeferredFinalizationRegistryBound<HeldValue>
      extends DeferredFinalizationRegistry<HeldValue> {
    constructor(cleanupCallback: (heldValue: HeldValue) => void) {
      super(cleanupCallback);
      callback(this);
    }
  };
}
