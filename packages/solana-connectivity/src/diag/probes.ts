/**
 * Diagnostic probes for RPC + Geyser endpoints.
 *
 * Per spec Section 3.2 / plan Task 17 these probes power `pnpm diag` and
 * the `ap3x-solana-diag` CLI. They're intended for ops / CI smoke-tests,
 * not for production hot paths — construct a fresh pool/client per probe,
 * measure, return a structured result, and tear down.
 *
 * Three probes:
 *
 *   - `probeRpc(endpoint, opts?)` — issues `getSlot` against a single
 *     endpoint via an internally-constructed `RpcPool` and returns
 *     `{ ok, endpoint, latencyMs, slot?, errorClass?, error? }`. Using the
 *     real pool means the probe exercises the same error classification,
 *     breaker wiring, and response parsing as production traffic — a
 *     probe that bypassed the pool would green-light a misconfigured pool.
 *
 *   - `probeGeyser(endpoint, opts?)` — opens a Yellowstone subscription
 *     for `durationMs` (default 5000) and counts slot updates. Returns
 *     `{ ok, endpoint, slotsObserved, latencyP50?, errorClass?, error? }`.
 *     `ok` is `slotsObserved > 0` — no observed slots within the window
 *     is operationally indistinguishable from a dead endpoint for
 *     substrate purposes.
 *
 *   - `compareProviders(a, b, opts?)` — runs RPC and optionally Geyser
 *     probes on both providers in parallel and reports the drift. Two
 *     RPC nodes on the same network should land within ~1-2 slots of
 *     each other at finalized commitment; a `slotDelta` above that
 *     threshold is a useful signal for an operator to investigate.
 *
 * Design choices, called out:
 *
 *   - The `GrpcAdapter` is accepted on the options — NOT on the
 *     `GeyserEndpoint` — so the probe surface stays clean for production
 *     callers (`probeGeyser({ url })`) while keeping deterministic testing
 *     cheap (`probeGeyser({ url }, { grpc: fakeAdapter })`).
 *
 *   - `latencyP50` is computed as a simple middle-index median over the
 *     intervals between subscribe start and each update. With N ≥ 1 slot
 *     updates the index is `Math.floor(N/2)`. For N = 0 we report
 *     `undefined`. This is deliberately simple — real percentile analysis
 *     happens in metrics pipelines, not in a smoke-test.
 */

import { RpcError } from '@ap3x/solana-core';

import {
  GeyserClient,
  type GeyserEndpoint,
  type GrpcAdapter,
} from '../geyser-client';
import { RpcPool, type RpcEndpoint } from '../rpc-pool';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RpcProbeResult {
  ok: boolean;
  endpoint: string;
  latencyMs: number;
  slot?: number;
  errorClass?: string;
  error?: string;
}

export interface GeyserProbeResult {
  ok: boolean;
  endpoint: string;
  slotsObserved: number;
  latencyP50?: number;
  errorClass?: string;
  error?: string;
}

export interface RpcProbeOptions {
  timeoutMs?: number;
}

export interface GeyserProbeOptions {
  /** How long to sample the subscription for. Defaults to 5000ms. */
  durationMs?: number;
  /** Optional injected gRPC adapter (tests). Production callers omit this. */
  grpc?: GrpcAdapter;
}

export interface CompareProvider {
  name: string;
  rpc?: RpcEndpoint;
  geyser?: GeyserEndpoint & { grpc?: GrpcAdapter };
}

export interface CompareProvidersResult {
  aRpc?: RpcProbeResult;
  bRpc?: RpcProbeResult;
  aGeyser?: GeyserProbeResult;
  bGeyser?: GeyserProbeResult;
  /** |aRpc.slot − bRpc.slot| when both succeed, else undefined. */
  slotDelta?: number;
  /** aRpc.latencyMs − bRpc.latencyMs when both succeed, else undefined. */
  latencyDelta?: number;
}

export interface CompareProvidersOptions {
  rpcTimeoutMs?: number;
  geyserDurationMs?: number;
}

const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_GEYSER_DURATION_MS = 5000;

// ---------------------------------------------------------------------------
// probeRpc
// ---------------------------------------------------------------------------

