# OneClickitLeads — Billing/Pricing Page
App ID: (external — oneclickit.info)
Add new /pricing route and fix /billing

```jsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const CHECKOUT_URL = "https://superagent-b2d614b7.base44.app/functions/createStripeCheckout";

const PLANS = [
  {
    name: "Starter", emoji: "🌱",
    price: { monthly: "$49/mo", annual: "$468/yr" },
    planKey: { monthly: "starter_monthly", annual: "starter_annual" },
    features: ["500 verified leads/mo", "Beauty & wellness niche", "Email verification", "CSV export", "Basic quality scoring", "Email support"],
  },
  {
    name: "Growth", emoji: "📈", highlight: true,
    price: { monthly: "$199/mo", annual: "$1,908/yr" },
    planKey: { monthly: "growth_monthly", annual: "growth_annual" },
    features: ["2,500 verified leads/mo", "All niches", "Advanced enrichment", "CRM export", "Lead scoring + filtering", "Webhook integration", "Priority support"],
  },
  {
    name: "Agency", emoji: "🏢",
    price: { monthly: "$499/mo", annual: "$4,788/yr" },
    planKey: { monthly: "agency_monthly", annual: "agency_annual" },
    features: ["Unlimited leads", "Multi-client workspace", "White-label exports", "Custom scrape jobs", "Dedicated pipeline", "SLA guarantee", "Dedicated account manager"],
  },
];

export default function PricingPage() {
  const [billing, setBilling] = useState("monthly");
  const [loading, setLoading] = useState(null);

  async function handleUpgrade(planKey) {
    setLoading(planKey);
    try {
      const res = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          app: "oneclickitleads",
          plan: planKey,
          success_url: window.location.origin + "/?checkout=success",
          cancel_url: window.location.href,
        }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch { alert("Error. Try again."); }
    finally { setLoading(null); }
  }

  return (
    <div className="max-w-5xl mx-auto py-12 px-4">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold mb-2">Leads That Actually Convert</h1>
        <p className="text-muted-foreground mb-6">Verified beauty & wellness leads. Quality guaranteed.</p>
        <div className="inline-flex items-center gap-2 bg-muted rounded-full p-1">
          <button onClick={() => setBilling("monthly")} className={`px-4 py-1.5 rounded-full text-sm font-medium ${billing === "monthly" ? "bg-white shadow" : "text-muted-foreground"}`}>Monthly</button>
          <button onClick={() => setBilling("annual")} className={`px-4 py-1.5 rounded-full text-sm font-medium ${billing === "annual" ? "bg-white shadow" : "text-muted-foreground"}`}>Annual <span className="text-green-600 font-semibold">Save 20%</span></button>
        </div>
      </div>
      <div className="grid md:grid-cols-3 gap-6">
        {PLANS.map((plan) => {
          const price = plan.price[billing];
          const planKey = plan.planKey[billing];
          return (
            <div key={plan.name} className={`rounded-2xl border p-6 flex flex-col gap-4 bg-white ${plan.highlight ? "border-pink-500 shadow-xl" : "border-border"}`}>
              {plan.highlight && <Badge className="w-fit bg-pink-600 text-white">Most Popular</Badge>}
              <div>
                <div className="text-xl font-bold mb-1">{plan.emoji} {plan.name}</div>
                <div className="text-3xl font-bold">{price}</div>
              </div>
              <ul className="space-y-2 text-sm flex-1">
                {plan.features.map(f => <li key={f} className="flex gap-2"><span className="text-green-500">✓</span>{f}</li>)}
              </ul>
              <Button onClick={() => handleUpgrade(planKey)} disabled={loading === planKey} className={`w-full ${plan.highlight ? "bg-pink-600 hover:bg-pink-700 text-white" : ""}`}>
                {loading === planKey ? "Loading..." : `Get ${plan.name}`}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```
