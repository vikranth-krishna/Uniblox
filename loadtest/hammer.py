#!/usr/bin/env python3
"""Black box concurrency and load check for the checkout service.

Talks to a running server over real HTTP, fires overlapping requests, then
checks the invariants from outside: no overselling, one redemption per coupon,
one order per retried checkout, and a report that reconciles with the orders.

Run against a fresh server (state is in memory, so counts start at zero):

    COUPON_EVERY_N=5 PAYMENT_DELAY_MS=40 npm start
    python3 loadtest/hammer.py --base http://localhost:3000

Standard library only, no pip install needed.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.latencies = []

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("content-type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                status, payload = res.status, res.read()
        except urllib.error.HTTPError as err:
            status, payload = err.code, err.read()
        self.latencies.append((time.perf_counter() - started) * 1000)
        return status, (json.loads(payload) if payload else None)

    def new_cart(self, items):
        _, cart = self.call("POST", "/carts")
        for product_id, quantity in items.items():
            status, body = self.call("POST", f"/carts/{cart['id']}/items", {"productId": product_id, "quantity": quantity})
            assert status == 201, body
        return cart["id"]


failures = []


def check(name, condition, detail=""):
    print(f"  [{'ok' if condition else 'FAIL'}] {name}" + (f"  ({detail})" if detail and not condition else ""))
    if not condition:
        failures.append(name)


def parallel(fn, jobs, workers):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, jobs))


def scenario_last_units(api, workers):
    print("\n1. Many buyers, three units left")
    products = api.call("GET", "/products")[1]["products"]
    limited = min(products, key=lambda p: p["stock"])
    stock = limited["stock"]
    carts = [api.new_cart({limited["id"]: 1}) for _ in range(stock * 10)]

    results = parallel(lambda c: api.call("POST", f"/carts/{c}/checkout"), carts, workers)
    sold = [r for r in results if r[0] == 201]
    refused = [r for r in results if r[0] != 201]

    check(f"exactly {stock} orders succeed", len(sold) == stock, f"got {len(sold)}")
    check("every other buyer gets INSUFFICIENT_STOCK", all(r[0] == 409 and r[1]["error"]["code"] == "INSUFFICIENT_STOCK" for r in refused))
    after = next(p for p in api.call("GET", "/products")[1]["products"] if p["id"] == limited["id"])
    check("stock ends at zero, never negative", after["stock"] == 0, f"stock={after['stock']}")


def scenario_retry_storm(api, workers):
    print("\n2. Same checkout retried 40 times at once")
    cart = api.new_cart({"p_lamp": 1})
    headers = {"Idempotency-Key": "storm-1"}
    results = parallel(lambda _: api.call("POST", f"/carts/{cart}/checkout", headers=headers), range(40), workers)

    order_ids = {r[1]["id"] for r in results if r[0] in (200, 201)}
    check("every request succeeded", all(r[0] in (200, 201) for r in results))
    check("they all point at one order", len(order_ids) == 1, f"{len(order_ids)} orders")
    check("only one request created it", sum(1 for r in results if r[0] == 201) == 1)


def scenario_coupon_race(api, workers, every_n):
    print("\n3. One coupon, many simultaneous checkouts")
    report = api.call("GET", "/admin/report")[1]
    missing = (-report["orders"]) % every_n
    for _ in range(missing):
        api.call("POST", f"/carts/{api.new_cart({'p_lamp': 1})}/checkout")

    # Drain any milestones left from earlier scenarios, keep the newest coupon.
    coupon = None
    while True:
        status, body = api.call("POST", "/admin/coupons/generate")
        if status != 201:
            break
        coupon = body
    check("a coupon could be generated at the milestone", coupon is not None)
    if coupon is None:
        return

    carts = [api.new_cart({"p_keyboard": 1}) for _ in range(20)]
    results = parallel(
        lambda c: api.call("POST", f"/carts/{c}/checkout", {"couponCode": coupon["code"]}), carts, workers
    )
    winners = [r for r in results if r[0] == 201]
    check("exactly one checkout redeems it", len(winners) == 1, f"got {len(winners)}")
    check(
        "the rest are told why",
        all(r[1]["error"]["code"] in ("COUPON_IN_USE", "COUPON_ALREADY_REDEEMED") for r in results if r[0] != 201),
    )
    if winners:
        check("discount is 10% of 8999 rounded down", winners[0][1]["discountCents"] == 899)


def scenario_reconcile(api):
    print("\n4. Report matches the orders and coupons")
    report = api.call("GET", "/admin/report")[1]
    orders = api.call("GET", "/admin/orders")[1]["orders"]
    coupons = api.call("GET", "/admin/coupons")[1]["coupons"]

    check("order count", report["orders"] == len(orders))
    check("gross revenue", report["grossRevenueCents"] == sum(o["subtotalCents"] for o in orders))
    check("discounts", report["totalDiscountsCents"] == sum(o["discountCents"] for o in orders))
    check("net revenue", report["netRevenueCents"] == sum(o["totalCents"] for o in orders))
    check("coupon states add up", sum(report["coupons"][k] for k in ("available", "reserved", "redeemed")) == len(coupons))
    check("report is read only", api.call("GET", "/admin/report")[1] == report)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:3000")
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--every-n", type=int, default=5, help="must match the server's COUPON_EVERY_N")
    args = parser.parse_args()

    api = Api(args.base)
    if api.call("GET", "/health")[0] != 200:
        sys.exit(f"Server not reachable at {args.base}")

    scenario_last_units(api, args.workers)
    scenario_retry_storm(api, args.workers)
    scenario_coupon_race(api, args.workers, args.every_n)
    scenario_reconcile(api)

    lat = sorted(api.latencies)
    print(
        f"\n{len(lat)} requests, p50 {statistics.median(lat):.1f} ms, "
        f"p95 {lat[int(len(lat) * 0.95) - 1]:.1f} ms, max {lat[-1]:.1f} ms"
    )
    if failures:
        print(f"\n{len(failures)} check(s) failed")
        sys.exit(1)
    print("\nAll invariants held.")


if __name__ == "__main__":
    main()
