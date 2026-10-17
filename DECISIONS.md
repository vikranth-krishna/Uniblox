# Decisions

This is the reasoning behind the service: what must always be true, where the
spec left gaps, what I chose, and what I left out on purpose.

## System invariants

These are the rules the code and tests are built around. Each one names where
it is enforced.

1. **Stock never goes below zero, and nothing is sold twice.** For every
   product, starting stock = current stock + units across all orders.
   Enforced in `CheckoutService.reserve()`, which checks and decrements in one
   synchronous step.
2. **A cart produces at most one order.** Enforced by the cart status
   (`open`, `checking_out`, `checked_out`) and by the in-flight map in
   `CheckoutService.checkout()`.
3. **A coupon is redeemed at most once**, by exactly one order. A coupon moves
   `available -> reserved -> redeemed`, and only `available` can be taken.
   Enforced in `CouponService.findUsable()` plus `reserve()`.
4. **A failed checkout leaves no trace.** Stock, coupon and cart status are
   back to what they were. Enforced by `release()`.
5. **At most one coupon per milestone, and never for a milestone not reached.**
   Coupons generated <= floor(orders / n). Enforced in
   `CouponService.generate()` through `couponByMilestone`.
6. **An order total is never negative and always explainable.** total =
   subtotal - discount, the discount is a rounded-down percentage of the
   subtotal, and the order stores its own copy of names and prices.
7. **The report equals the orders and coupons.** It is computed from them on
   every call, so it cannot drift.

## Ambiguities and the semantics I picked

| Question | Choice |
| --- | --- |
| What counts toward "every nth order"? | Only successfully placed orders. A declined payment does not count. |
| Is the coupon sent automatically at the nth order? | No. It becomes *eligible*, and an admin generates it, as the brief says. |
| What if several milestones pile up before an admin acts? | Each call generates one coupon for the oldest unrewarded milestone. Three missed milestones take three calls. |
| What does a coupon apply to? | The whole cart subtotal, percentage only. |
| Can one order use two coupons? | No, one coupon per checkout. |
| Is a coupon tied to a customer? | No. Whoever holds the code can use it. There are no accounts in this exercise. |
| Does a coupon expire? | No. Easy to add with an `expiresAt` field. |
| Does the order that reaches a milestone get that coupon? | No. The coupon exists only after the order is placed. |
| Are coupon codes case sensitive? | No. Codes are trimmed and upper-cased. |
| What if the price changed after the item was added? | The customer pays today's price. The order records every change in `priceAdjustments`, and clients can send `expectedTotalCents` to refuse a surprise. |
| What if stock dropped after the item was added? | Checkout fails with `INSUFFICIENT_STOCK` and the cart stays open. Nothing is partly reserved. |
| Does a cart hold stock? | No. Only a checkout in progress holds stock. Adding to a cart is a soft check. |
| Report fields | Orders, items by product, gross, discounts, net, and coupon counts split into available, reserved and redeemed. |

## Decision: Reserve, pay, then commit

**Context:** Checkout touches stock, a coupon and a payment provider. The
payment call is slow and can fail, so the question is how to keep stock and
coupons correct while it is pending.

**Options considered:**
- A: One lock around the whole checkout, payment included.
- B: Charge first, then try to take stock and the coupon.
- C: Reserve stock and coupon, call payment, then commit or release.

**Choice:** C.

**Why:** A makes every buyer wait behind every other buyer's payment call, so
throughput collapses to one checkout at a time. B can charge someone and then
discover the item is gone, which means refunds. C holds only what it needs
while the slow call runs, and a failure has an obvious undo.

**Consequences:** A buyer who arrives while another checkout holds the last
unit sees `INSUFFICIENT_STOCK` even though the unit may return if that payment
fails. I accept that. The price is that `release()` must exactly mirror
`reserve()`, and a test checks it.

## Decision: Atomicity from synchronous sections, no mutex

**Context:** In-memory state needs protection when requests overlap.

**Options considered:**
- A: A mutex around every state change.
- B: Keep `reserve()`, `commit()` and `release()` synchronous so no other
  request can run inside them, and put the only `await` between them.

**Choice:** B.

**Why:** Node runs one piece of JavaScript at a time and switches only at an
`await`. A function with no `await` therefore behaves like a transaction. A
mutex would add code and a place to deadlock without adding safety here. The
rule is written in a comment at the top of `checkout.ts`.

**Consequences:** It is easy to break by adding an `await` in the wrong place.
The concurrency tests exist to catch exactly that. It also does not survive a
second server process, see the scale section.

## Decision: Idempotency by cart, with an optional key

**Context:** Clients retry after timeouts. A retry must not create a second
order or take stock again. A retry can also arrive while the first request is
still waiting on payment.

