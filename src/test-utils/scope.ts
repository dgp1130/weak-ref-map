/**
 * Invokes the given callback and returns its result.
 *
 * `scope` doesn't really *do* anything. It exists to document the purpose of
 * the callback function. In JS, objects may be held in memory for the duration
 * of the function call they exist within. While you can create scopes with `{}`
 * or `if (true) {}`, variables aren't always released until the function
 * completes. Therefore, it is occasionally useful to make IIFEs solely for the
 * purpose of allocating and then releasing an object reference.
 *
 * `scope` invokes it's callback to create this effect and exists as
 * documentation that the function exists solely to scope its data.
 *
 * @example
 * ```typescript
 * scope(() => {
 *   let foo = {};
 *   doSomething(foo);
 *   doSomethingElse(foo);
 *   // `foo` is implicitly released at this time.
 * });
 * ```
 */
export function scope<T>(cb: () => T): T {
  return cb();
}
