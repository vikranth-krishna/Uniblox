import {
  ApiError,
  cartAlreadyCheckedOut,
  cartNotOpen,
  emptyCart,
  idempotencyConflict,
  insufficientStock,
  paymentDeclined,
  priceChanged,
} from "../errors.js";
import { percentOf } from "../money.js";
import type { Store } from "../store.js";
import type { Cart, Coupon, Order, OrderLine, PriceAdjustment } from "../types.js";
import type { CouponService } from "./coupons.js";
import { normalizeCode } from "./coupons.js";
import { PaymentDeclinedError, type PaymentGateway } from "./payment.js";

export interface CheckoutRequest {
  couponCode?: string;
  idempotencyKey?: string;
  /** If set and the real total differs, checkout stops with PRICE_CHANGED. */
  expectedTotalCents?: number;
  simulateDecline?: boolean;
}

export interface CheckoutResult {
  order: Order;
  /** True when this call returned an order created by an earlier request. */
  replayed: boolean;
}

// Everything reserve() works out, handed to commit() or release().
interface Plan {
  lines: OrderLine[];
  adjustments: PriceAdjustment[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  coupon: Coupon | null;
}

interface Inflight {
  key: string | null;
  couponCode: string | null;
  promise: Promise<Order>;
}

// Checkout runs in three steps:
//   1. reserve()  takes stock and the coupon, marks the cart as checking out
//   2. payment    the only await in the whole flow
//   3. commit()   turns the reservation into an order, or release() undoes it
//
// reserve(), commit() and release() are synchronous and never await, so no
// other request can run in the middle of one. That is what keeps stock and
// coupons from being double spent. The slow payment call sits between them
// while the reservation holds the resources.
export class CheckoutService {
  private readonly inflight = new Map<string, Inflight>();

  constructor(
    private readonly store: Store,
    private readonly coupons: CouponService,
    private readonly payment: PaymentGateway,
  ) {}

  async checkout(cartId: string, req: CheckoutRequest = {}): Promise<CheckoutResult> {
    const cart = this.store.getCart(cartId);
    const couponCode = normalizeCode(req.couponCode);
    const key = req.idempotencyKey ?? null;

    if (cart.status === "checked_out") {
      return this.replay(cart, key, couponCode);
    }

    // A retry that lands while the first attempt is still talking to the
    // payment provider waits for it and shares the outcome.
    const running = this.inflight.get(cartId);
    if (running) {
      this.assertSameAttempt(running.key, running.couponCode, key, couponCode);
      return { order: await running.promise, replayed: true };
    }

    const promise = this.place(cart, couponCode, key, req);
    this.inflight.set(cartId, { key, couponCode, promise });
    try {
      return { order: await promise, replayed: false };
    } finally {
      this.inflight.delete(cartId);
    }
  }

  private async place(
    cart: Cart,
    couponCode: string | null,
    key: string | null,
    req: CheckoutRequest,
  ): Promise<Order> {
    const plan = this.reserve(cart, couponCode, req.expectedTotalCents);

    try {
      await this.payment.charge({
        amountCents: plan.totalCents,
        reference: cart.id,
        simulateDecline: req.simulateDecline,
      });
    } catch (err) {
      this.release(cart, plan);
      if (err instanceof PaymentDeclinedError) throw paymentDeclined(err.message);
      throw new ApiError(502, "PAYMENT_UNAVAILABLE", "The payment provider could not be reached, nothing was charged");
    }

    return this.commit(cart, plan, key);
  }

  private reserve(cart: Cart, couponCode: string | null, expectedTotal: number | undefined): Plan {
    if (cart.status !== "open") throw cartNotOpen(cart.id, cart.status);
    if (cart.lines.size === 0) throw emptyCart();

    const lines: OrderLine[] = [];
    const adjustments: PriceAdjustment[] = [];
    const shortages: { productId: string; requested: number; available: number }[] = [];
    let subtotal = 0;

    // Price at today's price, not the price when the item was added.
    for (const line of cart.lines.values()) {
      const product = this.store.getProduct(line.productId);
      if (product.stock < line.quantity) {
        shortages.push({ productId: product.id, requested: line.quantity, available: product.stock });
      }
      const lineTotal = product.unitPriceCents * line.quantity;
      subtotal += lineTotal;
      lines.push({
        productId: product.id,
        name: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: lineTotal,
      });
      if (product.unitPriceCents !== line.priceWhenAddedCents) {
        adjustments.push({
          productId: product.id,
          fromCents: line.priceWhenAddedCents,
          toCents: product.unitPriceCents,
        });
      }
    }
    if (shortages.length > 0) throw insufficientStock(shortages);

    const coupon = couponCode ? this.coupons.findUsable(couponCode) : null;
    const discount = coupon ? percentOf(subtotal, coupon.percent) : 0;
    const total = subtotal - discount;

    if (expectedTotal !== undefined && expectedTotal !== total) {
      throw priceChanged(expectedTotal, total);
    }

    // Every check passed. From here on nothing can throw, so we never end up
    // with half of the reservation taken.
    for (const line of lines) {
      this.store.getProduct(line.productId).stock -= line.quantity;
    }
    if (coupon) {
      coupon.status = "reserved";
      coupon.reservedByCartId = cart.id;
    }
    cart.status = "checking_out";

    return { lines, adjustments, subtotalCents: subtotal, discountCents: discount, totalCents: total, coupon };
  }

  // Payment failed: give back the stock and the coupon, reopen the cart.
  private release(cart: Cart, plan: Plan): void {
    for (const line of plan.lines) {
      this.store.getProduct(line.productId).stock += line.quantity;
    }
    if (plan.coupon) {
      plan.coupon.status = "available";
      delete plan.coupon.reservedByCartId;
    }
    cart.status = "open";
  }

  private commit(cart: Cart, plan: Plan, key: string | null): Order {
    const order: Order = {
      id: this.store.newId("ord"),
      sequence: this.store.nextOrderSequence(),
      cartId: cart.id,
      lines: plan.lines,
      subtotalCents: plan.subtotalCents,
      coupon: plan.coupon ? { code: plan.coupon.code, percent: plan.coupon.percent } : null,
      discountCents: plan.discountCents,
      totalCents: plan.totalCents,
      priceAdjustments: plan.adjustments,
      idempotencyKey: key,
      createdAt: new Date().toISOString(),
    };

    this.store.orders.set(order.id, order);
    cart.status = "checked_out";
    cart.orderId = order.id;
    if (plan.coupon) {
      plan.coupon.status = "redeemed";
      plan.coupon.redeemedByOrderId = order.id;
      delete plan.coupon.reservedByCartId;
    }
    return order;
  }

  // Same key and same coupon means "I never got the answer, show me again".
  // A different key means someone is trying to buy the same cart twice.
  private replay(cart: Cart, key: string | null, couponCode: string | null): CheckoutResult {
    const order = this.store.getOrder(cart.orderId as string);
    this.assertSameAttempt(order.idempotencyKey, order.coupon?.code ?? null, key, couponCode, cart.id);
    return { order, replayed: true };
  }

  private assertSameAttempt(
    storedKey: string | null,
    storedCoupon: string | null,
    key: string | null,
    couponCode: string | null,
    cartId = "",
  ): void {
    if (storedKey !== key) throw cartAlreadyCheckedOut(cartId);
    if (storedCoupon !== couponCode) throw idempotencyConflict();
  }
}
