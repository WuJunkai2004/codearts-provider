/** Runtime registry of models discovered via the opengw gateway: inference
 * for them goes through snap-access with a `maas_type: benefit` header.
 * Single writer is models.ts (syncOpengwModels on every model refresh, from
 * discovered or cached lists); the only reader is signer.ts's cliChatHeaders,
 * which has nothing but the model ID at request time — hence this side
 * channel instead of threading metadata through the fetch closure. */

const opengwIds = new Set<string>();

/** Rebuild the registry from a discovered/cached model list (null clears). */
export function syncOpengwModels(
  models: readonly { id: string; opengw?: boolean }[] | null,
): void {
  opengwIds.clear();
  for (const m of models ?? []) if (m.opengw) opengwIds.add(m.id);
}

/** Request-time query: does this model need the `maas_type: benefit` header? */
export const isOpengwModel = (id: string): boolean => opengwIds.has(id);
