// Where Hidden Messenger is used: a choropleth of per-country totals (server/regions.mjs: the country comes from
// the device time zone, never an IP). One blue ramp, dark (few) to light (many), on the dark surface; countries
// with nobody are a neutral slate. The busiest country gets a gold outline. Hover for numbers; the ranked list
// beside the map is the table view.
import { useMemo, useState } from 'react';
import { geoEqualEarth, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import world from 'world-atlas/countries-110m.json';

const WIDTH = 960;
const HEIGHT = 440;
// Blue ramp steps for the dark surface (low -> high), and the "nobody here" fill.
export const MAP_STEPS = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];
const EMPTY = '#1f2b40';

const countries = feature(world, world.objects.countries).features.filter((shape) => shape.id !== '010'); // no Antarctica
const projection = geoEqualEarth().fitExtent([[8, 8], [WIDTH - 8, HEIGHT - 8]], { type: 'FeatureCollection', features: countries });
const path = geoPath(projection);
const shapes = countries.map((shape) => ({ id: shape.id, name: shape.properties.name, d: path(shape) }));

/** Bin edges for the four steps: 1+, then 10%, 30% and 60% of the busiest country. */
export function binsFor(max) {
  if (max <= 0) return [];
  const edges = [];
  for (const share of [0, 0.1, 0.3, 0.6]) {
    const edge = Math.max(Math.ceil(max * share), 1, (edges.at(-1) ?? 0) + 1);
    if (edge <= max) edges.push(edge);
  }
  return edges;
}
const stepFor = (value, bins) => {
  if (!value) return -1;
  let step = 0;
  bins.forEach((edge, index) => { if (value >= edge) step = index; });
  return step;
};

export default function WorldMap({ data, metric = 'active' }) {
  const [hover, setHover] = useState(null);
  const byNumeric = useMemo(() => new Map((data?.countries ?? []).filter((row) => row.numeric).map((row) => [row.numeric, row])), [data]);
  const max = Math.max(0, ...(data?.countries ?? []).map((row) => row[metric]));
  const bins = binsFor(max);
  const top = (data?.countries ?? []).slice().sort((a, b) => b[metric] - a[metric])[0];
  const hovered = hover ? byNumeric.get(hover.id) : null;
  const hoverName = hovered?.name ?? shapes.find((shape) => shape.id === hover?.id)?.name;

  return (
    <div className="ad-map" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`World map of ${metric === 'active' ? 'active accounts this week' : 'accounts'} by country. Busiest: ${top ? `${top.name}, ${top[metric]}` : 'none yet'}.`}>
        {shapes.map((shape) => {
          const row = byNumeric.get(shape.id);
          const step = stepFor(row?.[metric] ?? 0, bins);
          const isTop = top && row && row.code === top.code && top[metric] > 0;
          return (
            <path key={shape.id} d={shape.d} className={`ad-map-country${isTop ? ' is-top' : ''}${hover?.id === shape.id ? ' is-hover' : ''}`}
              fill={step < 0 ? EMPTY : MAP_STEPS[step]}
              onPointerMove={(event) => {
                const box = event.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
                setHover({ id: shape.id, x: event.clientX - box.left, y: event.clientY - box.top });
              }} />
          );
        })}
      </svg>
      {hover && (
        <div className="ad-tooltip is-map" style={{ left: hover.x, top: hover.y }}>
          <strong>{hoverName}</strong>
          {hovered ? <span>{hovered.active.toLocaleString()} active this week · {hovered.users.toLocaleString()} accounts</span> : <span>No accounts yet</span>}
        </div>
      )}
      <div className="ad-map-legend" aria-hidden="true">
        <span className="ad-map-swatch" style={{ background: EMPTY }} />0
        {bins.map((edge, index) => (
          <span key={edge} className="ad-map-legend-step"><span className="ad-map-swatch" style={{ background: MAP_STEPS[index] }} />{edge.toLocaleString()}{index === bins.length - 1 ? '+' : ''}</span>
        ))}
        <span className="ad-map-legend-top"><span className="ad-map-swatch is-top" />Busiest</span>
      </div>
    </div>
  );
}
