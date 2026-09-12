"use client";

interface Props {
  points: { minute: string; event_count: number }[];
}

/** A minimal inline SVG sparkline for per-minute event throughput. No
 * library — a handful of points don't justify one, and this keeps the
 * whole dashboard dependency-free beyond Next/React itself. */
export function Sparkline({ points }: Props) {
  const width = 560;
  const height = 64;
  const pad = 4;

  if (points.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", color: "var(--text-faint)", fontSize: 13 }}>
        Waiting for enough data to draw a trend…
      </div>
    );
  }

  const max = Math.max(...points.map((p) => p.event_count), 1);
  const stepX = (width - pad * 2) / (points.length - 1);

  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - (p.event_count / max) * (height - pad * 2);
    return [x, y] as const;
  });

  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${pad},${height - pad} Z`;

  const last = points[points.length - 1];

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Event throughput per minute">
      <path d={areaPath} fill="var(--accent-dim)" />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r={2.5} fill="var(--accent)" />
      <title>{`${last.event_count} events at ${new Date(last.minute).toLocaleTimeString()}`}</title>
    </svg>
  );
}
