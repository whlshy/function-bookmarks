import { CartItem, applyCoupon, calcSubtotal } from './cart';

export interface Order {
  id: string;
  items: CartItem[];
  coupon?: string;
  taxRate: number;
}

export function validateOrder(order: Order): boolean {
  if (order.items.length === 0) {
    return false;
  }
  return order.items.every((item) => item.qty > 0 && item.price >= 0);
}

export function calculateTotal(order: Order): number {
  const subtotal = calcSubtotal(order.items);
  const discount = applyCoupon(subtotal, order.coupon);
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * order.taxRate * 100) / 100;
  return taxable + tax;
}

export async function processCheckout(order: Order): Promise<string> {
  if (!validateOrder(order)) {
    throw new Error('Invalid order');
  }
  const total = calculateTotal(order);
  const receiptId = await chargeCard(order.id, total);
  return receiptId;
}

export async function chargeCard(orderId: string, amount: number): Promise<string> {
  if (amount <= 0) {
    return `FREE-${orderId}`;
  }
  // Simulate payment gateway confirmation
  return `PAY-${orderId}-${Math.round(amount * 100)}`;
}
