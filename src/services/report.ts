import type { Cents } from "../money.js";
import type { Store } from "../store.js";

export interface Report {
  orders: number;
  items: { productId: string; name: string; quantity: number }[];
  grossRevenueCents: Cents;
  totalDiscountsCents: Cents;
  netRevenueCents: Cents;
  coupons: { generated: number; available: number; reserved: number; redeemed: number };
}

// Everything here is derived from the orders and coupons themselves, with no
// separate counters, so the report cannot drift from the data. Read only.
export class ReportService {
  constructor(private readonly store: Store) {}

  build(): Report {
    const items = new Map<string, { productId: string; name: string; quantity: number }>();
    let gross = 0;
    let discounts = 0;

    for (const order of this.store.orders.values()) {
      gross += order.subtotalCents;
      discounts += order.discountCents;
      for (const line of order.lines) {
        const entry = items.get(line.productId) ?? { productId: line.productId, name: line.name, quantity: 0 };
        entry.quantity += line.quantity;
        items.set(line.productId, entry);
      }
    }

    const coupons = { generated: 0, available: 0, reserved: 0, redeemed: 0 };
    for (const coupon of this.store.coupons.values()) {
      coupons.generated++;
      coupons[coupon.status]++;
    }

    return {
      orders: this.store.orders.size,
      items: [...items.values()],
      grossRevenueCents: gross,
      totalDiscountsCents: discounts,
      netRevenueCents: gross - discounts,
      coupons,
    };
  }
}
