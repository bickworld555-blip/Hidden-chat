// Small charts for the admin dashboard. One series each (the title names it, so no legend), thin bars with
// rounded data-ends on a recessive baseline, and a hover tooltip on every bar.
import { useState } from 'react';

export function TrendBars({ title, series, unit = '' }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...series.map((point) => point.value));
  const total = series.reduce((sum, point) => sum + point.value, 0);
  const label = (point) => `${new Date(`${point.day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}: ${point.value.toLocaleString()}${unit}`;
  return (
    <figure className="ad-trend">
      <figcaption><span>{title}</span><strong>{total.toLocaleString()}</strong><small>last 14 days</small></figcaption>
      <div className="ad-trend-plot" role="img" aria-label={`${title}, last 14 days: ${series.map(label).join(', ')}`} onPointerLeave={() => setHover(null)}>
        {series.map((point, index) => (
          <span key={point.day} className={`ad-trend-col${hover === index ? ' is-hover' : ''}`} onPointerEnter={() => setHover(index)}>
            <i style={{ height: `${point.value ? Math.max(3, (point.value / max) * 100) : 0}%` }} />
          </span>
        ))}
        {hover !== null && (
          <span className="ad-tooltip" style={{ left: `${((hover + 0.5) / series.length) * 100}%` }}>{label(series[hover])}</span>
        )}
      </div>
      <div className="ad-trend-axis"><span>{series[0]?.day.slice(5)}</span><span>{series.at(-1)?.day.slice(5)}</span></div>
    </figure>
  );
}
