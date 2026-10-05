export const PLANS = {
  free: { name: 'Free', priceUsd: 0, maxSites: 1, minIntervalSec: 300 },
  pro: { name: 'Pro', priceUsd: 9, maxSites: 10, minIntervalSec: 60 },
  team: { name: 'Team', priceUsd: 29, maxSites: 50, minIntervalSec: 60 },
};

export function planFor(user) {
  const active = user.subscription_status === 'active' || user.subscription_status === 'trialing';
  return PLANS[active && PLANS[user.plan] ? user.plan : 'free'];
}
