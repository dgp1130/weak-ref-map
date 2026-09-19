import fc from 'fast-check';
import {SeededGCHarness} from './gc-harness.js';

/**
 * A `WeakRef`-backed data structure which this harness can manipulate.
 *
 * The `get`/`has` contract is that of an opaque cache: `has(key)` is `true` if
 * and only if `get(key)` would return a live value. Implementations which
 * surface unreclaimed `WeakRef` entries (such as `WeakRefMap` backed by `Map`'s
 * `has`) must adapt their `has` to match.
 *
 * `size` counts every entry the collection still holds internally, including
 * stale entries whose targets were reclaimed but whose cleanup has not yet run.
 * After a full {@link GcCommands} sweep it must be `0`.
 *
 * Every value passed to {@link set} is expected to be routed through the
 * harness's mock `WeakRef` class, which pins it automatically: the moment a
 * value enters a `WeakRef` it is held strongly, so {@link get}/{@link has}
 * must keep serving it until a GC step releases it.
 */
export interface TestedCollection<T extends object> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  readonly size: number;
}

/**
 * Expected state of a {@link TestedCollection}, driven by the harness.
 *
 * - `pinned` keys have targets the harness holds strongly. The collection must
 *   always serve the exact same object for these keys.
 * - `unpinned` keys have targets the harness released. After the harness has
 *   collected them, the collection must no longer serve them.
 */
export interface GcModel<T extends object> {
  readonly pinned: Map<string, T>;
  readonly unpinned: Set<string>;
}

/** An initially-empty {@link GcModel}. */
export function emptyGcModel<T extends object>(): GcModel<T> {
  return {pinned: new Map(), unpinned: new Set()};
}

/**
 * Commands for driving a {@link TestedCollection} through arbitrary
 * interleavings of insertions and both kinds of GC steps.
 */
export interface GcCommands<T extends object> {
  readonly insert:
      fc.Arbitrary<fc.AsyncCommand<GcModel<T>, TestedCollection<T>>>;
  readonly gcSomeObjects:
      fc.Arbitrary<fc.AsyncCommand<GcModel<T>, TestedCollection<T>>>;
  readonly gcAllObjects:
      fc.Arbitrary<fc.AsyncCommand<GcModel<T>, TestedCollection<T>>>;
}

/**
 * Options controlling {@link createGcCommands}.
 */
export interface GcCommandOptions {
  /**
   * Probability that any given held target is released by a partial GC step,
   * in `[0, 1]`. Defaults to `0.5`.
   */
  unpinProbability?: number;
}

/**
 * Builds the arbitrary command generators for fuzzing a
 * {@link TestedCollection}.
 *
 * @param harness - Shared harness. The released subsets of its held targets
 *     are mirrored into the command's model on every GC step, and its mock
 *     `FinalizationRegistry`/`WeakRef` classes drive cleanup delivery. Must be
 *     reset before each property run.
 * @param factory - Creates a fresh target value for each insertion.
 */
export function createGcCommands<T extends object>(
  harness: SeededGCHarness,
  factory: () => T,
  options: GcCommandOptions = {},
): GcCommands<T> {
  const unpinProbability = options.unpinProbability ?? 0.5;

  const insert = fc.string({minLength: 1, maxLength: 5}).map((key) => ({
    check: () => true,
    toString: () => `insert('${key}')`,
    run: (model: GcModel<T>, real: TestedCollection<T>): Promise<void> => {
      const target = factory();

      // Pinning is automatic: `collection.set` routes the value through the
      // harness's mock `WeakRef` class, which pins the target the moment it
      // enters a `WeakRef`. No explicit pin call is needed.
      real.set(key, target);

      model.unpinned.delete(key);
      model.pinned.set(key, target);

      assertInvariants(model, real);
      return Promise.resolve();
    },
  }));

  /**
   * Simulates the engine running GC at an arbitrary, partial point: some held
   * targets are released, the engine reclaims them, and some (maybe none or
   * all) of the queued cleanups are delivered. The collection must stay
   * consistent regardless of how much was reclaimed or cleaned up.
   */
  const gcSomeObjects = fc.constant({
    check: () => true,
    toString: () => 'gcSomeObjects',
    run: async (model: GcModel<T>, real: TestedCollection<T>): Promise<void> => {
      // Release the harness's pins, dropping the model's references to the
      // released targets *before* running the GC so nothing holds them. The
      // released array is passed inline so no live frame keeps it (and thus its
      // targets) alive across the GC step's job boundaries.
      releaseModel(model, harness.release(unpinProbability));

      // Reclaim everything released, then deliver a pseudo-random subset of
      // the queued cleanups; the rest stay queued for a later GC step.
      await harness.collect();
      harness.flushSome();

      assertInvariants(model, real);
    },
  });

  /**
   * Simulates the engine fully settling: every held target is released, the
   * engine reclaims everything eligible, and every queued cleanup is delivered.
   * After this, the collection must be completely empty — any retained entry or
   * pending callback is a leak.
   */
  const gcAllObjects = fc.constant({
    check: () => true,
    toString: () => 'gcAllObjects',
    run: async (model: GcModel<T>, real: TestedCollection<T>): Promise<void> => {
      releaseModel(model, harness.release(1));

      // Reclaim everything, then deliver every queued cleanup. The simulation
      // is deterministic: after a forced GC a released, unreferenced target is
      // always reclaimed, so one collect + flush always settles.
      await harness.collect();
      harness.flushAll();

      if (harness.pendingCount !== 0) {
        throw new Error(
            `Leak detected: ${harness.pendingCount} cleanup callback(s)` +
                ` still pending after gcAllObjects.`);
      }
      if (real.size !== 0) {
        throw new Error(
            `Leak detected: collection retained ${real.size} entr(ies)` +
                ` after gcAllObjects.`);
      }

      assertInvariants(model, real);
    },
  });

  return {insert, gcSomeObjects, gcAllObjects};
}

