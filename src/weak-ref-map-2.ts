type Token = {__brand: 'token'};

/**
 * Alternative implementation of `WeakRefMap`.
 *
 * This one hides the `WeakRef` from its public API, leading to some interesting
 * trade offs.
 * 1.  The API is noticeably simpler, the user no longer needs to think about
 *     `WeakRef` (except they kinda do as it's a key implementation detail).
 * 2.  User cannot normally observe the difference between "object not in map"
 *     and "object reclaimed by GC". This is either good or bad depending on
 *     your use case and perspective.
 * 3.  The `WeakRefMap` class is no longer a subclass of `Map` as it's really a
 *     `Map<Key, WeakRef<Value>>` masquerading as a `Map<Key, Value>`. This
 *     makes the implementation noticeably larger since we can't rely on
 *     `extends Map` to do most of the work.
 * 4.  `.size` is now O(n) and cannot be O(1) because a `WeakRef` could be
 *     reclaimed at any time.
 * 5.  Requires a strong reference to set a value, but will only retain a
 *     `WeakRef`. If you already have a `WeakRef` as the input, this is
 *     wasteful.
 * 6.  Operations like `.size` and `.entries` call `deref`, meaning they force
 *     retain any objects they discover, which hurts performance.
 */
export class WeakRefMap2<Key, Value extends WeakKey>
    implements Map<Key, Value> {
  private readonly map: Map<Key, WeakRef<Value>> = new Map();
  private readonly registryTokens = new Map<Key, Token>();
  private readonly registry = new FinalizationRegistry((key: Key) => {
    this.map.delete(key);
    this.registryTokens.delete(key);
  });

  constructor(entries?: ReadonlyArray<readonly [Key, Value]> | null) {
    this.map = !entries ? new Map(entries) : new Map((function* () {
      for (const [key, value] of entries) {
        yield [key, new WeakRef(value)] as const;
      }
    })());
  }

  get(key: Key): Value | undefined {
    return this.map.get(key)?.deref();
  }

  set(key: Key, value: Value): this {
    this.map.set(key, new WeakRef(value));
    const token = {} as Token;
    this.registryTokens.set(key, token);
    this.registry.register(value, key, token);
    return this;
  }

  delete(key: Key): boolean {
    const token = this.registryTokens.get(key)!;
    this.registry.unregister(token);
    this.registryTokens.delete(key);
    return this.map.delete(key);
  }

  has(key: Key): boolean {
    return this.get(key) !== undefined;
  }

  get size(): number {
    // Can't use `this.map.size` because it potentially includes GC'd weak refs.
    // Can't cache a local `this.size` number, because it would be inaccurate
    // between the time a `WeakRef` target is reclaimed and when the
    // `FinalizationRegistry` callback is invoked.
    return Array.from(this.values()).length;
  }

  clear(): void {
    this.map.clear();
  }

  *entries(): MapIterator<[Key, Value]> {
    for (const [key, ref] of this.map.entries()) {
      const value = ref.deref();
      if (value) yield [key, value];
    }
  }

  *keys(): MapIterator<Key> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<Value> {
    for (const [_key, value] of this.entries()) yield value;
  }

  forEach(
    cb: (value: Value, key: Key, map: Map<Key, Value>) => void,
    thisArg?: any,
  ): void {
    for (const [key, value] of this.entries()) {
      cb.call(thisArg, value, key, this);
    }
  }

  getOrInsert(key: Key, defaultValue: Value): Value {
    const value = this.get(key);
    if (value) return value;

    this.set(key, defaultValue);
    return defaultValue;
  }

  getOrInsertComputed(key: Key, callback: (key: Key) => Value): Value {
    const value = this.get(key);
    if (value) return value;

    const defaultValue = callback(key);
    this.set(key, defaultValue);
    return defaultValue;
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  [Symbol.toStringTag] = 'WeakRefMap';
}
