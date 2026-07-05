/**
 * CANONICAL CI COPY of WEBSITES/infrastructure/tests/load/checkout-latency.js —
 * consumed by .github/workflows/qa-live.yml (k6-smoke job). Edit the source in
 * the WEBSITES tree first, then sync this copy.
 */
/**
 * k6 load test — checkout-path latency for a Vinny storefront + the shared Medusa.
 * (QA gap-fill 2026-07-03: the fleet had no load testing at all.)
 *
 * Exercises the revenue path the way a campaign spike would hit it:
 *   storefront page loads (/, /products)  →  Medusa store API cart lifecycle
 *   (regions → products → create cart → add line item → shipping options)
 *
 * Budgets (from the QA doctrine): pages p95 < 2.5s · checkout API p95 < 800ms.
 *
 * PROFILES (PROFILE env):
 *   smoke  (default) —  5 VUs · 1m. Safe anywhere, including prod: read-mostly,
 *                       plus a handful of abandoned carts (soft data, no orders,
 *                       no payment sessions).
 *   spike            —  ramp 0→100 VUs over 2m, hold 3m, down 1m. Campaign /
 *                       influencer / launch-day shape. ⚠️ Run against STAGING or
 *                       with operator sign-off — 100 VUs on the shared Lightsail
 *                       Medusa affects EVERY brand on it (see global-graph).
 *
 * Usage:
 *   k6 run checkout-latency.js \
 *     -e TARGET_ORIGIN=https://touchvodka.com \
 *     -e MEDUSA_URL=https://commerce.vinny.agency \
 *     -e PUBLISHABLE_KEY=pk_xxx            # the brand's channel key (required for API stages)
 *     [-e REGION_ID=reg_xxx] [-e PROFILE=spike]
 *
 * Without PUBLISHABLE_KEY the run degrades gracefully to storefront pages only
 * (still useful for CDN/SSR latency, no cart lifecycle).
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const TARGET_ORIGIN = __ENV.TARGET_ORIGIN || 'https://touchvodka.com';
const MEDUSA_URL = __ENV.MEDUSA_URL || 'https://commerce.vinny.agency';
const PUBLISHABLE_KEY = __ENV.PUBLISHABLE_KEY || '';
const REGION_ID = __ENV.REGION_ID || '';
const PROFILE = __ENV.PROFILE || 'smoke';

const PROFILES = {
  smoke: {
    executor: 'constant-vus',
    vus: 5,
    duration: '1m',
  },
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 100 },
      { duration: '3m', target: 100 },
      { duration: '1m', target: 0 },
    ],
  },
};

export const options = {
  scenarios: { checkout_path: PROFILES[PROFILE] || PROFILES.smoke },
  thresholds: {
    // Layer budgets — tags set per request below.
    'http_req_duration{layer:page}': ['p(95)<2500'],
    'http_req_duration{layer:checkout_api}': ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.98'],
  },
};

const apiHeaders = {
  'content-type': 'application/json',
  'x-publishable-api-key': PUBLISHABLE_KEY,
};

export default function () {
  group('storefront pages', () => {
    for (const path of ['/', '/products']) {
      const res = http.get(`${TARGET_ORIGIN}${path}`, { tags: { layer: 'page' } });
      check(res, { [`GET ${path} is 200`]: (r) => r.status === 200 });
    }
  });

  if (!PUBLISHABLE_KEY) {
    sleep(1);
    return;
  }

  group('medusa cart lifecycle', () => {
    const tags = { tags: { layer: 'checkout_api' } };

    let regionId = REGION_ID;
    if (!regionId) {
      const regions = http.get(`${MEDUSA_URL}/store/regions?limit=1`, { headers: apiHeaders, ...tags });
      check(regions, { 'regions 200': (r) => r.status === 200 });
      regionId = regions.json('regions.0.id');
    }

    const products = http.get(
      `${MEDUSA_URL}/store/products?limit=1&fields=*variants`,
      { headers: apiHeaders, ...tags },
    );
    check(products, { 'products 200': (r) => r.status === 200 });
    const variantId = products.json('products.0.variants.0.id');
    if (!variantId || !regionId) return;

    const cart = http.post(
      `${MEDUSA_URL}/store/carts`,
      JSON.stringify({ region_id: regionId }),
      { headers: apiHeaders, ...tags },
    );
    check(cart, { 'cart created': (r) => r.status === 200 && !!r.json('cart.id') });
    const cartId = cart.json('cart.id');
    if (!cartId) return;

    const lineItem = http.post(
      `${MEDUSA_URL}/store/carts/${cartId}/line-items`,
      JSON.stringify({ variant_id: variantId, quantity: 1 }),
      { headers: apiHeaders, ...tags },
    );
    check(lineItem, { 'line item added': (r) => r.status === 200 });

    const shipping = http.get(
      `${MEDUSA_URL}/store/shipping-options?cart_id=${cartId}`,
      { headers: apiHeaders, ...tags },
    );
    check(shipping, {
      'shipping options 200 + non-empty': (r) =>
        r.status === 200 && (r.json('shipping_options') || []).length > 0,
    });
  });

  sleep(1);
}
