export interface Config {
  port: number;
  /** Every nth successful order makes one coupon available. */
  couponEveryN: number;
  /** Percentage taken off the cart subtotal by a coupon. */
  couponPercent: number;
  /** Lets a client force a payment decline with a header. Handy for demos, off in production. */
  paymentSimulation: boolean;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got '${raw}'`);
  }
  return value;
}

export function validateConfig(config: Config): Config {
  if (!Number.isInteger(config.couponEveryN) || config.couponEveryN < 1) {
    throw new Error("COUPON_EVERY_N must be an integer >= 1");
  }
  if (!Number.isInteger(config.couponPercent) || config.couponPercent < 1 || config.couponPercent > 100) {
    throw new Error("COUPON_DISCOUNT_PERCENT must be an integer between 1 and 100");
  }
  return config;
}

export function loadConfig(): Config {
  return validateConfig({
    port: intFromEnv("PORT", 3000),
    couponEveryN: intFromEnv("COUPON_EVERY_N", 5),
    couponPercent: intFromEnv("COUPON_DISCOUNT_PERCENT", 10),
    paymentSimulation: process.env.NODE_ENV !== "production" && process.env.PAYMENT_SIMULATION !== "off",
  });
}
