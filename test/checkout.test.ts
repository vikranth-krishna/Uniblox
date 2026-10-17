import { describe, expect, it } from "vitest";
import { FakePaymentGateway } from "../src/services/payment.js";
import { build, catalogue, cartWith, placeOrders, settle } from "./helpers.js";

// A payment delay keeps every checkout "in flight" long enough for the others
// to start, which is the situation the reservation logic exists for.
const slowPayment = () => new FakePaymentGateway(25);

describe("checkout basics", () => {
  it("creates an order that explains itself", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 2, b: 1 });

    const { order, replayed } = await app.checkout.checkout(cartId);

    expect(replayed).toBe(false);
    expect(order.subtotalCents).toBe(2 * 1000 + 2550);
    expect(order.totalCents).toBe(4550);
    expect(order.lines.map((l) => [l.productId, l.quantity, l.lineTotalCents])).toEqual([
      ["a", 2, 2000],
      ["b", 1, 2550],
    ]);
    expect(app.store.getProduct("a").stock).toBe(8);
  });

  it("keeps the order intact when the catalogue changes afterwards", async () => {
    const app = build({ products: catalogue() });
    const { order } = await app.checkout.checkout(cartWith(app, { a: 1 }));

    app.store.getProduct("a").unitPriceCents = 99999;
    app.store.getProduct("a").name = "Renamed";

    const stored = app.store.getOrder(order.id);
    expect(stored.lines[0]).toMatchObject({ name: "Item A", unitPriceCents: 1000, lineTotalCents: 1000 });
  });

  it("rejects an empty cart", async () => {
    const app = build();
    const result = await settle(app.checkout.checkout(app.carts.create().id));
    expect(result).toEqual({ ok: false, code: "EMPTY_CART" });
  });
});

describe("price and stock changing before checkout", () => {
  it("charges today's price and records what moved", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 2 });
    app.store.getProduct("a").unitPriceCents = 1200;

    const { order } = await app.checkout.checkout(cartId);

    expect(order.totalCents).toBe(2400);
    expect(order.priceAdjustments).toEqual([{ productId: "a", fromCents: 1000, toCents: 1200 }]);
  });

  it("stops with PRICE_CHANGED when the client pinned a total, and holds nothing", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 2 });
    app.store.getProduct("a").unitPriceCents = 1200;

    const result = await settle(app.checkout.checkout(cartId, { expectedTotalCents: 2000 }));

    expect(result).toEqual({ ok: false, code: "PRICE_CHANGED" });
    expect(app.store.getProduct("a").stock).toBe(10);
    expect(app.store.getCart(cartId).status).toBe("open");
  });

  it("is all or nothing when only one line is short", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 3, b: 2 });
    app.store.getProduct("b").stock = 1; // someone else bought one

    const result = await settle(app.checkout.checkout(cartId));

    expect(result).toEqual({ ok: false, code: "INSUFFICIENT_STOCK" });
    expect(app.store.getProduct("a").stock).toBe(10); // the healthy line was not touched
    expect(app.store.getCart(cartId).status).toBe("open");
  });

  it("refuses cart edits while the payment is in flight", async () => {
    const app = build({ products: catalogue(), payment: slowPayment() });
    const cartId = cartWith(app, { a: 1 });

    const pending = app.checkout.checkout(cartId);
    expect(() => app.carts.addItem(cartId, "b", 1)).toThrowError(/can no longer be changed/);
    await pending;
  });
});

