// Business subscriptions: the prepared structure (server/billing.mjs). Plans, what each unlocks, and where
// subscribers will appear once a payment provider is connected. Nothing here charges anyone.
import { useEffect, useState } from 'react';
import { Check, CreditCard, Layers, Minus, PlugZap, Sparkles } from 'lucide-react';
import { adminRequest } from './adminApi.js';

export default function Billing() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { adminRequest('/api/admin/v1/billing').then(setData).catch((caught) => setError(caught.message)); }, []);
  if (error) return <p className="ad-error" role="alert">{error}</p>;
  if (!data) return <p className="ad-muted">Loading…</p>;
  return (
    <div className="ad-billing">
      <div className="ad-banner"><Sparkles size={16} aria-hidden="true" /> Prepared for later: billing isn’t live. Every account is on Free and no feature is locked.</div>

      <section className="ad-plans" aria-label="Plans">
        {data.plans.map((plan) => (
          <article key={plan.id} className={`ad-plan${plan.status === 'live' ? ' is-live' : ''}`}>
            <header>
              <h3>{plan.name}</h3>
              <span className={`ad-tag ${plan.status === 'live' ? 'is-good' : ''}`}>{plan.status === 'live' ? 'Live' : 'Planned'}</span>
            </header>
            <p className="ad-plan-price">{plan.priceMonthly === 0 ? 'Free' : plan.priceMonthly ? `$${plan.priceMonthly}/month` : 'Price to be set'}</p>
            <p className="ad-muted">{plan.features.length} of {data.features.length} features</p>
          </article>
        ))}
      </section>

      <section className="ad-card" aria-label="Feature gating">
        <header className="ad-card-head"><h2><Layers size={16} aria-hidden="true" /> What each plan unlocks</h2></header>
        <div className="ad-table-wrap">
          <table className="ad-table ad-matrix">
            <thead><tr><th>Feature</th>{data.plans.map((plan) => <th key={plan.id}>{plan.name}</th>)}</tr></thead>
            <tbody>
              {data.features.map((feature) => (
                <tr key={feature.id}>
                  <td>{feature.label}<small>{feature.id}</small></td>
                  {data.plans.map((plan) => (
                    <td key={plan.id} className="ad-matrix-cell">{plan.features.includes(feature.id)
                      ? <span className="ad-yes"><Check size={15} aria-label="Included" /></span>
                      : <span className="ad-no"><Minus size={15} aria-label="Not included" /></span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ad-grid-2">
        <div className="ad-card">
          <header className="ad-card-head"><h2><PlugZap size={16} aria-hidden="true" /> Payment provider</h2></header>
          <p><span className="ad-status is-warning">▲ Not connected</span></p>
          <ol className="ad-steps">
            <li>Choose a provider and set <code>BILLING_PROVIDER</code> on the server.</li>
            <li>Store subscriptions and make <code>planFor()</code> read them (server/billing.mjs).</li>
            <li>Gate features with <code>hasFeature(userId, feature)</code>.</li>
          </ol>
        </div>
        <div className="ad-card">
          <header className="ad-card-head"><h2><CreditCard size={16} aria-hidden="true" /> Subscribers</h2></header>
          <div className="ad-empty"><CreditCard size={26} aria-hidden="true" /><p>Subscribers will be listed here once billing is live.</p></div>
        </div>
      </section>
    </div>
  );
}
