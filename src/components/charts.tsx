'use client';

/**
 * Lightweight inline SVG charts.
 *
 * Hand-rolled rather than a charting library: these four shapes are all the
 * dashboard needs, and they cost nothing in bundle size or theme wrangling —
 * every colour is a CSS variable, so dark mode works with no extra code.
 */

export function Sparkline({
  points,
  color = 'var(--accent)',
}: {
  points: number[];
  color?: string;
}) {
  if (points.length < 2) {
    return <svg viewBox="0 0 100 24" style={{ display: 'block', marginTop: 6, width: '100%', height: 22 }} />;
  }

  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  const coords = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 22 - ((value - min) / range) * 18;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      style={{ display: 'block', marginTop: 6, width: '100%', height: 22 }}
      aria-hidden="true"
    >
      <polyline fill="none" stroke={color} strokeWidth="2" points={coords} />
    </svg>
  );
}

export function ActivityChart({
  data,
}: {
  data: { date: string; sent: number; replies: number }[];
}) {
  const width = 620;
  const height = 190;
  const padding = 10;

  if (data.length === 0) {
    return <div className="empty">No activity yet.</div>;
  }

  const maxSent = Math.max(...data.map((d) => d.sent), 1);
  const maxReplies = Math.max(...data.map((d) => d.replies), 1);

  const x = (i: number) => (i / Math.max(1, data.length - 1)) * width;
  const ySent = (v: number) => height - padding - (v / maxSent) * (height - padding * 2);
  const yReply = (v: number) => height - padding - (v / maxReplies) * (height - padding * 2) * 0.6;

  const sentLine = data.map((d, i) => `${x(i).toFixed(1)},${ySent(d.sent).toFixed(1)}`).join(' ');
  const replyLine = data.map((d, i) => `${x(i).toFixed(1)},${yReply(d.replies).toFixed(1)}`).join(' ');
  const areaPath = `M${sentLine.split(' ').join(' L')} L${width},${height} L0,${height} Z`;

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label="Emails sent and replies received per day"
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            y1={height * fraction}
            x2={width}
            y2={height * fraction}
            stroke="var(--line)"
            strokeWidth="1"
          />
        ))}
        <path d={areaPath} fill="var(--accent)" fillOpacity="0.14" />
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={sentLine} />
        <polyline
          fill="none"
          stroke="var(--violet)"
          strokeWidth="2"
          strokeDasharray="4 3"
          points={replyLine}
        />
      </svg>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 3,
              background: 'var(--accent)',
              verticalAlign: 'middle',
              marginRight: 5,
            }}
          />
          Sent
        </span>
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 3,
              background: 'var(--violet)',
              verticalAlign: 'middle',
              marginRight: 5,
            }}
          />
          Replies
        </span>
      </div>
    </>
  );
}

export function FunnelChart({
  stages,
}: {
  stages: { stage: string; count: number; percent: number }[];
}) {
  const colors = ['var(--accent)', 'var(--accent)', 'var(--accent-2)', 'var(--violet)', 'var(--good)'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {stages.map((stage, index) => (
        <div
          key={stage.stage}
          style={{
            display: 'grid',
            gridTemplateColumns: '96px 1fr 58px',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{stage.stage}</span>
          <div
            style={{
              background: 'var(--panel-2)',
              borderRadius: 6,
              overflow: 'hidden',
              height: 22,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.max(stage.percent, stage.count > 0 ? 6 : 0)}%`,
                background: colors[index] ?? 'var(--accent)',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 9,
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {stage.count > 0 ? stage.count : ''}
            </div>
          </div>
          <span
            style={{
              textAlign: 'right',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            {stage.percent.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  interested: 'var(--good)',
  maybe: 'var(--accent-2)',
  not_interested: 'var(--crit)',
  out_of_office: 'var(--faint)',
  wrong_person: 'var(--blue)',
  unsubscribe_request: 'var(--warn)',
  auto_reply: 'var(--faint)',
  unclassified: 'var(--muted)',
};

const CLASSIFICATION_LABELS: Record<string, string> = {
  interested: 'Interested',
  maybe: 'Maybe',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  wrong_person: 'Wrong person',
  unsubscribe_request: 'Unsubscribed',
  auto_reply: 'Auto-reply',
  unclassified: 'Unclassified',
};

export function DonutChart({ data }: { data: { classification: string; count: number }[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);

  if (total === 0) {
    return <div className="empty">No replies yet.</div>;
  }

  let offset = 25; // start at 12 o'clock

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <svg width="112" height="112" viewBox="0 0 42 42" role="img" aria-label="Reply classifications">
        <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--panel-2)" strokeWidth="6" />
        {data.map((item) => {
          const percent = (item.count / total) * 100;
          const circle = (
            <circle
              key={item.classification}
              cx="21"
              cy="21"
              r="15.9"
              fill="none"
              stroke={CLASSIFICATION_COLORS[item.classification] ?? 'var(--muted)'}
              strokeWidth="6"
              strokeDasharray={`${percent} ${100 - percent}`}
              strokeDashoffset={offset}
            />
          );
          offset -= percent;
          return circle;
        })}
        <text x="21" y="20.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="var(--ink)">
          {total}
        </text>
        <text x="21" y="26" textAnchor="middle" fontSize="3.4" fill="var(--muted)">
          replies
        </text>
      </svg>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12, flex: 1, minWidth: 140 }}>
        {data.map((item) => (
          <div key={item.classification} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: CLASSIFICATION_COLORS[item.classification] ?? 'var(--muted)',
                flex: 'none',
              }}
            />
            {CLASSIFICATION_LABELS[item.classification] ?? item.classification}
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--muted)',
              }}
            >
              {item.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
