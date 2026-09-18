import { loadConfig } from "./config";
import type { User } from "./users";

export interface OrderLine {
  priceCents: number;
  quantity: number;
}

export function subtotalCents(lines: OrderLine[]): number {
  let sum = 0;
  for (const line of lines) {
    sum += line.priceCents * line.quantity;
  }
  return sum;
}

// Applies a percentage discount and then VAT. All amounts are integer cents.
export function orderTotalCents(lines: OrderLine[], discountPercent: number): number {
  const config = loadConfig();
  const subtotal = subtotalCents(lines);
  // Round after each step. A 33% discount on 999 cents used to give a total with a fraction of a cent.
  const discounted = Math.round(subtotal - subtotal * (discountPercent / 100));
  return Math.round(discounted + discounted * config.vatRate);
}

export function canRefund(user: User, amountCents: number): boolean {
  const config = loadConfig();
  return user.role === "admin" && amountCents <= config.maxRefundCents;
}
