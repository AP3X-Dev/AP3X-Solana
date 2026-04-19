/**
 * `ap3x-solana-diag` CLI — thin argv parser dispatching to the probe
 * functions. Outputs JSON on stdout; `--check` maps probe-failure to a
 * non-zero exit code so CI pipelines can wire a green/red signal.
 *
 * Subcommands:
 *
 *   probe-rpc    --url <url> [--name <name>] [--timeout <ms>] [--check]
 *   probe-geyser --url <url> [--token <token>] [--insecure] [--duration <ms>] [--check]
 *   compare-providers
 *                --a-name <name> --a-url <url>
 *                --b-name <name> --b-url <url>
 *                [--timeout <ms>] [--check]
 *
 * `main(argv, io)` is the testable entry point: it returns the intended
 * exit code instead of calling `process.exit` so tests can assert without
 * having to fork subprocesses. The bin wrapper at the bottom of this file
 * bridges to `process.exit` for the real CLI.
 */

import type { RpcEndpoint } from '../rpc-pool';
import type { GeyserEndpoint } from '../geyser-client';

import {
  probeGeyser,
  probeRpc,
  compareProviders,
  type CompareProvidersResult,
  type GeyserProbeResult,
  type RpcProbeResult,
} from './probes';

// ---------------------------------------------------------------------------
// IO interface
// ---------------------------------------------------------------------------

export interface DiagIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const defaultIO: DiagIO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/**
 * Extract `--flag value` and `--boolean` pairs from argv. Returns the flag
 * map plus the list of positional args. Purposely simple — we don't need a
 * full getopt-style parser for six flags.
 */
function parseArgs(argv: string[]): {
  flags: Record<string, string | true>;
  positional: string[];
} {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function asString(val: string | true | undefined): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

function usage(): string {
  return [
    'Usage: ap3x-solana-diag <command> [options]',
    '',
    'Commands:',
    '  probe-rpc         --url <url> [--name <name>] [--timeout <ms>] [--check]',
    '  probe-geyser      --url <url> [--token <tok>] [--insecure] [--duration <ms>] [--check]',
    '  compare-providers --a-name <name> --a-url <url>',
    '                    --b-name <name> --b-url <url>',
    '                    [--timeout <ms>] [--check]',
    '',
    'Outputs a JSON result on stdout. With --check, exits 1 if any probe',
    'failed; otherwise exits 0 regardless.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[], io: DiagIO = defaultIO): Promise<number> {
  if (argv.length === 0) {
    io.stderr(usage());
    return 2;
  }
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const check = flags.check === true;

  try {
    switch (cmd) {
      case 'probe-rpc': {
        const url = asString(flags.url);
        if (!url) {
          io.stderr('probe-rpc requires --url\n');
          return 2;
        }
        const endpoint: RpcEndpoint = {
          name: nameOrDefault(asString(flags.name)),
          url,
          kind: 'http',
        };
        const timeoutMs = numericFlag(flags.timeout);
        const opts = timeoutMs !== undefined ? { timeoutMs } : {};
        const result: RpcProbeResult = await probeRpc(endpoint, opts);
        io.stdout(JSON.stringify(result, null, 2) + '\n');
        return check && !result.ok ? 1 : 0;
      }
      case 'probe-geyser': {
        const url = asString(flags.url);
        if (!url) {
          io.stderr('probe-geyser requires --url\n');
          return 2;
        }
        const endpoint: GeyserEndpoint = { url };
        const token = asString(flags.token);
        if (token) endpoint.token = token;
        if (flags.insecure === true) endpoint.insecure = true;
        const durationMs = numericFlag(flags.duration);
        const opts = durationMs !== undefined ? { durationMs } : {};
        const result: GeyserProbeResult = await probeGeyser(endpoint, opts);
        io.stdout(JSON.stringify(result, null, 2) + '\n');
        return check && !result.ok ? 1 : 0;
      }
      case 'compare-providers': {
        const aName = asString(flags['a-name']);
        const aUrl = asString(flags['a-url']);
        const bName = asString(flags['b-name']);
        const bUrl = asString(flags['b-url']);
        if (!aName || !aUrl || !bName || !bUrl) {
          io.stderr(
            'compare-providers requires --a-name --a-url --b-name --b-url\n',
          );
          return 2;
        }
        const aRpc: RpcEndpoint = {
          name: nameOrDefault(aName),
          url: aUrl,
          kind: 'http',
        };
        const bRpc: RpcEndpoint = {
          name: nameOrDefault(bName),
          url: bUrl,
          kind: 'http',
        };
        const cmpOpts: { rpcTimeoutMs?: number } = {};
        const timeoutMs = numericFlag(flags.timeout);
        if (timeoutMs !== undefined) cmpOpts.rpcTimeoutMs = timeoutMs;
        const result: CompareProvidersResult = await compareProviders(
          { name: aName, rpc: aRpc },
          { name: bName, rpc: bRpc },
          cmpOpts,
        );
        io.stdout(JSON.stringify(result, null, 2) + '\n');
        const anyFail =
          (result.aRpc !== undefined && !result.aRpc.ok) ||
          (result.bRpc !== undefined && !result.bRpc.ok) ||
          (result.aGeyser !== undefined && !result.aGeyser.ok) ||
          (result.bGeyser !== undefined && !result.bGeyser.ok);
        return check && anyFail ? 1 : 0;
      }
      default:
        io.stderr(usage());
        return 2;
    }
  } catch (err) {
    io.stderr(
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }
}

/**
 * RpcEndpoint.name is a narrow union; CLI callers may supply anything.
 * Coerce unknown labels to `'custom'` so the probe still runs — the name
 * is just a dashboard label, nothing routing-critical depends on it.
 */
function nameOrDefault(name: string | undefined): RpcEndpoint['name'] {
  if (name === 'helius' || name === 'triton' || name === 'quicknode') {
    return name;
  }
  return 'custom';
}

function numericFlag(val: string | true | undefined): number | undefined {
  if (typeof val !== 'string') return undefined;
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

// ---------------------------------------------------------------------------
// Bin wrapper — only runs when invoked directly, never when imported.
// ---------------------------------------------------------------------------

// In the compiled CJS build (what the `bin` field ships), this is the only
// invocation path — tsup emits a CJS file with `"use strict"` at top and
// module-level side effects run on require. In dev via `tsx`, the file is
// loaded as ESM but still directly — so unconditionally running `main` here
// is safe: the file is only ever loaded by the CLI dispatcher (bin or
// `pnpm diag`) or by Vitest, which imports `main` as a named export and
// never evaluates the bottom of this file as a test entry because Vitest's
// loader evaluates it under the same process lifecycle.
//
// The guard we DO want: avoid running when Vitest imports the module. Vitest
// sets `process.env.VITEST` when loading test files. Skip there.
if (!process.env.VITEST) {
  // Slice off `node` + script path. Errors propagate as a non-zero exit.
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
