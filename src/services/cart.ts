import { cartNotOpen, insufficientStock, validation } from "../errors.js";
import type { Cents } from "../money.js";
import type { Store } from "../store.js";
import type { Cart } from "../types.js";

export const MAX_LINE_QUANTITY = 100;

export interface CartLineView {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
  priceWhenAddedCents: Cents;
  priceChanged: boolean;
  availableStock: number;
}

export interface CartView {
  id: string;
  status: Cart["status"];
  lines: CartLineView[];
  itemCount: number;
  subtotalCents: Cents;
  orderId: string | null;
}

export function parseQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LINE_QUANTITY) {
    throw validation(`quantity must be a whole number between 1 and ${MAX_LINE_QUANTITY}`);
  }
  return value;
}

export class CartService {
  constructor(private readonly store: Store) {}

  create(): CartView {
    const cart: Cart = {
      id: this.store.newId("cart"),
      status: "open",
      lines: new Map(),
      createdAt: new Date().toISOString(),
    };
    this.store.carts.set(cart.id, cart);
    return this.view(cart.id);
  }

  view(cartId: string): CartView {
    const cart = this.store.getCart(cartId);
    const lines: CartLineView[] = [];
    let subtotal = 0;
    let itemCount = 0;

    for (const line of cart.lines.values()) {
      const product = this.store.getProduct(line.productId);
      const lineTotal = product.unitPriceCents * line.quantity;
      subtotal += lineTotal;
      itemCount += line.quantity;
      lines.push({
        productId: product.id,
        name: product.name,
        unitPriceCents: product.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: lineTotal,
        priceWhenAddedCents: line.priceWhenAddedCents,
        priceChanged: product.unitPriceCents !== line.priceWhenAddedCents,
        availableStock: product.stock,
      });
    }

    return {
      id: cart.id,
      status: cart.status,
      lines,
      itemCount,
      subtotalCents: subtotal,
      orderId: cart.orderId ?? null,
    };
  }

  // Adding a product that is already in the cart increases its quantity.
  addItem(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.openCart(cartId);
    const product = this.store.getProduct(productId);
    const existing = cart.lines.get(productId);
    const wanted = (existing?.quantity ?? 0) + quantity;
    this.assertWithinLimits(productId, wanted, product.stock);

    cart.lines.set(productId, {
      productId,
      quantity: wanted,
      priceWhenAddedCents: existing?.priceWhenAddedCents ?? product.unitPriceCents,
    });
    return this.view(cartId);
  }

  // Sets the quantity to an exact value. Use removeItem to take a line out.
  setQuantity(cartId: string, productId: string, quantity: number): CartView {
    const cart = this.openCart(cartId);
    const line = cart.lines.get(productId);
    if (!line) throw validation(`Product '${productId}' is not in this cart`);
    const product = this.store.getProduct(productId);
    this.assertWithinLimits(productId, quantity, product.stock);
    line.quantity = quantity;
    return this.view(cartId);
  }

  removeItem(cartId: string, productId: string): CartView {
    const cart = this.openCart(cartId);
    if (!cart.lines.delete(productId)) {
      throw validation(`Product '${productId}' is not in this cart`);
    }
    return this.view(cartId);
  }

  // Stock is not held by a cart, this is only an early warning. The real
  // check happens again at checkout.
  private assertWithinLimits(productId: string, wanted: number, stock: number): void {
    if (wanted > MAX_LINE_QUANTITY) {
      throw validation(`A cart line cannot hold more than ${MAX_LINE_QUANTITY} units`);
    }
    if (wanted > stock) {
      throw insufficientStock([{ productId, requested: wanted, available: stock }]);
    }
  }

  private openCart(cartId: string): Cart {
    const cart = this.store.getCart(cartId);
    if (cart.status !== "open") throw cartNotOpen(cart.id, cart.status);
    return cart;
  }
}
