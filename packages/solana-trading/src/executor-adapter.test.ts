import { describe, expect, it } from 'vitest';

import type { BuyIntent } from './intents.js';
import { swapIntentIdempotencyKey } from './intents.js';
import { toExecutorTradeIntent } from './executor-adapter.js';

describe('executor adapter', () => {
  it('adapts high-level swap intents to instruction-level executor intents', () => {
    const intent: BuyIntent = {
      kind: 'swap-intent',
      intentKind: 'buy',
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT_X',
      side: 'buy',
      triggerKey: 'entry',
      mode: 'live',
      targetNotionalUsd: 100,
      preflight: { quoteRequired: true, simulationRequired: true },
    };
    const executorIntent = toExecutorTradeIntent({
      intent,
      wallet: 'hot-wallet',
      instructions: [],
      feeTier: 'high',
      deadline: 1_000,
      retry: { maxAttempts: 2, bumpProgression: true },
    });

    expect(executorIntent.intentId).toBe(swapIntentIdempotencyKey(intent));
    expect(executorIntent.wallet).toBe('hot-wallet');
    expect(executorIntent.instructions).toHaveLength(0);
    expect(executorIntent.feeTier).toBe('high');
    expect(executorIntent.deadline).toBe(1_000);
    expect(executorIntent.retry?.maxAttempts).toBe(2);
  });

  it('allows an explicit executor intent id override', () => {
    const intent: BuyIntent = {
      kind: 'swap-intent',
      intentKind: 'buy',
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT_X',
      side: 'buy',
      triggerKey: 'entry',
      mode: 'live',
      targetNotionalUsd: 100,
      preflight: { quoteRequired: true, simulationRequired: true },
    };
    const executorIntent = toExecutorTradeIntent({
      intent,
      intentId: 'custom-executor-id',
      wallet: 'hot-wallet',
      instructions: [],
      feeTier: 'med',
      deadline: 1_000,
    });

    expect(executorIntent.intentId).toBe('custom-executor-id');
  });
});
