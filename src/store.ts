import { randomUUID } from "node:crypto";
import { notFound } from "./errors.js";
import type { Cart, Coupon, Order, Product } from "./types.js";

// In-memory state. Nothing outside the services should touch these maps
// directly. See DECISIONS.md for why this is safe in a single Node process
// and what replaces it with a real database.
export class Store {
  readonly products = new Map<string, Product>();
  readonly carts = new Map<string, Cart>();
  readonly orders = new Map<string, Order>();
  readonly coupons = new Map<string, Coupon>();
  readonly couponByMilestone = new Map<number, string>();

  private orderSequence = 0;

  constructor(seed: Product[] = defaultProducts()) {
    for (const p of seed) this.products.set(p.id, { ...p });
  }

  newId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }

  nextOrderSequence(): number {
    return ++this.orderSequence;
  }

  getProduct(id: string): Product {
    const product = this.products.get(id);
    if (!product) throw notFound("Product", id);
    return product;
  }

  getCart(id: string): Cart {
    const cart = this.carts.get(id);
    if (!cart) throw notFound("Cart", id);
    return cart;
  }

  getOrder(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw notFound("Order", id);
    return order;
  }
}

export function defaultProducts(): Product[] {
  return [
    { id: "p_keyboard", name: "Mechanical Keyboard", unitPriceCents: 8999, stock: 25 },
    { id: "p_hub", name: "USB-C Hub", unitPriceCents: 3499, stock: 40 },
    { id: "p_headphones", name: "Noise Cancelling Headphones", unitPriceCents: 15900, stock: 12 },
    { id: "p_webcam", name: "1080p Webcam", unitPriceCents: 4950, stock: 30 },
    { id: "p_lamp", name: "Desk Lamp", unitPriceCents: 2599, stock: 50 },
    // The limited one, handy for trying out the stock rules.
    { id: "p_mousepad", name: "Limited Edition Mouse Pad", unitPriceCents: 1999, stock: 3 },
  ];
}
