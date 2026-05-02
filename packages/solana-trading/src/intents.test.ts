import { describe, expect, it } from 'vitest';

import {
  swapIntentIdempotencyKey,
  type BuyIntent,
  type SellIntent,
  type TradeExecutor,
} from './intents.js';

describe('swap intents', () => {
  it('derives idempotency keys from strategy, mint, side, and trigger', () => {
    const key = swapIntentIdempotencyKey({
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT:WITH:SEPARATORS',
      side: 'buy',
      triggerKey: 'elite upgrade/123',
    });

    expect(key).toBe('swap-intent:T60_ELITE_TRAIL:MINT%3AWITH%3ASEPARATORS:buy:elite%20upgrade%2F123');
  });

  it('models buy and sell policy without transaction instructions', () => {
    const buy: BuyIntent = {
      kind: 'swap-intent',
      intentKind: 'buy',
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT_X',
      side: 'buy',
      triggerKey: 'entry',
      mode: 'paper',
      targetNotionalUsd: 100,
      quoteMint: 'USDC',
      slippageBps: 500,
      preflight: { quoteRequired: true, simulationRequired: true },
    };
    const sell: SellIntent = {
      kind: 'swap-intent',
      intentKind: 'sell',
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT_X',
      side: 'sell',
      triggerKey: 'trail-stop',
      mode: 'paper',
      sellPctBps: 10_000,
      preflight: { quoteRequired: true, simulationRequired: true },
    };

    expect(buy.targetNotionalUsd).toBe(100);
    expect(sell.sellPctBps).toBe(10_000);
  });

  it('keeps strategy policy separate from executor implementation', async () => {
    const intent: BuyIntent = {
      kind: 'swap-intent',
      intentKind: 'buy',
      strategyId: 'T60_ELITE_TRAIL',
      tokenMint: 'MINT_X',
      side: 'buy',
      triggerKey: 'entry',
      mode: 'paper',
      targetNotionalUsd: 100,
      quoteMint: 'USDC',
      slippageBps: 500,
      preflight: { quoteRequired: true, simulationRequired: true },
    };
    const executor: TradeExecutor = {
      mode: 'paper',
      name: 'test-paper',
      async quote(i) {
        return {
          provider: 'test',
          inputMint: i.quoteMint ?? 'USDC',
          outputMint: i.tokenMint,
          inAmountAtomic: '100000000',
          expectedOutAmountAtomic: '250000000000',
          minOutAmountAtomic: '240000000000',
          priceImpactPct: 0.5,
          slippageBps: i.slippageBps ?? 500,
          routeLabel: 'fixture',
          capturedAt: '2026-04-30T12:00:00.000Z',
        };
      },
      async simulate() {
        return { ok: true, simulatedAt: '2026-04-30T12:00:01.000Z' };
      },
      async submit(i, quote, simulation) {
        return {
          kind: 'filled',
          order: {
            idempotencyKey: swapIntentIdempotencyKey(i),
            mode: 'paper',
            executor: 'test-paper',
            intent: i,
            quote,
            simulation,
            createdAt: '2026-04-30T12:00:02.000Z',
          },
          fill: {
            idempotencyKey: 'fill:fixture',
            mode: 'paper',
            side: i.side,
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inputAmountAtomic: quote.inAmountAtomic,
            outputAmountAtomic: quote.expectedOutAmountAtomic,
            filledAt: '2026-04-30T12:00:03.000Z',
          },
        };
      },
    };

    const quote = await executor.quote(intent);
    const simulation = await executor.simulate(intent, quote);
    const result = await executor.submit(intent, quote, simulation);

    expect(result.kind).toBe('filled');
    if (result.kind === 'filled') {
      expect(result.order.intent.strategyId).toBe('T60_ELITE_TRAIL');
      expect(result.fill.outputMint).toBe('MINT_X');
    }
  });
});
