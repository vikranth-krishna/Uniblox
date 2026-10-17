import type { Config } from "../src/config.js";
import { createServices } from "../src/services/index.js";
import { FakePaymentGateway, type PaymentGateway } from "../src/services/payment.js";
import { Store } from "../src/store.js";
import type { Product } from "../src/types.js";

export const testConfig: Config = {
  port: 0,
  couponEveryN: 2,
  couponPercent: 10,
  paymentSimulation: true,
  paymentDelayMs: 0,
};

interface Options {
  products?: Product[];
  payment?: PaymentGateway;
  config?: Partial<Config>;
}

export function build(options: Options = {}) {
  const config = { ...testConfig, ...options.config };
  const store = new Store(options.products ?? catalogue());
  const payment = options.payment ?? new FakePaymentGateway();
  return { config, store, payment, ...createServices(store, config, payment) };
}

export type Built = ReturnType<typeof build>;

export const catalogue = (): Product[] => [
  { id: "a", name: "Item A", unitPriceCents: 1000, stock: 10 },
  { id: "b", name: "Item B", unitPriceCents: 2550, stock: 10 },
  { id: "last", name: "Last One", unitPriceCents: 500, stock: 1 },
];

// Makes a cart holding the given items, ready to check out.
export function cartWith(app: Built, items: Record<string, number>): string {
  const cart = app.carts.create();
  for (const [productId, quantity] of Object.entries(items)) {
    app.carts.addItem(cart.id, productId, quantity);
  }
  return cart.id;
}

// Places n successful orders, one unit of "a" each.
export async function placeOrders(app: Built, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await app.checkout.checkout(cartWith(app, { a: 1 }));
  }
}

// Runs a promise and hands back either its value or the error code, which
// keeps the concurrency assertions readable.
export async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? "UNKNOWN" };
  }
}
