"use client";

/**
 * Lightweight SVG chart components — no external dependencies.
 * Uses a format string type instead of callback functions so they
 * can be passed from Server Components without serialization errors.
 */

interface DataPoint {
  label: string;
  value: number;
}

type FormatType = "number" | "dollar" | "roas" | "percent";

function formatVal(v: number, format: FormatType): string {
  switch (format) {
    case "dollar":
      return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
    case "roas":
      return `${v.toFixed(1)}x`;
    case "percent":
      return `${v.toFixed(1)}%`;
    case "number":
    default:
      return v.toFixed(0);
  }
}

interface LineChartProps {
  data: DataPoint[];
  height?: number;
  color?: string;
  label?: string;
  format?: FormatType;
}

export function LineChart({
  data,
  height = 160,
  color = "#2c2c2c",
  label,
  format = "number",
}: LineChartProps) {
  if (data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa" }}>
        No data
      </div>
    );
  }

  const width = 600;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const minVal = Math.min(...data.map((d) => d.value), 0);
  const range = maxVal - minVal || 1;

  const points = data.map((d, i) => ({
    x: padding.left + (i / Math.max(data.length - 1, 1)) * chartW,
    y: padding.top + chartH - ((d.value - minVal) / range) * chartH,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  const areaD = `${pathD} L ${points[points.length - 1].x} ${padding.top + chartH} L ${points[0].x} ${padding.top + chartH} Z`;

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = minVal + (range / yTicks) * i;
    return { val, y: padding.top + chartH - (i / yTicks) * chartH };
  });

  const xStep = Math.max(1, Math.floor(data.length / 6));

  return (
    <div>
      {label && (
        <div style={{ fontSize: "13px", color: "#888", marginBottom: "8px" }}>
          {label}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto" }}
      >
        {yLabels.map((yl, i) => (
          <g key={i}>
            <line
              x1={padding.left} y1={yl.y}
              x2={width - padding.right} y2={yl.y}
              stroke="#f0ece8" strokeWidth={1}
            />
            <text x={padding.left - 8} y={yl.y + 4} textAnchor="end" fontSize="10" fill="#aaa">
              {formatVal(yl.val, format)}
            </text>
          </g>
        ))}
        <path d={areaD} fill={color} opacity={0.06} />
        <path d={pathD} fill="none" stroke={color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill={color} />
        ))}
        {data.map((d, i) =>
          i % xStep === 0 ? (
            <text key={i} x={points[i].x} y={height - 5} textAnchor="middle" fontSize="10" fill="#aaa">
              {d.label.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

interface BarChartProps {
  data: DataPoint[];
  height?: number;
  color?: string;
  label?: string;
  format?: FormatType;
}

export function BarChart({
  data,
  height = 160,
  color = "#2c2c2c",
  label,
  format = "number",
}: BarChartProps) {
  if (data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa" }}>
        No data
      </div>
    );
  }

  const width = 600;
  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barWidth = (chartW / data.length) * 0.7;
  const barGap = (chartW / data.length) * 0.3;

  const xStep = Math.max(1, Math.floor(data.length / 6));

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = (maxVal / yTicks) * i;
    return { val, y: padding.top + chartH - (i / yTicks) * chartH };
  });

  return (
    <div>
      {label && (
        <div style={{ fontSize: "13px", color: "#888", marginBottom: "8px" }}>
          {label}
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto" }}
      >
        {yLabels.map((yl, i) => (
          <g key={i}>
            <line
              x1={padding.left} y1={yl.y}
              x2={width - padding.right} y2={yl.y}
              stroke="#f0ece8" strokeWidth={1}
            />
            <text x={padding.left - 8} y={yl.y + 4} textAnchor="end" fontSize="10" fill="#aaa">
              {formatVal(yl.val, format)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const barH = (d.value / maxVal) * chartH;
          const x = padding.left + (i / data.length) * chartW + barGap / 2;
          const y = padding.top + chartH - barH;
          return (
            <rect key={i} x={x} y={y} width={barWidth} height={barH} fill={color} rx={2} />
          );
        })}
        {data.map((d, i) =>
          i % xStep === 0 ? (
            <text
              key={i}
              x={padding.left + (i / data.length) * chartW + barWidth / 2 + barGap / 2}
              y={height - 5}
              textAnchor="middle" fontSize="10" fill="#aaa"
            >
              {d.label.slice(5)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}
