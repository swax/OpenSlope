export const STOCK_BOARD_DESIGNS = [
  { id: 'contour', name: 'Contour', edge: 0x18cddd },
  { id: 'sunset', name: 'Sunset Rally', edge: 0x102c42 },
  { id: 'timberline', name: 'Timberline', edge: 0x0c392d },
  { id: 'night-shift', name: 'Night Shift', edge: 0xff009e },
] as const;
export type StockBoardId = (typeof STOCK_BOARD_DESIGNS)[number]['id'];
export function isStockBoardId(value: unknown): value is StockBoardId {
  return STOCK_BOARD_DESIGNS.some(design => design.id === value);
}
export function stockBoardUrl(id: StockBoardId): string {
  return `/equipment/boards/${id}.png?v=1`;
}
function randomUnit(): number {
  if (typeof globalThis.crypto !== 'undefined') return crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
  return Math.random();
}

/** A physical board's identity, shared by its mounted/loose/held render models.
 * Respawns and presentation rebuilds retain it; fresh runs and explicit creation renew it. */
export class StockBoardSelection {
  private current: StockBoardId;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly random = randomUnit,
    initial?: StockBoardId,
  ) {
    this.current = initial ?? STOCK_BOARD_DESIGNS[this.index(STOCK_BOARD_DESIGNS.length)].id;
  }
  get design() {
    return STOCK_BOARD_DESIGNS.find(design => design.id === this.current)!;
  }
  private index(count: number) {
    return Math.min(count - 1, Math.max(0, Math.floor(this.random() * count)));
  }
  renew(): void {
    const options = STOCK_BOARD_DESIGNS.filter(design => design.id !== this.current);
    this.set(options[this.index(options.length)].id);
  }
  set(id: StockBoardId): void {
    if (id === this.current) return;
    this.current = id;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
