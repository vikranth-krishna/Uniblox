import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { ApiError, validation } from "./errors.js";
import { Metrics, silentLogger, type Logger } from "./observability.js";
import { parseQuantity } from "./services/cart.js";
import { createServices } from "./services/index.js";
import { FakePaymentGateway, type PaymentGateway } from "./services/payment.js";
import { Store } from "./store.js";

export interface AppDeps {
  config: Config;
  store?: Store;
  payment?: PaymentGateway;
  logger?: Logger;
  metrics?: Metrics;
}

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const store = deps.store ?? new Store();
  const logger = deps.logger ?? silentLogger;
  const metrics = deps.metrics ?? new Metrics();
  const payment = deps.payment ?? new FakePaymentGateway(config.paymentDelayMs);

  const { carts, coupons, checkout, reports } = createServices(store, config, payment);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  // Request id, access log and request counter in one place.
  app.use((req, res, next) => {
    const requestId = req.header("x-request-id") ?? randomUUID();
    res.setHeader("x-request-id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
      metrics.inc("http_requests_total", { method: req.method, route, status: res.statusCode });
      logger.info("request", { requestId, method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(ms * 10) / 10 });
    });
    next();
  });

  app.use(express.static(publicDir));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/metrics", (_req, res) => {
    res.type("text/plain").send(metrics.render());
  });

  // ---- storefront ----

  app.get("/products", (_req, res) => {
    res.json({ products: [...store.products.values()] });
  });

  app.post("/carts", (_req, res) => {
    res.status(201).json(carts.create());
  });

  app.get("/carts/:cartId", (req, res) => {
    res.json(carts.view(param(req, "cartId")));
  });

  app.post("/carts/:cartId/items", (req, res) => {
    const body = objectBody(req);
    const productId = requireString(body.productId, "productId");
    const quantity = parseQuantity(body.quantity);
    res.status(201).json(carts.addItem(param(req, "cartId"), productId, quantity));
  });

  app.patch("/carts/:cartId/items/:productId", (req, res) => {
    const quantity = parseQuantity(objectBody(req).quantity);
    res.json(carts.setQuantity(param(req, "cartId"), param(req, "productId"), quantity));
  });

  app.delete("/carts/:cartId/items/:productId", (req, res) => {
    res.json(carts.removeItem(param(req, "cartId"), param(req, "productId")));
  });

  app.post("/carts/:cartId/checkout", async (req, res) => {
    const body = req.body === undefined ? {} : objectBody(req);
    const idempotencyKey = req.header("idempotency-key");
    if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
      throw validation("Idempotency-Key must be between 1 and 255 characters");
    }

    const result = await checkout.checkout(param(req, "cartId"), {
      couponCode: optionalString(body.couponCode, "couponCode"),
      expectedTotalCents: optionalCents(body.expectedTotalCents, "expectedTotalCents"),
      idempotencyKey,
      simulateDecline: config.paymentSimulation && req.header("x-simulate-payment") === "decline",
    });

    metrics.inc("checkout_total", { outcome: result.replayed ? "replayed" : "placed" });
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.replayed ? 200 : 201).json(result.order);
  });

  app.get("/orders/:orderId", (req, res) => {
    res.json(store.getOrder(param(req, "orderId")));
  });

  // ---- admin (no auth in this exercise, everything under /admin is meant for staff) ----

  app.post("/admin/coupons/generate", (_req, res) => {
    res.status(201).json(coupons.generate());
  });

  app.get("/admin/coupons", (_req, res) => {
    res.json({ coupons: coupons.list() });
  });

  app.get("/admin/orders", (_req, res) => {
    res.json({ orders: [...store.orders.values()] });
  });

  app.get("/admin/report", (_req, res) => {
    res.json(reports.build());
  });

  // ---- fallbacks ----

  app.use((req, _res, next) => {
    next(new ApiError(404, "ROUTE_NOT_FOUND", `${req.method} ${req.path} does not exist`));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      metrics.inc("api_errors_total", { code: err.code });
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (isBodyParserError(err)) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    logger.error("unhandled error", { path: req.originalUrl, error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side" } });
  });

  return app;
}

// ---- small request helpers ----

function param(req: Request, name: string): string {
  return String(req.params[name]);
}

function objectBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validation("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw validation(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw validation(`${field} must be a string`);
  return value;
}

function optionalCents(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validation(`${field} must be a non-negative integer number of cents`);
  }
  return value;
}

function isBodyParserError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "type" in err && (err as { type: string }).type === "entity.parse.failed";
}
