export type ExecutionMode = 'paper' | 'live';
export type TradeSide = 'buy' | 'sell';
export type AtomicAmount = string;

export interface SwapIntentIdempotencyInput {
  readonly strategyId: string;
  readonly tokenMint: string;
  readonly side: TradeSide;
  readonly triggerKey: string;
}

export interface SwapPreflightPolicy {
  readonly quoteRequired: boolean;
  readonly simulationRequired: boolean;
}

export interface SwapIntentBase extends SwapIntentIdempotencyInput {
  readonly kind: 'swap-intent';
  readonly intentKind: TradeSide;
  readonly strategyVersion?: string;
  readonly mode: ExecutionMode;
  readonly source?: 'strategy' | 'position-manager' | 'manual';
  readonly sourceAlertId?: number;
  readonly quoteMint?: string;
  readonly slippageBps?: number;
  readonly timeInForceSeconds?: number;
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly preflight: SwapPreflightPolicy;
}

export interface BuyIntent extends SwapIntentBase {
  readonly intentKind: 'buy';
  readonly side: 'buy';
  readonly targetNotionalUsd: number;
}

export type SellIntent = SwapIntentBase & {
  readonly intentKind: 'sell';
  readonly side: 'sell';
} & (
  | {
      readonly quantityAtomic: AtomicAmount;
      readonly sellPctBps?: never;
    }
  | {
      /** 10_000 = 100% of the open position. */
      readonly sellPctBps: number;
      readonly quantityAtomic?: never;
    }
);

export type SwapIntent = BuyIntent | SellIntent;

export interface SwapQuote {
  readonly provider: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmountAtomic: AtomicAmount;
  readonly expectedOutAmountAtomic: AtomicAmount;
  readonly minOutAmountAtomic: AtomicAmount;
  readonly priceImpactPct: number | null;
  readonly slippageBps: number;
  readonly routeLabel: string | null;
  readonly capturedAt: string;
  readonly raw?: unknown;
}

export interface SwapSimulation {
  readonly ok: boolean;
  readonly simulatedAt: string;
  readonly computeUnits?: number;
  readonly error?: string;
  readonly logs?: readonly string[];
}

export interface TradeOrder {
  readonly idempotencyKey: string;
  readonly mode: ExecutionMode;
  readonly executor: string;
  readonly intent: SwapIntent;
  readonly quote: SwapQuote;
  readonly simulation: SwapSimulation | null;
  readonly createdAt: string;
}

export interface TradeFill {
  readonly idempotencyKey: string;
  readonly mode: ExecutionMode;
  readonly side: TradeSide;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAmountAtomic: AtomicAmount;
  readonly outputAmountAtomic: AtomicAmount;
  readonly filledAt: string;
  readonly transactionSignature?: string;
  readonly fillPriceUsd?: number;
  readonly spotPriceUsd?: number;
  readonly realizedSlippagePct?: number;
  readonly feeUsd?: number;
  readonly raw?: unknown;
}

export type TradeSubmitResult =
  | { readonly kind: 'filled'; readonly order: TradeOrder; readonly fill: TradeFill }
  | { readonly kind: 'submitted'; readonly order: TradeOrder; readonly signature?: string }
  | { readonly kind: 'rejected'; readonly order?: TradeOrder; readonly code: string; readonly message: string }
  | { readonly kind: 'failed'; readonly order?: TradeOrder; readonly code: string; readonly message: string };

export interface TradeExecutor {
  readonly mode: ExecutionMode;
  readonly name: string;
  quote(intent: SwapIntent): Promise<SwapQuote>;
  simulate(intent: SwapIntent, quote: SwapQuote): Promise<SwapSimulation>;
  submit(intent: SwapIntent, quote: SwapQuote, simulation: SwapSimulation | null): Promise<TradeSubmitResult>;
}

export function swapIntentIdempotencyKey(input: SwapIntentIdempotencyInput): string {
  return [
    'swap-intent',
    encodeSegment(input.strategyId),
    encodeSegment(input.tokenMint),
    input.side,
    encodeSegment(input.triggerKey),
  ].join(':');
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}
