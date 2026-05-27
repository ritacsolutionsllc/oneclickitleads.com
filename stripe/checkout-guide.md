# Stripe Checkout Wiring Guide — All Apps
Generated: 2026-05-27

## Shared checkout function URL
`https://superagent-b2d614b7.base44.app/functions/createStripeCheckout`

## How to call it (paste into any Base44 page component)
```js
async function handleUpgrade(app, plan) {
  const res = await fetch('https://superagent-b2d614b7.base44.app/functions/createStripeCheckout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      app,
      plan,
      success_url: window.location.origin + '/?checkout=success',
      cancel_url: window.location.href,
    })
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
  else alert('Checkout error: ' + data.error);
}
```

---

## App-specific plan keys

### Wingman AI (app = "wingman")
- `premium_monthly` → $49.99/mo
- `premium_annual` → $299.99/yr
- `diamond_monthly` → $99.99/mo
- `diamond_annual` → $599.99/yr

### iPawOS (app = "ipawos")
- `plus_monthly` → $6/mo
- `plus_annual` → $60/yr
- `family_annual` → $100/yr ⚠️ use annual only (monthly price is bugged in Stripe)
- `pro_monthly` → $15/mo
- `pro_annual` → $150/yr
- `lifetime` → $99 one-time

### ModelBench (app = "modelbench")
- `pro_monthly` → $29/mo
- `pro_annual` → $232/yr
- `team_monthly` → $99/mo
- `team_annual` → $792/yr

### Data Breach Watch (app = "databreachwatch")
- `pro_monthly` → $19/mo
- `pro_annual` → $152/yr
- `team_monthly` → $49/mo
- `team_annual` → $392/yr

### LeadGeneAI (app = "leadgeneai")
- `pro_onetime` → $49 one-time
- `pro_monthly` → $19/mo
- `pro_annual` → $152/yr
- `agency_monthly` → $79/mo
- `agency_annual` → $632/yr

### OneClickSurplusFunds (app = "surplusfunds")
- `starter_monthly` → $15/mo
- `starter_annual` → $144/yr
- `pro_monthly` → $49/mo
- `pro_annual` → $470.40/yr

### OneClickitLeads (app = "oneclickitleads")
- `starter_monthly` → $49/mo
- `starter_annual` → $468/yr
- `growth_monthly` → $199/mo
- `growth_annual` → $1908/yr
- `agency_monthly` → $499/mo
- `agency_annual` → $4788/yr

### GOT IT LEADS (app = "gotitleads")
- `starter_monthly` → $49/mo
- `growth_monthly` → $199/mo
- `agency_monthly` → $499/mo

---

## Webhook endpoint (already deployed)
`https://superagent-b2d614b7.base44.app/functions/stripeWebhook`

Events to subscribe: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated
