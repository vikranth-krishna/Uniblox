import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { couponInUse, couponRedeemed, invalidCoupon, noEligibleMilestone } from "../errors.js";
import type { Store } from "../store.js";
import type { Coupon } from "../types.js";

export function normalizeCode(code: string | undefined | null): string | null {
  const trimmed = code?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

export class CouponService {
  constructor(
    private readonly store: Store,
    private readonly config: Pick<Config, "couponEveryN" | "couponPercent">,
  ) {}

  // Admin action. Hands out one coupon for the oldest milestone that has been
  // reached and not rewarded yet. If three milestones piled up, it takes three
  // calls to clear them.
  generate(): Coupon {
    const orders = this.store.orders.size;
    const reached = Math.floor(orders / this.config.couponEveryN);

    for (let milestone = 1; milestone <= reached; milestone++) {
      if (this.store.couponByMilestone.has(milestone)) continue;

      const coupon: Coupon = {
        code: this.newCode(),
        milestone,
        percent: this.config.couponPercent,
        status: "available",
        createdAt: new Date().toISOString(),
      };
      this.store.coupons.set(coupon.code, coupon);
      this.store.couponByMilestone.set(milestone, coupon.code);
      return coupon;
    }

    throw noEligibleMilestone(orders, this.config.couponEveryN);
  }

  // Used by checkout. Only a coupon that is available can be taken.
  findUsable(code: string): Coupon {
    const coupon = this.store.coupons.get(code);
    if (!coupon) throw invalidCoupon(code);
    if (coupon.status === "redeemed") throw couponRedeemed(code);
    if (coupon.status === "reserved") throw couponInUse(code);
    return coupon;
  }

  list(): Coupon[] {
    return [...this.store.coupons.values()];
  }

  private newCode(): string {
    for (;;) {
      const code = `SAVE${this.config.couponPercent}-${randomBytes(4).toString("hex").toUpperCase()}`;
      if (!this.store.coupons.has(code)) return code;
    }
  }
}
