export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Faz polling de `predicate` até retornar um valor verdadeiro (retornado) ou o timeout expirar (lança erro com `label`). */
export async function waitFor<T>(
  predicate: () => Promise<T | false | undefined | null> | T | false | undefined | null,
  timeoutMs = 20_000,
  label = 'condition',
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`);
    }
    await sleep(intervalMs);
  }
}