**Options considered:**
- A: Require an `Idempotency-Key` header and store key -> response.
- B: Treat the cart itself as the idempotency scope, since a cart can be
  bought once, and use the header only to tell a retry from a new attempt.
- C: Reject any second checkout of a cart with 409.

**Choice:** B.

**Why:** C breaks the retry case, because the client never saw the first
answer. A needs a separate key store and still has to decide what a second key
means. With B the cart already holds the truth. Same key and same coupon on a
finished cart returns the original order (200, `Idempotent-Replayed: true`). A
different key returns `CART_ALREADY_CHECKED_OUT`. The same key with a
different coupon returns `IDEMPOTENCY_CONFLICT`. A retry that lands mid
payment waits for the first request and shares its result.

**Consequences:** Two calls with no key at all are treated as the same
attempt, so the second returns the first order instead of an error. That is
friendly to naive clients but would surprise someone who expected a 409.

## Decision: A `reserved` state for coupons

**Context:** A coupon must not be lost by a checkout that fails, and must not
be spent by two checkouts at once.

**Options considered:**
- A: Mark it redeemed when checkout starts, and undo on failure.
- B: Mark it redeemed only after payment succeeds.
- C: Three states: available, reserved, redeemed.

**Choice:** C.

**Why:** A shows "redeemed" for something that may still fail. B lets two
checkouts both pass validation and both pay. With C a second checkout sees
`COUPON_IN_USE` (try again shortly) while the first is pending, and
`COUPON_ALREADY_REDEEMED` once it is final. The two failures mean different
things to a client, so they have different codes.

**Consequences:** The report has a `reserved` count so that generated =
available + reserved + redeemed always holds.

## Decision: Integer cents, discount rounded down

**Context:** Money must be exact, and the discount must be deterministic.

**Options considered:**
- A: Floating point dollars.
- B: A decimal library.
- C: Integer cents.

**Choice:** C. The discount is `floor(subtotal * percent / 100)`.

**Why:** Integers are exact for addition and multiplication, and the only
division is the percentage, which I round down in one place (`percentOf`).
Rounding down means the discount never exceeds the subtotal, so the total can
reach zero but never go negative, even at 100%. Percent must be a whole
number, which keeps `amount * percent` an exact integer.

**Consequences:** Fractional percentages and multiple currencies are out of
scope. Amounts are capped to stay inside the safe integer range.

## Decision: The report is computed, not counted

**Context:** The brief says the report must reconcile with orders and coupons.

**Options considered:**
- A: Running counters updated at checkout.
- B: Compute from the stored orders and coupons on request.

**Choice:** B.

**Why:** Counters can drift from the data when one code path forgets to
update them. A computed report cannot disagree with the orders. It also
guarantees that reading it changes nothing. The cost grows with the number of
orders, which is fine here and would move to a SQL aggregate in production.

## Decision: One error envelope with a code per failure

**Context:** Clients need to tell failures apart and decide whether to retry.

**Choice:** Every error is `{ error: { code, message, details? } }`. Status
codes carry a class of problem, and `code` carries the exact one:

- 400 malformed input (`VALIDATION_ERROR`, `INVALID_JSON`)
- 402 `PAYMENT_DECLINED`
- 404 not found, with one code per resource
- 409 conflicts with current state (`INSUFFICIENT_STOCK`, `COUPON_IN_USE`,
  `COUPON_ALREADY_REDEEMED`, `PRICE_CHANGED`, `CART_NOT_OPEN`,
  `CART_ALREADY_CHECKED_OUT`, `IDEMPOTENCY_CONFLICT`, `NO_ELIGIBLE_MILESTONE`)
- 422 well formed but not processable (`EMPTY_CART`, `INVALID_COUPON`)
- 502 `PAYMENT_UNAVAILABLE`, nothing charged

`details` carries machine-readable context, for example the exact shortages
for `INSUFFICIENT_STOCK`.

## Decision: A payment gateway interface with a fake

**Context:** The brief needs no real payments, but checkout still has a slow
step that can fail.

**Choice:** `PaymentGateway` is an interface, and `FakePaymentGateway` approves
everything unless told to decline. It can add a delay.

**Why:** The reserve and release logic only matters because payment can fail.
Without a seam there is nothing to test that logic against. The fake also
lets tests hold a checkout open on purpose, which is how the race tests
create overlap. A header can force a decline, but only outside production.

## Decision: Python for load testing, not for a second backend

**Context:** I am comfortable in both TypeScript and Python.

**Choice:** The service is TypeScript. `loadtest/hammer.py` is a standard
library Python script that checks the invariants over real HTTP.

