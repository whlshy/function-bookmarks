export interface CartItem {
  sku: string;
  price: number;
  qty: number;
}

export function addItem(items: CartItem[], item: CartItem): CartItem[] {
  const existing = items.find((i) => i.sku === item.sku);
  if (existing) {
    return items.map((i) =>
      i.sku === item.sku ? { ...i, qty: i.qty + item.qty } : i,
    );
  }
  return [...items, item];
}

export function removeItem(items: CartItem[], sku: string): CartItem[] {
  return items.filter((item) => item.sku !== sku);
}

export function calcSubtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function applyCoupon(subtotal: number, code?: string): number {
  if (!code) {
    return 0;
  }
  if (code === 'SAVE10') {
    return Math.round(subtotal * 0.1 * 100) / 100;
  }
  return 0;
}
