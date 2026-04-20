export class InFlightMap<T> {
  private readonly map = new Map<string, Promise<T>>();

  run(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing;
    const p = factory().finally(() => this.map.delete(key));
    this.map.set(key, p);
    return p;
  }

  has(key: string): boolean { return this.map.has(key); }
}
