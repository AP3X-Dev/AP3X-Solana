export interface BundleEntry { signedTx: Uint8Array; }
export type FlushFn = (entries: BundleEntry[]) => Promise<string[]>; // resolves per entry

export interface BundleAccumulatorOpts {
  windowMs: number;
  maxPerBundle: number;
  onFlush: FlushFn;
}

interface PendingEntry {
  entry: BundleEntry;
  resolve: (sig: string) => void;
  reject: (err: Error) => void;
}

interface Accumulator { entries: PendingEntry[]; timer: NodeJS.Timeout | null; }

export class BundleAccumulator {
  private readonly groups = new Map<string, Accumulator>();
  private readonly opts: BundleAccumulatorOpts;

  constructor(opts: BundleAccumulatorOpts) { this.opts = opts; }

  async add(group: string, entry: BundleEntry): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let acc = this.groups.get(group);
      if (!acc) { acc = { entries: [], timer: null }; this.groups.set(group, acc); }
      acc.entries.push({ entry, resolve, reject });
      if (acc.entries.length >= this.opts.maxPerBundle) {
        if (acc.timer) clearTimeout(acc.timer);
        void this.flush(group);
      } else if (!acc.timer) {
        acc.timer = setTimeout(() => { void this.flush(group); }, this.opts.windowMs);
      }
    });
  }

  private async flush(group: string): Promise<void> {
    const acc = this.groups.get(group);
    if (!acc || acc.entries.length === 0) return;
    this.groups.delete(group);
    if (acc.timer) clearTimeout(acc.timer);
    try {
      const sigs = await this.opts.onFlush(acc.entries.map((e) => e.entry));
      acc.entries.forEach((e, i) => e.resolve(sigs[i] ?? ''));
    } catch (err) {
      acc.entries.forEach((e) => e.reject(err as Error));
    }
  }
}
