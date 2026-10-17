import type { Config } from "../config.js";
import type { Store } from "../store.js";
import { CartService } from "./cart.js";
import { CheckoutService } from "./checkout.js";
import { CouponService } from "./coupons.js";
import type { PaymentGateway } from "./payment.js";
import { ReportService } from "./report.js";

// One place that wires the services together, used by the app and the tests.
export function createServices(store: Store, config: Config, payment: PaymentGateway) {
  const coupons = new CouponService(store, config);
  return {
    carts: new CartService(store),
    coupons,
    checkout: new CheckoutService(store, coupons, payment),
    reports: new ReportService(store),
  };
}

export type Services = ReturnType<typeof createServices>;
