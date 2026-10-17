// Small demo front end. It only talks to the public API, nothing here
// reaches into server state.

const $ = (id) => document.getElementById(id);

const state = {
  cart: null,
  config: { couponEveryN: 5, couponPercent: 10, paymentSimulation: false },
  products: [],
  // One idempotency key per checkout attempt. Kept so "Retry" can reuse it.
  attempt: null,
};

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

let toastTimer;
function toast(message, code, isError = false) {
  const el = $("toast");
  el.className = `toast${isError ? " error" : ""}`;
  el.innerHTML = `${code ? `<code>${esc(code)}</code>` : ""}${esc(message)}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function showError(res) {
  const err = res.data?.error;
  toast(err?.message ?? "Request failed", err?.code ?? res.status, true);
}

function ordinal(n) {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

// ---- products ----

async function loadProducts() {
  const res = await api("GET", "/products");
  state.products = res.data.products;
  renderProducts();
}

function renderProducts() {
  $("product-grid").innerHTML = state.products
    .map((p) => {
      const out = p.stock === 0;
      const badge = out ? ["out", "Sold out"] : p.stock <= 5 ? ["low", `Only ${p.stock} left`] : ["", `${p.stock} in stock`];
      return `
        <article class="card">
          <h3>${esc(p.name)}</h3>
          <span class="badge ${badge[0]}">${badge[1]}</span>
          <span class="price">${money(p.unitPriceCents)}</span>
          <button class="btn btn-primary" data-add="${esc(p.id)}" ${out ? "disabled" : ""}>
            ${out ? "Unavailable" : "Add to cart"}
          </button>
        </article>`;
    })
    .join("");
}

// ---- cart ----

async function ensureCart() {
  if (state.cart && state.cart.status === "open") return state.cart;
  const res = await api("POST", "/carts");
  state.cart = res.data;
  state.attempt = null;
  return state.cart;
}

async function addToCart(productId) {
  const cart = await ensureCart();
  const res = await api("POST", `/carts/${cart.id}/items`, { productId, quantity: 1 });
  if (!res.ok) return showError(res);
  state.cart = res.data;
  state.attempt = null; // a changed cart is a new purchase, not a retry
  renderCart();
}

async function changeQuantity(productId, quantity) {
  const res =
    quantity < 1
      ? await api("DELETE", `/carts/${state.cart.id}/items/${productId}`)
      : await api("PATCH", `/carts/${state.cart.id}/items/${productId}`, { quantity });
  if (!res.ok) return showError(res);
  state.cart = res.data;
  state.attempt = null;
  renderCart();
}

function renderCart() {
  const cart = state.cart;
  $("nav-count").textContent = cart?.itemCount ?? 0;

  if (!cart || cart.lines.length === 0) {
    $("cart-body").innerHTML = `<p class="empty">Nothing here yet. Add something from the list.</p>`;
    $("checkout-btn").disabled = true;
    return;
  }

  const lines = cart.lines
    .map(
      (l) => `
      <div class="cart-line">
        <span class="name">${esc(l.name)}</span>
        <span>${money(l.lineTotalCents)}</span>
        <span class="sub">${money(l.unitPriceCents)} each</span>
        <span class="stepper">
          <button class="btn btn-ghost btn-small" aria-label="Decrease ${esc(l.name)}" data-qty="${esc(l.productId)}" data-to="${l.quantity - 1}">-</button>
          <output aria-label="Quantity of ${esc(l.name)}">${l.quantity}</output>
          <button class="btn btn-ghost btn-small" aria-label="Increase ${esc(l.name)}" data-qty="${esc(l.productId)}" data-to="${l.quantity + 1}">+</button>
        </span>
        ${l.priceChanged ? `<span class="note">Price changed from ${money(l.priceWhenAddedCents)}</span>` : ""}
      </div>`,
    )
    .join("");

  $("cart-body").innerHTML = `${lines}
    <div class="totals">
      <div class="grand"><span>Subtotal</span><span>${money(cart.subtotalCents)}</span></div>
    </div>`;
  $("checkout-btn").disabled = false;
}

// ---- checkout ----

async function checkout(isRetry = false) {
  if (!state.cart || state.cart.lines.length === 0) return;
  if (!isRetry || !state.attempt) {
    state.attempt = { key: crypto.randomUUID(), cartId: state.cart.id };
  }
  const coupon = $("coupon").value.trim();
  const headers = { "Idempotency-Key": state.attempt.key };
  if (!$("decline-wrap").hidden && $("decline").checked) headers["X-Simulate-Payment"] = "decline";

  $("checkout-btn").disabled = true;
  const res = await api("POST", `/carts/${state.attempt.cartId}/checkout`, coupon ? { couponCode: coupon } : {}, headers);
  $("checkout-btn").disabled = false;

  if (!res.ok) {
    showError(res);
    $("retry-btn").hidden = res.status !== 402 && res.status !== 502;
    await refreshCart();
    return;
  }

  const replayed = res.headers.get("Idempotent-Replayed") === "true";
  renderOrder(res.data, replayed);
  toast(replayed ? "Same order returned, nothing was charged twice." : "Order placed.");
  $("retry-btn").hidden = false; // handy for showing the replay
  state.cart = { ...state.cart, status: "checked_out" };
  $("coupon").value = "";
  await Promise.all([loadProducts(), loadAdmin()]);
}

async function refreshCart() {
  const res = await api("GET", `/carts/${state.cart.id}`);
  if (res.ok) {
    state.cart = res.data;
    renderCart();
  }
}

function renderOrder(order, replayed) {
  const lines = order.lines.map((l) => `<dt>${l.quantity} x ${esc(l.name)}</dt><dd>${money(l.lineTotalCents)}</dd>`).join("");
  const adjustments = order.priceAdjustments.length
    ? `<p class="note">${order.priceAdjustments.length} price(s) changed since added to the cart.</p>`
    : "";
  $("order-result").innerHTML = `
    <div class="result${replayed ? " replay" : ""}">
      <h3>${replayed ? "Same order, returned again" : `Order #${order.sequence} placed`}</h3>
      <dl>
        ${lines}
        <dt>Subtotal</dt><dd>${money(order.subtotalCents)}</dd>
        ${order.coupon ? `<dt>Coupon ${esc(order.coupon.code)} (${order.coupon.percent}%)</dt><dd>-${money(order.discountCents)}</dd>` : ""}
        <dt><strong>Total</strong></dt><dd>${money(order.totalCents)}</dd>
      </dl>
      ${adjustments}
      <p class="hint"><code>${esc(order.id)}</code></p>
    </div>`;
  renderCart();
  $("cart-body").innerHTML = `<p class="empty">Cart checked out. Add an item to start a new one.</p>`;
  $("checkout-btn").disabled = true;
}

// ---- staff ----

async function loadAdmin() {
  const [report, coupons, orders] = await Promise.all([
    api("GET", "/admin/report"),
    api("GET", "/admin/coupons"),
    api("GET", "/admin/orders"),
  ]);
  const r = report.data;

  const stat = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $("stats").innerHTML = [
    stat("Orders", r.orders),
    stat("Gross revenue", money(r.grossRevenueCents)),
    stat("Discounts given", money(r.totalDiscountsCents)),
    stat("Net revenue", money(r.netRevenueCents)),
    stat("Coupons made", r.coupons.generated),
    stat("Coupons redeemed", r.coupons.redeemed),
    stat("Items sold", r.items.reduce((n, i) => n + i.quantity, 0)),
  ].join("");

  $("coupon-list").innerHTML =
    coupons.data.coupons.length === 0
      ? `<p class="empty">No coupons yet. One becomes available after every ${ordinal(state.config.couponEveryN)} order.</p>`
      : coupons.data.coupons
          .map((c) => `<div class="row"><code>${esc(c.code)}</code><span class="tag ${c.status}">${c.status}</span></div>`)
          .join("");

  $("order-list").innerHTML =
    orders.data.orders.length === 0
      ? `<p class="empty">No orders yet.</p>`
      : [...orders.data.orders]
          .reverse()
          .map((o) => `<div class="row"><span>#${o.sequence} <code>${esc(o.id)}</code></span><span>${money(o.totalCents)}</span></div>`)
          .join("");
}

async function generateCoupon() {
  const res = await api("POST", "/admin/coupons/generate");
  if (!res.ok) return showError(res);
  toast(`Coupon ${res.data.code} is ready to use.`);
  $("coupon").value = res.data.code;
  await loadAdmin();
}

// ---- wiring ----

document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]");
  if (add) return addToCart(add.dataset.add);
  const qty = event.target.closest("[data-qty]");
  if (qty) return changeQuantity(qty.dataset.qty, Number(qty.dataset.to));
});

$("checkout-form").addEventListener("submit", (event) => {
  event.preventDefault();
  checkout(false);
});
$("retry-btn").addEventListener("click", () => checkout(true));
$("generate-btn").addEventListener("click", generateCoupon);
$("refresh-btn").addEventListener("click", loadAdmin);

async function init() {
  const config = await api("GET", "/config");
  if (config.ok) state.config = config.data;
  $("reward-n").textContent = ordinal(state.config.couponEveryN);
  $("reward-pct").textContent = `${state.config.couponPercent}%`;
  $("decline-wrap").hidden = !state.config.paymentSimulation;
  renderCart();
  await Promise.all([loadProducts(), loadAdmin()]);
}

init();
