import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FakePaymentGateway } from "../src/services/payment.js";
import { Store } from "../src/store.js";
import { catalogue, testConfig } from "./helpers.js";

let api: ReturnType<typeof request>;

beforeEach(() => {
  const app = createApp({ config: testConfig, store: new Store(catalogue()), payment: new FakePaymentGateway(10) });
  api = request(app);
});

async function newCart(): Promise<string> {
  const res = await api.post("/carts").expect(201);
  return res.body.id;
}

async function fullOrder(items: { productId: string; quantity: number }[], headers: Record<string, string> = {}, body = {}) {
  const cartId = await newCart();
  for (const item of items) await api.post(`/carts/${cartId}/items`).send(item).expect(201);
  return { cartId, res: await api.post(`/carts/${cartId}/checkout`).set(headers).send(body) };
}

describe("cart endpoints", () => {
  it("adds, updates, removes and prices items", async () => {
    const cartId = await newCart();

    await api.post(`/carts/${cartId}/items`).send({ productId: "a", quantity: 2 }).expect(201);
    await api.post(`/carts/${cartId}/items`).send({ productId: "a", quantity: 1 }).expect(201); // merges
    const updated = await api.patch(`/carts/${cartId}/items/a`).send({ quantity: 4 }).expect(200);
    expect(updated.body.lines[0]).toMatchObject({ quantity: 4, lineTotalCents: 4000 });
    expect(updated.body.subtotalCents).toBe(4000);

    const emptied = await api.delete(`/carts/${cartId}/items/a`).expect(200);
    expect(emptied.body.lines).toEqual([]);
  });

  it("does not let bad input into the cart", async () => {
    const cartId = await newCart();
    const add = (body: unknown) => api.post(`/carts/${cartId}/items`).send(body as object);

    expect((await add({ productId: "a", quantity: 0 })).status).toBe(400);
    expect((await add({ productId: "a", quantity: -2 })).status).toBe(400);
    expect((await add({ productId: "a", quantity: 1.5 })).status).toBe(400);
    expect((await add({ productId: "a", quantity: "2" })).status).toBe(400);
    expect((await add({ quantity: 1 })).status).toBe(400);
    expect((await add({ productId: "ghost", quantity: 1 })).body.error.code).toBe("PRODUCT_NOT_FOUND");
    expect((await add({ productId: "last", quantity: 2 })).body.error.code).toBe("INSUFFICIENT_STOCK");

    const cart = await api.get(`/carts/${cartId}`).expect(200);
    expect(cart.body.lines).toEqual([]);
  });

  it("answers 404 for unknown carts and routes", async () => {
    expect((await api.get("/carts/nope")).body.error.code).toBe("CART_NOT_FOUND");
    expect((await api.get("/nothing-here")).body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("rejects malformed JSON with a clear error", async () => {
    const res = await api.post("/carts/x/items").set("content-type", "application/json").send("{oops");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});

describe("checkout endpoint", () => {
  it("returns 201 first and 200 with a replay header on retry", async () => {
    const { cartId, res } = await fullOrder([{ productId: "a", quantity: 1 }], { "Idempotency-Key": "abc" });
    expect(res.status).toBe(201);

    const retry = await api.post(`/carts/${cartId}/checkout`).set("Idempotency-Key", "abc");
    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.id).toBe(res.body.id);

    const fetched = await api.get(`/orders/${res.body.id}`).expect(200);
    expect(fetched.body.totalCents).toBe(1000);
  });

  it("uses distinct status codes for distinct failures", async () => {
    const empty = await api.post(`/carts/${await newCart()}/checkout`);
    expect([empty.status, empty.body.error.code]).toEqual([422, "EMPTY_CART"]);

    const declined = await fullOrder([{ productId: "a", quantity: 1 }], { "X-Simulate-Payment": "decline" });
    expect([declined.res.status, declined.res.body.error.code]).toEqual([402, "PAYMENT_DECLINED"]);

    const badCoupon = await fullOrder([{ productId: "a", quantity: 1 }], {}, { couponCode: "NOPE" });
    expect([badCoupon.res.status, badCoupon.res.body.error.code]).toEqual([422, "INVALID_COUPON"]);

    const wrongTotal = await fullOrder([{ productId: "a", quantity: 1 }], {}, { expectedTotalCents: 1 });
    expect([wrongTotal.res.status, wrongTotal.res.body.error.code]).toEqual([409, "PRICE_CHANGED"]);

    const badBody = await fullOrder([{ productId: "a", quantity: 1 }], {}, { couponCode: 42 });
    expect(badBody.res.status).toBe(400);
  });

  it("returns a declined cart to the shopper so they can try again", async () => {
    const { cartId } = await fullOrder([{ productId: "a", quantity: 1 }], { "X-Simulate-Payment": "decline" });
    const cart = await api.get(`/carts/${cartId}`).expect(200);
    expect(cart.body.status).toBe("open");
    await api.post(`/carts/${cartId}/checkout`).expect(201);
  });
});

describe("admin reporting", () => {
  it("reconciles with the orders and coupons the API returns", async () => {
    // config has n = 2, so the 2nd order unlocks a coupon
    await fullOrder([{ productId: "a", quantity: 2 }]);
    await fullOrder([{ productId: "b", quantity: 1 }]);

    const generated = await api.post("/admin/coupons/generate").expect(201);
    await api.post("/admin/coupons/generate").expect(409); // nothing new to hand out

    const { res } = await fullOrder([{ productId: "b", quantity: 2 }], {}, { couponCode: generated.body.code });
    expect(res.status).toBe(201);

    const report = (await api.get("/admin/report").expect(200)).body;
    const orders = (await api.get("/admin/orders").expect(200)).body.orders;
    const coupons = (await api.get("/admin/coupons").expect(200)).body.coupons;

    expect(report.orders).toBe(orders.length);
    expect(report.grossRevenueCents).toBe(sum(orders, "subtotalCents"));
    expect(report.totalDiscountsCents).toBe(sum(orders, "discountCents"));
    expect(report.netRevenueCents).toBe(sum(orders, "totalCents"));
    expect(report.netRevenueCents).toBe(report.grossRevenueCents - report.totalDiscountsCents);
    expect(report.coupons).toEqual({ generated: coupons.length, available: 0, reserved: 0, redeemed: 1 });
    expect(report.items).toEqual([
      { productId: "a", name: "Item A", quantity: 2 },
      { productId: "b", name: "Item B", quantity: 3 },
    ]);
  });

  it("does not change anything when read repeatedly", async () => {
    await fullOrder([{ productId: "a", quantity: 1 }]);
    const first = await api.get("/admin/report");
    const second = await api.get("/admin/report");
    expect(second.body).toEqual(first.body);
    expect((await api.get("/admin/orders")).body.orders).toHaveLength(1);
  });

  it("explains when no coupon can be generated yet", async () => {
    const res = await api.post("/admin/coupons/generate");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "NO_ELIGIBLE_MILESTONE", details: { orders: 0, nextMilestoneAtOrder: 2 } });
  });
});

describe("operations endpoints", () => {
  it("exposes health and metrics", async () => {
    await api.get("/health").expect(200, { status: "ok" });
    await api.post("/carts");
    const metrics = await api.get("/metrics").expect(200);
    expect(metrics.text).toContain('http_requests_total{method="POST",route="/carts",status="201"} 1');
  });
});

function sum(rows: Record<string, number>[], field: string): number {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}
