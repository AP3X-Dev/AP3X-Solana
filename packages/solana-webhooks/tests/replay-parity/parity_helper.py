"""Replay-parity helper.

Bridges the Python `gmgn_tracker.helius.parser.parse_buy` reference parser to the
TypeScript test runner. Reads a Helius enhanced-tx fixture from a path, runs
parse_buy against the supplied wallet, and prints either a JSON projection of
the resulting Buy or the literal string "null" on stdout.

Usage:
    python parity_helper.py <fixture-path> <wallet>

Exit codes:
    0  normal (output on stdout — JSON object or "null")
    2  argv error
    3  import error (caller should treat as "reference parser unavailable")
"""
from __future__ import annotations

import json
import sys


def _emit_buy(buy) -> str:
    return json.dumps({
        "signature": buy.signature,
        "wallet_address": buy.wallet_address,
        "token_mint": buy.token_mint,
        "sol_amount": buy.sol_amount,
        "token_amount": buy.token_amount,
        "block_time_unix": int(buy.block_time.timestamp()),
    })


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: parity_helper.py <fixture-path> <wallet>", file=sys.stderr)
        return 2

    fixture_path, wallet = sys.argv[1], sys.argv[2]

    try:
        from gmgn_tracker.helius.parser import parse_buy
    except ImportError as e:
        print(f"reference parser unavailable: {e}", file=sys.stderr)
        return 3

    with open(fixture_path, "r", encoding="utf-8") as f:
        tx = json.load(f)

    buy = parse_buy(tx, wallet=wallet)
    print("null" if buy is None else _emit_buy(buy))
    return 0


if __name__ == "__main__":
    sys.exit(main())
