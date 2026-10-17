import type { Cents } from "../money.js";

export interface ChargeRequest {
  amountCents: Cents;
  /** Cart id. A real gateway would also get an idempotency key here. */
  reference: string;
  simulateDecline?: boolean;
}

export class PaymentDeclinedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PaymentDeclinedError";
  }
}

// The one external call in checkout. It sits behind an interface so the
// checkout flow does not care whether it is the fake or a real provider.
export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<void>;
}

// Stand-in for a payment provider. Approves everything unless told to decline.
// The optional delay lets tests hold a checkout "in flight" on purpose.
export class FakePaymentGateway implements PaymentGateway {
  constructor(private readonly delayMs = 0) {}

  async charge(request: ChargeRequest): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (request.simulateDecline) {
      throw new PaymentDeclinedError("card declined");
    }
  }
}