/**
 * Mirrors the harness's release decisions into the model by dropping the model
 * references to the released targets.
 *
 * Released targets which are not (or no longer) the model's current value for
 * their key — for example a target superseded by a re-insertion of the same
 * key — are skipped silently; they are simply not in `pinned`.
 */
function releaseModel<T extends object>(
  model: GcModel<T>,
  released: readonly object[],
): void {
  for (const target of released) {
    const key = keyFor(model.pinned, target);
    if (key === undefined) continue;
    model.pinned.delete(key);
    model.unpinned.add(key);
  }
}

function keyFor<T extends object>(
  pinned: ReadonlyMap<string, T>,
  target: object,
): string | undefined {
  for (const [key, value] of pinned) {
    if (value === target) return key;
  }
  return undefined;
}

function assertInvariants<T extends object>(
  model: GcModel<T>,
  real: TestedCollection<T>,
): void {
  for (const [key, target] of model.pinned) {
    const value = real.get(key);
    if (value !== target) {
      throw new Error(
          `Invariant Violation: key '${key}' is pinned but the collection ` +
              `returned ${value === undefined ? 'undefined' : 'a different object'}.`);
    }
    if (!real.has(key)) {
      throw new Error(
          `Invariant Violation: key '${key}' is pinned but has() is false.`);
    }
  }

  for (const key of model.unpinned) {
    if (real.get(key) !== undefined) {
      throw new Error(
          `Invariant Violation: key '${key}' was released but still returns a value.`);
    }
    if (real.has(key)) {
      throw new Error(
          `Invariant Violation: key '${key}' was released but has() is true.`);
    }
  }
}

/** Options for {@link runGcCommandSuite}. */
export interface GcCommandSuiteOptions<T extends object> {
  /** Creates a fresh target value for each insertion. */
  factory: () => T;
  /**
   * Seed for both fast-check and the harness's decision streams. Defaults to a
   * fresh uniform random seed. Logged to stdout so failures can be replayed
   * with the exact same seed.
   */
  seed?: number;
  /** Number of property runs. Defaults to `100`. */
  numRuns?: number;
  /** Maximum number of commands generated per run. Defaults to `50`. */
  maxCommands?: number;
  /** Probability a held target is released by each partial GC step. Defaults to `0.5`. */
  unpinProbability?: number;
}

/**
 * Runs a deterministic, seed-based property over the given collection.
 *
 * The command stream, the harness's release decisions, and the cleanup delivery
 * decisions are all derived from the same seed, so re-running a failed suite
 * with the reported seed reproduces the invariant failure exactly.
 *
 * @param makeCollection - Builds a fresh collection for each run from the
 *     harness's mock `WeakRef`/`FinalizationRegistry` classes.
 */
export async function runGcCommandSuite<T extends object>(
  makeCollection: (harness: SeededGCHarness) => TestedCollection<T>,
  options: GcCommandSuiteOptions<T>,
): Promise<void> {
  const {factory, numRuns = 100, maxCommands = 50, unpinProbability = 0.5} = options;
  const seed = options.seed ?? envSeed() ?? randomSeed();

  const harness = new SeededGCHarness(seed);
  const {insert, gcSomeObjects, gcAllObjects} =
      createGcCommands(harness, factory, {unpinProbability});

  const property = fc.asyncProperty(
    fc.commands<GcModel<T>, TestedCollection<T>, false>(
      [insert, gcSomeObjects, gcAllObjects],
      {maxCommands},
    ),
    async (commands) => {
      // Replay the same seed for the harness so each run reproduces the same
      // sequence of release and finalization decisions.
      harness.reset();
      const model = emptyGcModel<T>();
      const real = makeCollection(harness);

      await fc.asyncModelRun(() => ({model, real}), commands);
    },
  );

  console.log(`GC command suite: seed=${seed} numRuns=${numRuns}`);
  await fc.assert(property, {seed, numRuns});
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x80000000);
}

const gcTestSeedEnv = 'GC_TEST_SEED';

/**
 * Reads the GC test seed from the `GC_TEST_SEED` environment variable, e.g.
 * `GC_TEST_SEED=1234 pnpm test`.
 *
 * Returns `undefined` when the variable is unset.
 */
export function envSeed(): number | undefined {
  const raw = process.env[gcTestSeedEnv];
  if (raw === undefined) return undefined;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) {
    throw new Error(`Invalid ${gcTestSeedEnv} value '${raw}'.`);
  }
  return seed;
}