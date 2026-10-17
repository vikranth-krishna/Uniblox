import type { Cents } from "./money.js";

export interface Product {
  id: string;
  name: string;
  unitPriceCents: Cents;
  stock: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
  /** Price at the time the item was added. Only used to tell the client when it moved. */
  priceWhenAddedCents: Cents;
}

export type CartStatus = "open" | "checking_out" | "checked_out";

export interface Cart {
  id: string;
  status: CartStatus;
  lines: Map<string, CartLine>;
  createdAt: string;
  orderId?: string;
}

// Orders copy name and price from the product, so they stay readable even
// after the catalogue changes.
export interface OrderLine {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface PriceAdjustment {
  productId: string;
  fromCents: Cents;
  toCents: Cents;
}

export interface Order {
  id: string;
  /** 1-based position among successful orders. Drives the coupon milestones. */
  sequence: number;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: Cents;
  coupon: { code: string; percent: number } | null;
  discountCents: Cents;
  totalCents: Cents;
  priceAdjustments: PriceAdjustment[];
  idempotencyKey: string | null;
  createdAt: string;
}

export type CouponStatus = "available" | "reserved" | "redeemed";

export interface Coupon {
  code: string;
  /** Which multiple of n this coupon was earned at (1 = first n orders). */
  milestone: number;
  percent: number;
  status: CouponStatus;
  createdAt: string;
  reservedByCartId?: string;
  redeemedByOrderId?: string;
}
