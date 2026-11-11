// Business subscriptions: the prepared structure, not live billing. Plans and the features they unlock are
// defined here, every account is on the free plan, and `hasFeature` is the single place future feature gating
// will check. Connecting a payment provider later means: store subscriptions, make planFor() read them, and
// set BILLING_PROVIDER. Until then nothing is charged and no feature is locked.

export const FEATURES = [
  { id: 'catalog', label: 'Catalog and collections' },
  { id: 'quick_replies', label: 'Quick replies' },
  { id: 'away_greeting', label: 'Greeting and away messages' },
  { id: 'labels', label: 'Labels' },
  { id: 'broadcast_lists', label: 'Broadcast lists' },
  { id: 'verified_badge', label: 'Verified badge (reviewed)' },
  { id: 'multi_agent', label: 'Several people answering one account' },
  { id: 'scheduled_broadcasts', label: 'Scheduled broadcasts' },
  { id: 'priority_support', label: 'Priority support' },
];

export const PLANS = [
  { id: 'free', name: 'Free', priceMonthly: 0, currency: 'USD', status: 'live',
    features: ['catalog', 'quick_replies', 'away_greeting', 'labels', 'broadcast_lists', 'verified_badge'] },
  { id: 'business_pro', name: 'Business Pro', priceMonthly: null, currency: 'USD', status: 'planned',
    features: ['catalog', 'quick_replies', 'away_greeting', 'labels', 'broadcast_lists', 'verified_badge', 'scheduled_broadcasts', 'priority_support'] },
  { id: 'enterprise', name: 'Enterprise', priceMonthly: null, currency: 'USD', status: 'planned',
    features: FEATURES.map((feature) => feature.id) },
];

/** The account's plan. Every account is on Free until billing is connected. */
export async function planFor(_userId) {
  return PLANS[0];
}

/** Future feature gating: true when the account's plan includes the feature. */
export async function hasFeature(userId, feature) {
  return (await planFor(userId)).features.includes(feature);
}

export function registerBilling({ app, requireAdmin, provider = process.env.BILLING_PROVIDER || null }) {
  app.get('/api/admin/v1/billing', requireAdmin, (_request, response) => {
    response.json({ provider, live: false, plans: PLANS, features: FEATURES, subscribers: [] });
  });
}
