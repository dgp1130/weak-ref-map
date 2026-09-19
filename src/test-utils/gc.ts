/** Trigger full garbage collection. */
export async function gc(): Promise<void> {
  // Wait one macro task so anything current in the "keep alive" set is dropped.
  await macroTask();

  // Force GC to run, requires `--expose-gc`.
  globalThis.gc!();

  // Wait one more macro task so `FinalizationRegistry` callbacks can run.
  await macroTask();
}

function macroTask(): Promise<void> {
  return new Promise((resolve) => void setTimeout(resolve));
}