describe("overselling", () => {
  it("sells the last unit to exactly one of many simultaneous buyers", async () => {
    const app = build({ products: catalogue(), payment: slowPayment() });
    const carts = Array.from({ length: 12 }, () => cartWith(app, { last: 1 }));

    const results = await Promise.all(carts.map((id) => settle(app.checkout.checkout(id))));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "INSUFFICIENT_STOCK")).toBe(true);
    expect(app.store.getProduct("last").stock).toBe(0);
    expect(app.store.orders.size).toBe(1);
  });

  it("never lets total sold exceed stock when buyers want several units", async () => {
    const app = build({
      products: [{ id: "x", name: "X", unitPriceCents: 100, stock: 7 }],
      payment: slowPayment(),
    });
    const carts = Array.from({ length: 10 }, () => cartWith(app, { x: 2 }));

    const results = await Promise.all(carts.map((id) => settle(app.checkout.checkout(id))));

    const sold = results.filter((r) => r.ok).length * 2;
    expect(sold).toBeLessThanOrEqual(7);
    expect(sold).toBe(6); // three buyers fit, the 7th unit stays unsold
    expect(app.store.getProduct("x").stock).toBe(1);
  });

  it("holds stock while a payment is pending and gives it back on a decline", async () => {
    const app = build({ products: catalogue(), payment: slowPayment() });
    const first = cartWith(app, { last: 1 });
    const second = cartWith(app, { last: 1 });

    // The decline releases the unit, so the second buyer can still get it.
    const declined = settle(app.checkout.checkout(first, { simulateDecline: true }));
    const racing = await settle(app.checkout.checkout(second));
    expect(await declined).toEqual({ ok: false, code: "PAYMENT_DECLINED" });
    expect(racing).toEqual({ ok: false, code: "INSUFFICIENT_STOCK" }); // it raced while the unit was held

    const retry = await settle(app.checkout.checkout(second));
    expect(retry.ok).toBe(true);
    expect(app.store.getProduct("last").stock).toBe(0);
  });
});