**Why:** Two implementations of the business rules would double the surface
for bugs and prove nothing. A black box test in a different language checks
the service from the outside, the way a real client would, and does not share
assumptions with the code under test.

## Transactions, concurrency and idempotency, in short

- Every state change that must be atomic is one synchronous function.
- The payment call is the only `await`. State is reserved before it and
  committed or released after it.
- A cart in `checking_out` rejects edits, so the order cannot change under a
  payment in flight.
- Retries are matched by cart, key and coupon. Mid-flight retries share the
  first request's promise.

## What is implemented and what is deferred

Implemented: carts, checkout with reservation and rollback, idempotent
retries, coupon lifecycle, admin generation and report, OpenAPI spec, Postman
collection, structured logs, request ids, a metrics endpoint, a small front
end, CI, a Dockerfile, unit, integration, concurrency and load tests.

Deferred on purpose:
- Persistence. State is lost on restart.
- Authentication on `/admin`. The routes are grouped under one prefix so a
  single middleware can protect them.
- Reservation expiry. In memory a reservation cannot outlive the process, but
  with a database a crash between reserve and commit would leave one behind.
- Pagination on the admin lists.
- Customer accounts, coupon expiry, per-customer limits, returns and refunds.
- Request validation generated from the OpenAPI file. Validators are hand
  written and small.
- The Docker image has not been built on my machine, only written. CI builds
  it.

## Moving to several instances and a real database

The in-memory approach relies on one process. With several instances, the same
invariants move into the database:

- **Stock:** `UPDATE products SET stock = stock - $q WHERE id = $id AND stock >= $q`
  and check that one row changed. The database does the check and the
  decrement atomically, and that replaces `reserve()`'s stock step.
- **Coupons:** `UPDATE coupons SET status = 'reserved' WHERE code = $c AND status = 'available'`
  and check the row count. A unique index on `milestone` stops two admins
  generating the same milestone.
- **One order per cart:** a unique constraint on `orders.cart_id`.
- **Idempotency:** a table keyed by (cart, key) with a unique constraint,
  written in the same transaction as the reservation. A second instance that
  loses the race reads the winner's row.
- **Payment:** send the idempotency key to the provider so a retried charge is
  not charged twice, and keep a reservation expiry job that releases
  reservations older than a few minutes.
- **Order numbers:** a database sequence. Report: SQL aggregates, or a
  read replica.
- **Serverless:** handlers are already stateless once state is in the database.
  Cold starts matter more than throughput here.
- **Observability:** replace the small logger and counters with pino and an
  OpenTelemetry exporter, and alert on payment decline rate, 5xx rate and
  reservations older than the expiry.

I would keep carts and the idempotency table in the same relational database
as orders so that reserve, charge and commit can be reasoned about in one
transaction boundary. Redis would only come in for rate limiting or caching the
product list.

## How I used AI

I set the scope and the constraints, answered the open questions, and decided
what to build. I used Claude (Anthropic) to propose designs, write the code
and the tests, and I reviewed and ran what it produced. Most of the lines were
written by the AI, so I am describing what I checked and changed rather than
claiming I typed it.

Things that were wrong or weak in the first draft, found by running it:

- **The coupon tests failed on first run.** The test helper built a store
  with the default products while the tests used ids from a different
  catalogue. The service correctly answered "product does not exist", so the
  helper was the bug, and it now uses the test catalogue by default.
- **Passing tests were not taken at face value.** The suite was checked by
  deliberately breaking the code twice: once by removing the stock
  reservation, and once by not releasing the coupon after a decline. Seven
  tests failed for the first and one for the second. The coupon rule had only
  a single test guarding it, which is the kind of thin spot worth knowing
  about.
- **Races were invisible over HTTP at first.** With an instant fake payment
  nothing overlapped, so the load test would pass even against a broken
  implementation. A configurable payment delay was added so that requests
  actually collide.
- **A design rejected before it was written:** holding one lock across the
  payment call. It would have been correct, but it serialises every buyer
  behind a slow external call, so the design went with reserve, pay, commit.

> TODO before submitting: add one example from your own review that you can
> explain in the interview, such as a line you changed or a behaviour you
> disagreed with. Keep it to something that actually happened.

## What I would look at in another two hours

1. A Postgres repository behind the same interface, running the same
   concurrency tests against it. That is where the real risk is.
2. Reservation expiry and crash recovery, with a test that kills the process
   between reserve and commit.
3. A property-based test that applies random sequences of cart and checkout
   operations and asserts all seven invariants after each step.
4. Auth on `/admin` and basic rate limiting.
5. Validation generated from `openapi.yaml`, so the spec and the code cannot
   disagree.
