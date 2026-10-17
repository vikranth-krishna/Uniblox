# Uniblox Checkout and Rewards Service

A small ecommerce backend: carts, an idempotent checkout, and a coupon that
becomes available after every nth successful order. It is written in
TypeScript on Express with in-memory storage, plus a tiny demo front end.

The reasoning behind the design is in [DECISIONS.md](DECISIONS.md).

Time spent: about TODO hours (fill in the real number before submitting).

## Run it

Needs Node 20 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

Open http://localhost:3000 for the demo store, with a staff section at the
bottom. Restarting the server resets all data.

Settings (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | HTTP port |
| `COUPON_EVERY_N` | 5 | Every nth successful order makes a coupon available |
| `COUPON_DISCOUNT_PERCENT` | 10 | Whole percent taken off the subtotal |
| `PAYMENT_DELAY_MS` | 0 | Fake payment latency, useful for seeing races |
| `PAYMENT_SIMULATION` | on | `off` disables the decline header. Always off when `NODE_ENV=production` |

With Docker: `docker build -t uniblox . && docker run -p 3000:3000 uniblox`.

## Tests

```bash
npm test             # unit, API and concurrency tests (vitest)
npm run typecheck
```

The concurrency tests hold a payment in flight on purpose so competing
checkouts overlap. They cover the last unit being bought by twelve people at
once, one coupon being used by eight checkouts at once, ten identical retries,
and coupons and stock coming back after a declined payment.

There is also a black box check in Python that drives a running server over
HTTP. It uses only the standard library.

```bash
PAYMENT_DELAY_MS=40 npm start                      # terminal 1, fresh server
npm run loadtest -- --base http://localhost:3000   # terminal 2
```

A Postman collection is in `postman/`. Import it and run the Storefront folder
top to bottom, each request saves the ids the next one needs. The full API
description is in [openapi.yaml](openapi.yaml).

## API

Money is always an integer number of cents. Errors look like
`{ "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": {} } }`.

Storefront:

| Method and path | What it does | Success |
| --- | --- | --- |
| `GET /products` | Products with price and stock | 200 |
| `POST /carts` | New empty cart | 201 |
| `GET /carts/:id` | Cart with live prices and totals | 200 |
| `POST /carts/:id/items` | Add `{ productId, quantity }`, merges with an existing line | 201 |
| `PATCH /carts/:id/items/:productId` | Set `{ quantity }` | 200 |
| `DELETE /carts/:id/items/:productId` | Remove the line | 200 |
| `POST /carts/:id/checkout` | Place the order. Optional body `{ couponCode, expectedTotalCents }`, optional `Idempotency-Key` header | 201, or 200 on a replay |
| `GET /orders/:id` | One order | 200 |

Admin (no authentication in this exercise, everything under `/admin` is meant
for staff):

| Method and path | What it does | Success |
| --- | --- | --- |
| `POST /admin/coupons/generate` | Coupon for the oldest unrewarded milestone | 201 |
| `GET /admin/coupons` | All coupons with their state | 200 |
| `GET /admin/orders` | All orders in order placed | 200 |
| `GET /admin/report` | Items sold, gross, discounts, net, coupon counts, order count | 200 |

Also: `GET /health`, `GET /metrics`, `GET /config`.

### Errors worth knowing

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_JSON` | Bad quantity, missing field, broken JSON |
| 402 | `PAYMENT_DECLINED` | Payment failed. Stock and coupon are released and the cart reopens |
| 404 | `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` | Unknown id |
| 409 | `INSUFFICIENT_STOCK` | Not enough units. `details.shortages` lists them |
| 409 | `COUPON_ALREADY_REDEEMED`, `COUPON_IN_USE` | Coupon spent, or held by a checkout in progress |
| 409 | `PRICE_CHANGED` | `expectedTotalCents` did not match |
| 409 | `CART_NOT_OPEN`, `CART_ALREADY_CHECKED_OUT`, `IDEMPOTENCY_CONFLICT` | Cart state or retry mismatches |
| 409 | `NO_ELIGIBLE_MILESTONE` | Nothing to generate yet |
| 422 | `EMPTY_CART`, `INVALID_COUPON` | Cannot be processed |

### Retrying a checkout

```bash
curl -X POST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: order-123'
# timeout? send exactly the same request again
curl -i -X POST localhost:3000/carts/$CART/checkout -H 'Idempotency-Key: order-123'
# HTTP/1.1 200 OK, Idempotent-Replayed: true, same order, stock taken once
```

To try a failed payment: add `-H 'X-Simulate-Payment: decline'` to a checkout.

## Layout

```
src/
  money.ts            integer cents and the rounding rule
  errors.ts           the error envelope and every error code
  store.ts            in-memory state and seed products
  services/
    cart.ts           cart rules and validation
    checkout.ts       reserve, pay, commit or release
    coupons.ts        milestones, codes, coupon lifecycle
    report.ts         read only summary
    payment.ts        gateway interface and a fake
  app.ts              HTTP routes, logging, metrics
public/               demo front end
test/                 unit, API, concurrency and spec tests
loadtest/hammer.py    black box invariant check
openapi.yaml          API description
postman/              collection
```
