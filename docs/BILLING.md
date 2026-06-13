# Stripe billing — operator checklist

How to turn on subscriptions for a Nexus deployment. The server code
(see `packages/server/nexus_server/billing.py` and
`billing_routes.py`) is already in place; this doc covers the
configuration steps in the Stripe Dashboard + the env vars the server
needs.

## 1. Stripe account

1. Sign up at <https://dashboard.stripe.com/register>.
2. Use **test mode** for initial development (toggle top-right). All
   the code paths below work identically in test and live mode — the
   only thing that changes is the API key prefix (`sk_test_…` vs
   `sk_live_…`).

## 2. Create products

Dashboard → **Products** → **+ Add product**. Create four products,
each with TWO recurring prices (monthly + yearly). The "yearly"
prices should be ~83% of monthly × 12 (a ~17% discount).

| Product name        | Monthly price | Yearly price   |
| ------------------- | ------------- | -------------- |
| Nexus Pro           | $29.00 / mo   | $290.00 / yr   |
| Nexus Pro Plus      | $59.00 / mo   | $590.00 / yr   |
| Nexus Radiology Pro | $149.00 / mo  | $1,490.00 / yr |

After saving each price, click into it and **copy its Price ID**.
They look like `price_1QABCxyz9JOXdLMNopqrs…`. You need 6 IDs total.

The repo also assumes a 14-day no-card trial for every checkout —
that's set in code in `billing.create_checkout_session` via
`subscription_data.trial_period_days=14`. If you want different trial
lengths per product, configure them on each Stripe Product instead
and remove the code-side override.

## 3. Webhook endpoint

Dashboard → **Developers** → **Webhooks** → **+ Add endpoint**.

* **Endpoint URL**: `https://<your-server>/api/v1/billing/webhook`
  * For local dev with the desktop app: install
    [Stripe CLI](https://stripe.com/docs/stripe-cli) and run
    `stripe listen --forward-to localhost:<port>/api/v1/billing/webhook`.
    The CLI prints a `whsec_…` signing secret you'll paste into
    STRIPE_WEBHOOK_SECRET below; it's separate from the production
    secret.
* **Events to send** (subscribe to these 5, ignore the rest):
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

After creating the endpoint, click into it → **Signing secret** →
copy the `whsec_…` value.

## 4. Customer Portal

Dashboard → **Settings** → **Billing** → **Customer portal** →
configure:

* Enable customers to **update payment method**.
* Enable **cancel subscription** (immediate / at period end as you
  prefer; we recommend "at period end").
* Optional but recommended: enable **switch plans** so users can
  upgrade Pro → Radiology themselves without contacting support.
* Set the **Return URL** to your `STRIPE_SUCCESS_URL` (see env vars
  below). Customers land there after closing the portal.

## 5. Server env vars

Add these to `packages/server/.env` (or your deployment's secret
store). All keys live in `$HOME/Library/Application Support/RuneProtocol/.env`
on a packaged Nexus.app install — the desktop's setup.sh merges them
on first launch.

```dotenv
# Required — both the API key and the webhook signing secret. With
# either missing, the billing routes return 501 and the server
# refuses to process webhooks.
STRIPE_SECRET_KEY=sk_test_…                  # or sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…

# URLs Stripe redirects to after checkout / portal. The desktop
# opens these in the system browser. Both can point at endpoints
# we serve that show a "you're back!" page and close the tab.
STRIPE_SUCCESS_URL=http://localhost:8001/billing/success
STRIPE_CANCEL_URL=http://localhost:8001/billing/cancel

# Price IDs you copied from step 2. The naming convention
# STRIPE_PRICE_<TIER>_<CADENCE> is hard-coded in
# config.stripe_price_id(); add new tiers/cadences here when
# you launch them.
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_YEARLY=price_…
STRIPE_PRICE_PRO_PLUS_MONTHLY=price_…
STRIPE_PRICE_PRO_PLUS_YEARLY=price_…
STRIPE_PRICE_RADIOLOGY_MONTHLY=price_…
STRIPE_PRICE_RADIOLOGY_YEARLY=price_…
```

Restart the server after editing. Verify with:

```bash
curl -H "Authorization: Bearer <admin JWT>" \
     http://localhost:8001/api/v1/billing/subscription | jq
# Should return the user's current tier (default: "beta") and
# subscription_state=null.
```

## 6. End-to-end test (test mode)

1. Sign up a fresh user in the desktop. Admin approves them in
   `/admin/users/<id>`. Tier defaults to `beta` (no card needed).
2. From the desktop's Plan tab, click **Upgrade to Pro**. The desktop
   POSTs `/api/v1/billing/checkout` with `tier=pro` and receives a
   Stripe Checkout URL; it opens it in the system browser.
3. In Stripe Checkout, use the test card `4242 4242 4242 4242` with
   any future expiry + any CVC + any postal code.
4. Stripe redirects back to STRIPE_SUCCESS_URL. The server has
   received `checkout.session.completed` and updated the user row:
   - `stripe_customer_id` → `cus_…`
   - `stripe_subscription_id` → `sub_…`
   - `tier` → `pro`
   - `subscription_state` → `trialing` (14-day trial active)
5. Force-renew the subscription via Stripe CLI:
   ```
   stripe trigger customer.subscription.updated
   ```
   Verify the server moves `subscription_state` → `active`.
6. Force a failed payment:
   ```
   stripe trigger invoice.payment_failed
   ```
   Verify `subscription_state` → `past_due`.

## 7. Going live

When test mode behaves correctly:

1. Toggle Stripe Dashboard to **live mode**.
2. Recreate products + prices in live mode (test-mode price IDs
   don't carry over).
3. Recreate the webhook endpoint with the live URL.
4. Swap `STRIPE_SECRET_KEY` to `sk_live_…` and
   `STRIPE_WEBHOOK_SECRET` to the live-mode `whsec_…`.
5. Update all `STRIPE_PRICE_*` env vars to the live price IDs.
6. Restart server.

After go-live, ALL billing operations write to your real bank
account. Triple-check before flipping the switch.

## 8. Common pitfalls

* **Webhook returns 5xx → Stripe retries forever**. Our handler
  returns 400 on bad-signature / malformed body (per the
  `billing_routes.py` comment), 200 on accepted events, and 5xx is
  only raised on actual server bugs. If you see infinite retries in
  the Stripe Dashboard event log, check server.log for an uncaught
  exception inside `handle_webhook_event`.
* **Trial ended but user still has Pro access**. We don't currently
  cron-check `trial_ends_at`; the user retains access until Stripe
  fires `subscription.updated` with status=active OR
  `subscription.deleted`. For a tighter gate, add a daily cron that
  flips users with `subscription_state='trialing'` AND
  `trial_ends_at < now` to `trial_expired`.
* **Customer with old email signs up again → two Stripe customers**.
  Stripe creates a new Customer per checkout unless we explicitly
  pass an existing `customer` ID. Long-term fix: maintain
  `users.stripe_customer_id` and pass it to subsequent checkouts
  (the code already records it on first checkout, just doesn't
  re-use it). Add `customer=<id>` to the `stripe.checkout.Session.create`
  call in `billing.create_checkout_session` when the user already has
  a record.
