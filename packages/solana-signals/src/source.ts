import type { Signal, GapEvent } from './signal.js';

export interface SignalSource {
  readonly name: string;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  on(event: 'signal', listener: (s: Signal) => void): this;
  on(event: 'gap', listener: (g: GapEvent) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}