describe("retries and idempotency", () => {
  it("returns the same order when a client retries after a timeout", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 1 });

    const first = await app.checkout.checkout(cartId, { idempotencyKey: "k-1" });
    const retry = await app.checkout.checkout(cartId, { idempotencyKey: "k-1" });

    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(first.order.id);
    expect(app.store.orders.size).toBe(1);
    expect(app.store.getProduct("a").stock).toBe(9); // charged once
  });

  it("collapses a burst of identical retries into one order", async () => {
    const app = build({ products: catalogue(), payment: slowPayment() });
    const cartId = cartWith(app, { a: 1 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.checkout.checkout(cartId, { idempotencyKey: "burst" })),
    );

    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(app.store.orders.size).toBe(1);
    expect(app.store.getProduct("a").stock).toBe(9);
  });

  it("shares the failure with a retry that arrived mid-flight, then allows a fresh attempt", async () => {
    const app = build({ products: catalogue(), payment: slowPayment() });
    const cartId = cartWith(app, { a: 1 });

    const [one, two] = await Promise.all([
      settle(app.checkout.checkout(cartId, { simulateDecline: true })),
      settle(app.checkout.checkout(cartId, { simulateDecline: true })),
    ]);
    expect(one).toEqual({ ok: false, code: "PAYMENT_DECLINED" });
    expect(two).toEqual({ ok: false, code: "PAYMENT_DECLINED" });
    expect(app.store.getCart(cartId).status).toBe("open");

    const later = await settle(app.checkout.checkout(cartId));
    expect(later.ok).toBe(true);
  });

  it("refuses a second purchase of the same cart under a different key", async () => {
    const app = build({ products: catalogue() });
    const cartId = cartWith(app, { a: 1 });
    await app.checkout.checkout(cartId, { idempotencyKey: "one" });

    const again = await settle(app.checkout.checkout(cartId, { idempotencyKey: "two" }));

    expect(again).toEqual({ ok: false, code: "CART_ALREADY_CHECKED_OUT" });
    expect(app.store.orders.size).toBe(1);
  });

  it("flags a key reused with a different coupon", async () => {
    const app = build({ products: catalogue() });
    await placeOrders(app, 2);
    const coupon = app.coupons.generate();
    const cartId = cartWith(app, { a: 1 });
    await app.checkout.checkout(cartId, { idempotencyKey: "same", couponCode: coupon.code });

    const again = await settle(app.checkout.checkout(cartId, { idempotencyKey: "same" }));

    expect(again).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("coupons at checkout", () => {
  async function withCoupon(options: Parameters<typeof build>[0] = {}) {
    const app = build({ products: catalogue(), ...options });
    await placeOrders(app, 2);
    return { app, coupon: app.coupons.generate() };
  }

  it("takes the percentage off the subtotal and marks the coupon redeemed", async () => {
    const { app, coupon } = await withCoupon();
    const cartId = cartWith(app, { b: 2 }); // 5100

    const { order } = await app.checkout.checkout(cartId, { couponCode: coupon.code });

    expect(order.discountCents).toBe(510);
    expect(order.totalCents).toBe(4590);
    expect(order.coupon).toEqual({ code: coupon.code, percent: 10 });
    expect(app.store.coupons.get(coupon.code)).toMatchObject({ status: "redeemed", redeemedByOrderId: order.id });
  });

  it("accepts the code in any letter case", async () => {
    const { app, coupon } = await withCoupon();
    const { order } = await app.checkout.checkout(cartWith(app, { a: 1 }), {
      couponCode: `  ${coupon.code.toLowerCase()} `,
    });
    expect(order.coupon?.code).toBe(coupon.code);
  });

  it("rejects unknown codes without touching the cart", async () => {
    const { app } = await withCoupon();
    const cartId = cartWith(app, { a: 1 });

    const result = await settle(app.checkout.checkout(cartId, { couponCode: "NOPE" }));

    expect(result).toEqual({ ok: false, code: "INVALID_COUPON" });
    expect(app.store.getCart(cartId).status).toBe("open");
    expect(app.store.getProduct("a").stock).toBe(8);
  });

  it("cannot be used a second time", async () => {
    const { app, coupon } = await withCoupon();
    await app.checkout.checkout(cartWith(app, { a: 1 }), { couponCode: coupon.code });

    const second = await settle(app.checkout.checkout(cartWith(app, { a: 1 }), { couponCode: coupon.code }));

    expect(second).toEqual({ ok: false, code: "COUPON_ALREADY_REDEEMED" });
  });

  it("is redeemed by only one of many simultaneous checkouts", async () => {
    const { app, coupon } = await withCoupon({ payment: slowPayment() });
    const carts = Array.from({ length: 8 }, () => cartWith(app, { b: 1 }));

    const results = await Promise.all(carts.map((id) => settle(app.checkout.checkout(id, { couponCode: coupon.code }))));

    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const losers = results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code));
    expect(losers.every((code) => code === "COUPON_IN_USE" || code === "COUPON_ALREADY_REDEEMED")).toBe(true);
    expect(app.reports.build().totalDiscountsCents).toBe(255);
  });

  it("is not lost when the payment fails, and works on the next try", async () => {
    const { app, coupon } = await withCoupon();
    const cartId = cartWith(app, { a: 1 });

    const failed = await settle(app.checkout.checkout(cartId, { couponCode: coupon.code, simulateDecline: true }));
    expect(failed).toEqual({ ok: false, code: "PAYMENT_DECLINED" });
    expect(app.store.coupons.get(coupon.code)?.status).toBe("available");

    const retried = await settle(app.checkout.checkout(cartId, { couponCode: coupon.code }));
    expect(retried.ok).toBe(true);
  });

  it("is not lost when the stock check fails", async () => {
    const { app, coupon } = await withCoupon();
    const cartId = cartWith(app, { last: 1 });
    app.store.getProduct("last").stock = 0;

    const result = await settle(app.checkout.checkout(cartId, { couponCode: coupon.code }));

    expect(result).toEqual({ ok: false, code: "INSUFFICIENT_STOCK" });
    expect(app.store.coupons.get(coupon.code)?.status).toBe("available");
  });

  it("can take an order to zero but never below", async () => {
    const app = build({ products: catalogue(), config: { couponPercent: 100 } });
    await placeOrders(app, 2);
    const coupon = app.coupons.generate();

    const { order } = await app.checkout.checkout(cartWith(app, { b: 1 }), { couponCode: coupon.code });

    expect(order.totalCents).toBe(0);
    expect(order.discountCents).toBe(order.subtotalCents);
  });
});
