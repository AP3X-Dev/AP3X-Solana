export { signalId } from './signal-id.js';
export type { SignalIdInput } from './signal-id.js';
export type { Signal, GapEvent } from './signal.js';
export type { SignalSource } from './source.js';
export { SignalQueue, type SignalQueueOpts } from './signal-queue.js';
export {
  FileSignalCheckpointStore,
  type SignalCheckpointStore,
  type SignalCheckpoint,
  type FileSignalCheckpointStoreOpts,
} from './checkpoint-store.js';
export { FixtureSignalSource, type FixtureSignalSourceOpts } from './sources/fixture.js';
export { HistoricalSignalSource, type HistoricalSignalSourceOpts } from './sources/historical.js';
export { GeyserSignalSource, type GeyserSignalSourceOpts } from './sources/geyser.js';

// Multi-source bus contract.
export type {
  SignalProducer,
  SignalConsumer,
  SignalBus,
  ProducerHealth,
  Disposable,
  WrapSourceOpts,
} from './producer.js';
export { wrapSource } from './producer.js';
export { MemorySignalBus, VersionMismatchError, type SignalBusOpts } from './bus.js';