export async function probeRpc(
  endpoint: RpcEndpoint,
  opts: RpcProbeOptions = {},
): Promise<RpcProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  // One endpoint, one attempt. We don't want the probe to mask a degraded
  // endpoint by retrying across a pool of peers — the whole point is to
  // surface problems for THIS endpoint.
  const pool = new RpcPool({
    endpoints: [endpoint],
    timeoutMs,
    retry: { attempts: 1, backoffMs: 0, jitter: 0 },
  });
  const start = Date.now();
  try {
    const slot = (await pool.call('getSlot', [])) as number;
    return {
      ok: true,
      endpoint: endpoint.name,
      latencyMs: Date.now() - start,
      slot,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      endpoint: endpoint.name,
      latencyMs,
      errorClass: classifyError(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function classifyError(err: unknown): string {
  if (err instanceof RpcError) {
    // `rpc.timeout` → `'timeout'`, etc. Matches the taxonomy emitted by
    // `HttpClient` / `RpcPool` so dashboards that bucket on those classes
    // keep working for diag output too.
    return err.code.slice('rpc.'.length);
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// probeGeyser
// ---------------------------------------------------------------------------

export async function probeGeyser(
  endpoint: GeyserEndpoint,
  opts: GeyserProbeOptions = {},
): Promise<GeyserProbeResult> {
  const durationMs = opts.durationMs ?? DEFAULT_GEYSER_DURATION_MS;
  const clientOpts: {
    endpoint: GeyserEndpoint;
    grpc?: GrpcAdapter;
  } = { endpoint };
  if (opts.grpc) clientOpts.grpc = opts.grpc;
  const client = new GeyserClient(clientOpts);

  const latencies: number[] = [];
  let slotsObserved = 0;
  let errorClass: string | undefined;
  let errorMessage: string | undefined;

  const start = Date.now();
  const sub = client.subscribe({ slots: { primary: { filterByCommitment: false } } }, (update) => {
    if (update.slot?.slot !== undefined) {
      slotsObserved += 1;
      latencies.push(Date.now() - start);
    }
  });

  // Error listener: first error classifies the outcome. We don't stop the
  // stream here — the timer below does. Stream errors can be transient
  // (a single bad frame); only the final slot count decides `ok`.
  sub.on('error', (err: Error) => {
    if (!errorClass) {
      errorClass = 'network';
      errorMessage = err.message;
    }
  });

  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  sub.close();

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : undefined;

  const result: GeyserProbeResult = {
    ok: slotsObserved > 0,
    endpoint: endpoint.url,
    slotsObserved,
  };
  if (p50 !== undefined) result.latencyP50 = p50;
  if (errorClass) result.errorClass = errorClass;
  if (errorMessage) result.error = errorMessage;
  return result;
}

// ---------------------------------------------------------------------------
// compareProviders
// ---------------------------------------------------------------------------

export async function compareProviders(
  a: CompareProvider,
  b: CompareProvider,
  opts: CompareProvidersOptions = {},
): Promise<CompareProvidersResult> {
  const rpcOpts: RpcProbeOptions = {};
  if (opts.rpcTimeoutMs !== undefined) rpcOpts.timeoutMs = opts.rpcTimeoutMs;
  const geyserOpts = (grpc: GrpcAdapter | undefined): GeyserProbeOptions => {
    const o: GeyserProbeOptions = {};
    if (opts.geyserDurationMs !== undefined) o.durationMs = opts.geyserDurationMs;
    if (grpc) o.grpc = grpc;
    return o;
  };

  // Fire all probes in parallel. Each branch resolves to `undefined` when
  // the provider didn't supply the corresponding endpoint, which keeps the
  // result shape symmetric and lets the CLI render "not configured" cleanly.
  const [aRpc, bRpc, aGeyser, bGeyser] = await Promise.all([
    a.rpc ? probeRpc(a.rpc, rpcOpts) : Promise.resolve(undefined),
    b.rpc ? probeRpc(b.rpc, rpcOpts) : Promise.resolve(undefined),
    a.geyser
      ? probeGeyser(stripAdapter(a.geyser), geyserOpts(a.geyser.grpc))
      : Promise.resolve(undefined),
    b.geyser
      ? probeGeyser(stripAdapter(b.geyser), geyserOpts(b.geyser.grpc))
      : Promise.resolve(undefined),
  ]);

  const result: CompareProvidersResult = {};
  if (aRpc) result.aRpc = aRpc;
  if (bRpc) result.bRpc = bRpc;
  if (aGeyser) result.aGeyser = aGeyser;
  if (bGeyser) result.bGeyser = bGeyser;

  if (
    aRpc &&
    bRpc &&
    aRpc.slot !== undefined &&
    bRpc.slot !== undefined
  ) {
    result.slotDelta = Math.abs(aRpc.slot - bRpc.slot);
    result.latencyDelta = aRpc.latencyMs - bRpc.latencyMs;
  }
  return result;
}

/**
 * Drop the optional `grpc` shim so the value we hand to `probeGeyser`
 * matches the GeyserEndpoint surface the GeyserClient expects.
 */
function stripAdapter(
  ep: GeyserEndpoint & { grpc?: GrpcAdapter },
): GeyserEndpoint {
  const { grpc: _grpc, ...rest } = ep;
  void _grpc;
  return rest;
}
