// Every failure the API can return goes through ApiError so clients always
// get the same envelope: { error: { code, message, details? } }.
//
// Status code convention:
//   400  request is malformed (bad JSON, wrong types, bad quantity)
//   402  payment declined
//   404  resource does not exist
//   409  request is fine but conflicts with current state (stock, coupon, cart state)
//   422  request is well formed but cannot be processed (empty cart, unknown coupon)

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const validation = (message: string, details?: unknown) =>
  new ApiError(400, "VALIDATION_ERROR", message, details);

export const notFound = (what: string, id: string) =>
  new ApiError(404, `${what.toUpperCase()}_NOT_FOUND`, `${what} '${id}' does not exist`);

export const cartNotOpen = (cartId: string, status: string) =>
  new ApiError(409, "CART_NOT_OPEN", `Cart '${cartId}' is ${status} and can no longer be changed`, { status });

export const insufficientStock = (shortages: unknown) =>
  new ApiError(409, "INSUFFICIENT_STOCK", "Not enough stock for one or more items", { shortages });

export const emptyCart = () => new ApiError(422, "EMPTY_CART", "Cannot check out an empty cart");

export const invalidCoupon = (code: string) =>
  new ApiError(422, "INVALID_COUPON", `Coupon '${code}' is not valid`);

export const couponRedeemed = (code: string) =>
  new ApiError(409, "COUPON_ALREADY_REDEEMED", `Coupon '${code}' has already been used`);

export const couponInUse = (code: string) =>
  new ApiError(409, "COUPON_IN_USE", `Coupon '${code}' is being used by another checkout, try again shortly`);

export const priceChanged = (expected: number, actual: number) =>
  new ApiError(409, "PRICE_CHANGED", "The order total changed since you last saw it", {
    expectedTotalCents: expected,
    actualTotalCents: actual,
  });

export const paymentDeclined = (reason: string) =>
  new ApiError(402, "PAYMENT_DECLINED", `Payment was declined: ${reason}`);

export const noEligibleMilestone = (orders: number, every: number) =>
  new ApiError(409, "NO_ELIGIBLE_MILESTONE", "No unrewarded order milestone has been reached", {
    orders,
    nextMilestoneAtOrder: (Math.floor(orders / every) + 1) * every,
  });

export const idempotencyConflict = () =>
  new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used with a different coupon");

export const cartAlreadyCheckedOut = (cartId: string) =>
  new ApiError(409, "CART_ALREADY_CHECKED_OUT", `Cart '${cartId}' was already checked out with a different request`);
