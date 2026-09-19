type Token = {__brand: 'token'};

/**
 * A map of {@link WeakRef} values (effectively a `Map<Key, WeakRef<Value>>`)
 * which automatically cleans up its own memory when its targets are reclaimed
 * by the garbage collector.
 *
 * When to use over a {@link WeakMap}? If you *can* use a {@link WeakMap}, you
 * probably should. The main difference is that {@link WeakMap} requires its
 * keys to be {@link WeakMapKey} objects, while {@link WeakRefMap} allows any
 * key. This is useful if you want a serializable key type (such as a string)
 * while avoiding strong references on the values.
 *
 * @example
 * const map = new WeakRefMap<string, Foo>();
 * map.set('foo', new WeakRef(new Foo()));
 * await someTimeLater();
 * const foo = map.get('foo')?.deref();
 * console.log(foo); // May be `undefined` if `foo` was garbage collected.
 * // No need to ever call `map.delete('foo')` because the map will
 * // automatically clean itself up eventually.
 */
export class WeakRefMap<Key, Value extends WeakKey>
    extends Map<Key, WeakRef<Value>> {
  private readonly registryTokens = new Map<Key, Token>();
  private readonly registry = new FinalizationRegistry((key: Key) => {
    // Drop the key from internal data, as they refer to a `WeakRef` which has
    // been reclaimed and will never be accessible again.
    super.delete(key);
    this.registryTokens.delete(key);
  });

  override set(key: Key, ref: WeakRef<Value>): this {
    // Unregister any previous value for this key so the `FinalizationRegistry`
    // isn't called when the previous value is reclaimed.
    this.delete(key);

    // If the value is already reclaimed, don't add it to the map.
    const value = ref.deref();
    if (!value) return this;

    // Register the key to be removed when the value falls out of scope.
    const token = {} as Token;
    this.registryTokens.set(key, token);
    if (!value) this.registry.register(value, key, token);

    // Store the weak reference itself.
    super.set(key, ref);

    return this;
  }

  override delete(key: Key): boolean {
    const token = this.registryTokens.get(key);
    if (!token) return false; // Short-circuit missing key.

    // Unregister so the `FinalizationRegistry` isn't called since we will no
    // longer have any memory to clean up.
    this.registry.unregister(token);
    this.registryTokens.delete(key);

    // Drop the weak reference itself.
    return super.delete(key);
  }
}
