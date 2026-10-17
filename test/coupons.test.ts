import { describe, expect, it } from "vitest";
import { build, cartWith, placeOrders, settle } from "./helpers.js";

describe("coupon generation", () => {
  it("is refused until the milestone is reached", async () => {
    const app = build({ config: { couponEveryN: 3 } });
    await placeOrders(app, 2);

    expect(() => app.coupons.generate()).toThrowError(/milestone/);
    try {
      app.coupons.generate();
    } catch (err) {
      expect((err as { code: string }).code).toBe("NO_ELIGIBLE_MILESTONE");
      expect((err as { details: unknown }).details).toEqual({ orders: 2, nextMilestoneAtOrder: 3 });
    }
  });

  it("hands out one coupon per milestone, not one per call", async () => {
    const app = build({ config: { couponEveryN: 2 } });
    await placeOrders(app, 2);

    const first = app.coupons.generate();
    expect(first.milestone).toBe(1);
    expect(first.status).toBe("available");
    expect(() => app.coupons.generate()).toThrow();

    // Orders 3 and 4 reach milestone 2, and only then is another one allowed.
    await placeOrders(app, 2);
    expect(app.coupons.generate().milestone).toBe(2);
    expect(app.coupons.list()).toHaveLength(2);
  });

  it("lets missed milestones be claimed one by one, oldest first", async () => {
    const app = build({ config: { couponEveryN: 2 } });
    await placeOrders(app, 6);

    expect(app.coupons.generate().milestone).toBe(1);
    expect(app.coupons.generate().milestone).toBe(2);
    expect(app.coupons.generate().milestone).toBe(3);
    expect(() => app.coupons.generate()).toThrow();
  });

  it("does not create duplicates when admins click at the same moment", async () => {
    const app = build({ config: { couponEveryN: 2 } });
    await placeOrders(app, 2);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => settle(Promise.resolve().then(() => app.coupons.generate()))),
    );

    expect(attempts.filter((a) => a.ok)).toHaveLength(1);
    expect(app.coupons.list()).toHaveLength(1);
  });

  it("does not count a failed payment as an order", async () => {
    const app = build({ config: { couponEveryN: 1 } });
    const cartId = cartWith(app, { a: 1 });

    await settle(app.checkout.checkout(cartId, { simulateDecline: true }));

    expect(() => app.coupons.generate()).toThrow();
  });
});
