/**
 * Audit log helpers — thin functional wrappers over `VaultStorage` that
 * centralize timestamp generation and entry shape.
 *
 * Before T12, every audit write in `vault.ts` inlined the `{ timestamp, event,
 * metadata }` object literal. That worked, but it meant four separate places
 * to update when the `AuditEntry` shape evolves (e.g. to add `agent`, `slot`,
 * or signing-source metadata in a future PRP). Routing all writes through
 * `logAudit` gives us one seam to extend.
 *
 * The functions intentionally stay tiny. The heavy lifting — JSONL
 * serialization, concurrent-write serialization, blank-line tolerance —
 * lives in `FileVaultStorage` (T11). This module is just policy + shape.
 */

import type { AuditEntry, VaultStorage } from './types';

/**
 * Append one audit entry to the log for `name`, with an ISO-8601 UTC timestamp
 * generated at call time.
 *
 * @param storage    the Vault's underlying storage backend
 * @param name       wallet identifier (must match the stored record's name)
 * @param event      one of `'unlock' | 'sign' | 'rotate' | 'create'`
 * @param metadata   optional JSON-serializable context (role, kind, etc.)
 */
export async function logAudit(
  storage: VaultStorage,
  name: string,
  event: AuditEntry['event'],
  metadata?: Record<string, unknown>,
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...(metadata === undefined ? {} : { metadata }),
  };
  await storage.appendAudit(name, entry);
}

/**
 * Read back the full audit log for a wallet. Delegates to the storage
 * backend, which returns entries in write order and yields an empty array
 * if the log file does not exist.
 */
export async function readAudit(
  storage: VaultStorage,
  name: string,
): Promise<AuditEntry[]> {
  return storage.readAudit(name);
}
