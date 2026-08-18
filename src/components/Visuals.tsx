import type { KlinePoint, MoodPoint, PricePoint, ScoreFactors, SentimentEvent, SentimentTone } from "../domain/types";
import { toneLabel } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const chartPath = (values: number[], width: number, height: number, padding = 0) => {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => {
    const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2);
    const y = padding + height - padding * 2 - ((value - min) / range) * (height - padding * 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
};

export function ScoreDial({ score, label = "市场舆情" }: { score: number; label?: string }) {
  const radius = 74;
  const circumference = 2 * Math.PI * radius;
  const progress = circumference * Math.max(0, Math.min(1, score / 100));
  return (
    <div className="relative size-[184px] shrink-0" aria-label={`${label} ${score.toFixed(1)} 分`}>
      <svg viewBox="0 0 184 184" role="img" aria-hidden="true" className="size-full">
        <circle cx="92" cy="92" r={radius} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="92"
          cy="92"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${circumference - progress}`}
          transform="rotate(-90 92 92)"
          className="stroke-up"
        />
        <path d="M41 111 C58 96 70 121 91 106 C111 91 125 116 143 100" fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-foreground/40" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <strong className="text-4xl font-semibold tabular">{score.toFixed(1)}</strong>
        <em className="not-italic text-[11px] text-muted-foreground">{score >= 62 ? "偏暖" : score <= 42 ? "偏冷" : "中性"}</em>
      </div>
    </div>
  );
}

export function MoodFlowChart({ points }: { points: MoodPoint[] }) {
  const width = 760;
  const height = 238;
  const padding = 24;
  const positive = points.map((point) => point.positive);
  const negative = points.map((point) => point.negative);
  const positivePath = chartPath(positive, width, height, padding);
  const negativePath = chartPath(negative, width, height, padding);
  const areaPath = `${positivePath} L${width - padding},${height - padding} L${padding},${height - padding} Z`;

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center gap-4 text-xs text-muted-foreground" aria-hidden="true">
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-up" />正面声量</span>
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-down" />负面声量</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="当日正负面舆情走势" className="h-[220px] w-full sm:h-[238px]">
        <defs>
          <linearGradient id="moodArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--up)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.2, 0.5, 0.8].map((ratio) => <line key={ratio} x1={padding} x2={width - padding} y1={height * ratio} y2={height * ratio} className="stroke-border" strokeWidth="1" strokeDasharray="3 5" />)}
        <path d={areaPath} fill="url(#moodArea)" />
        <path d={positivePath} fill="none" strokeWidth="2" className="stroke-up" />
        <path d={negativePath} fill="none" strokeWidth="2" className="stroke-down" />
        {points.map((point, index) => {
          if (index % 2 !== 0 && index !== points.length - 1) return null;
          const x = padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
          return <text key={point.time} x={x} y={height - 3} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">{point.time}</text>;
        })}
      </svg>
    </div>
  );
}

export function Sparkline({ values, tone = "positive" }: { values: number[]; tone?: SentimentTone }) {
  return (
    <svg
      viewBox="0 0 112 34"
      preserveAspectRatio="none"
      role="img"
      aria-label="趋势缩略图"
      className={cn("h-[34px] w-full min-w-[78px]", tone === "positive" ? "stroke-up" : "stroke-down")}
    >
      <path d={chartPath(values, 112, 34, 2)} fill="none" strokeWidth="1.7" />
    </svg>
  );
}

export function FactorBars({ factors }: { factors: ScoreFactors }) {
  const rows = [
    ["情绪方向", Math.abs(factors.sentiment), factors.sentiment >= 0 ? "bg-up" : "bg-down", `${factors.sentiment > 0 ? "+" : ""}${factors.sentiment}`],
    ["讨论热度", factors.attention, "bg-foreground/70", `${factors.attention}`],
    ["热度增速", factors.velocity, "bg-warning", `${factors.velocity}`],
    ["观点共识", factors.consensus, "bg-foreground/70", `${factors.consensus}`],
    ["来源质量", factors.sourceQuality, "bg-down", `${factors.sourceQuality}`],
    ["价格确认", factors.priceConfirm, "bg-up", `${factors.priceConfirm}`],
    ["信息时效", factors.freshness, "bg-warning", `${factors.freshness}`],
  ] as const;

  return (
    <div className="grid gap-4 border-t pt-5">
      {rows.map(([label, value, color, display]) => (
        <div className="grid grid-cols-[84px_1fr_36px] items-center gap-4" key={label}>
          <span className="text-xs text-muted-foreground">{label}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <i className={cn("block h-full origin-left rounded-full", color)} style={{ transform: `scaleX(${Math.max(0.02, value / 100)})` }} />
          </div>
          <strong className="text-right font-mono text-xs font-medium">{display}</strong>
        </div>
      ))}
    </div>
  );
}

export function PriceSentimentChart({
  prices,
  sentiments,
  events,
}: {
  prices: PricePoint[];
  sentiments: number[];
  events: SentimentEvent[];
}) {
  const width = 820;
  const height = 310;
  const padX = 34;
  const padY = 28;
  const priceValues = prices.map((point) => point.close);
  const sentimentValues = sentiments.length === prices.length
    ? sentiments
    : prices.map((_, index) => sentiments[Math.round((index / Math.max(1, prices.length - 1)) * Math.max(0, sentiments.length - 1))] ?? 0);
  const pricePath = chartPath(priceValues, width, height - 48, padX);
  const sentimentPath = chartPath(sentimentValues, width, height - 48, padX);
  const area = `${pricePath} L${width - padX},${height - padY} L${padX},${height - padY} Z`;
  const markerIndexes = events.slice(0, 3).map((_, index) => Math.max(1, prices.length - 3 - index * 5));

  return (
    <div className="w-full border-y py-5">
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-foreground" />收盘价</span>
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-up" />舆情方向</span>
        <span className="ml-auto text-[11px]">事件标记来自真实线索时间</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="价格与舆情方向叠加走势图" className="h-[270px] w-full sm:h-[320px]">
        <defs>
          <linearGradient id="priceArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--foreground)" stopOpacity="0.12" />
            <stop offset="1" stopColor="var(--foreground)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.2, 0.5, 0.8].map((ratio) => <line key={ratio} x1={padX} x2={width - padX} y1={(height - 34) * ratio} y2={(height - 34) * ratio} className="stroke-border" strokeDasharray="3 5" />)}
        <path d={area} fill="url(#priceArea)" />
        <path d={pricePath} fill="none" strokeWidth="2.1" className="stroke-foreground" />
        <path d={sentimentPath} fill="none" strokeWidth="1.7" strokeDasharray="6 5" className="stroke-up" />
        {markerIndexes.map((index, eventIndex) => {
          const x = padX + (index / Math.max(1, prices.length - 1)) * (width - padX * 2);
          return <g key={events[eventIndex].id}>
            <line x1={x} x2={x} y1={48} y2={height - padY} className="stroke-warning" strokeDasharray="3 5" />
            <circle cx={x} cy={48} r="11" className="fill-warning" />
            <text x={x} y={52} textAnchor="middle" className="fill-card text-[9px] font-bold">{eventIndex + 1}</text>
          </g>;
        })}
        {prices.filter((_, index) => index === 0 || index === prices.length - 1 || index === Math.floor(prices.length / 2)).map((point) => {
          const index = prices.indexOf(point);
          const x = padX + (index / Math.max(1, prices.length - 1)) * (width - padX * 2);
          return <text key={`${point.date}-${index}`} x={x} y={height - 4} textAnchor={index === 0 ? "start" : index === prices.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">{point.date}</text>;
        })}
      </svg>
    </div>
  );
}

export function ToneBadge({ tone }: { tone: SentimentTone }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent",
        tone === "positive" && "bg-up-soft text-up",
        tone === "negative" && "bg-down-soft text-down",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <i className={cn("size-1.5 rounded-full", tone === "positive" ? "bg-up" : tone === "negative" ? "bg-down" : "bg-muted-foreground")} />
      {toneLabel(tone)}
    </Badge>
  );
}

/**
 * 蜡烛图 / 分时折线图：分时线用折线（line），日/周/月线用蜡烛（candle）。
 * 红涨绿跌沿用 A 股语义色。
 */
export function KlineChart({ points, variant = "candle" }: { points: KlinePoint[]; variant?: "line" | "candle" }) {
  if (points.length < 2) return null;
  const width = 860;
  const height = 360;
  const padX = 14;
  const padY = 18;
  const volHeight = 58;
  const gap = 10;
  const chartHeight = height - volHeight - gap - padY;
  const lows = points.map((point) => point.low);
  const highs = points.map((point) => point.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const maxVolume = Math.max(1, ...points.map((point) => point.volume ?? 0));
  const step = (width - padX * 2) / points.length;
  const y = (value: number) => padY + (1 - (value - min) / range) * chartHeight;
  const volY = (volume: number) => height - (volume / maxVolume) * volHeight;
  const bodyWidth = Math.max(1.5, Math.min(9, step * 0.62));
  const linePath = points.map((point, index) => {
    const x = padX + step * (index + 0.5);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y(point.close).toFixed(1)}`;
  }).join(" ");
  const avgPath = points.filter((point) => point.avgPrice !== null && point.avgPrice !== undefined).map((point) => {
    const index = points.indexOf(point);
    const x = padX + step * (index + 0.5);
    return `${x.toFixed(1)},${y(point.avgPrice!).toFixed(1)}`;
  }).join(" L");
  const areaPath = `${linePath} L${width - padX},${height - volHeight - gap} L${padX},${height - volHeight - gap} Z`;
  const gridLevels = [0.25, 0.5, 0.75].map((ratio) => min + range * ratio);
  const labelIndexes = [0, Math.floor(points.length / 2), points.length - 1];

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-up" />涨</span>
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-down" />跌</span>
        <span className="ml-auto font-mono text-[11px] tabular">高 {max.toFixed(2)} · 低 {min.toFixed(2)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="K线图" className="h-[300px] w-full sm:h-[340px]">
        <defs>
          <linearGradient id="klineArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.12" />
            <stop offset="1" stopColor="var(--up)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLevels.map((level) => (
          <g key={level}>
            <line x1={padX} x2={width - padX} y1={y(level)} y2={y(level)} className="stroke-border" strokeDasharray="3 5" />
            <text x={width - padX + 4} y={y(level) + 3} className="fill-muted-foreground text-[9px]">{level.toFixed(2)}</text>
          </g>
        ))}
        {variant === "line" ? (
          <>
            <path d={areaPath} fill="url(#klineArea)" />
            <path d={linePath} fill="none" strokeWidth="1.6" className="stroke-up" />
            {avgPath && <path d={`M${avgPath}`} fill="none" strokeWidth="1.2" strokeDasharray="5 4" className="stroke-warning" />}
            {points.filter((_, index) => labelIndexes.includes(index)).map((point, index) => {
              const sourceIndex = labelIndexes[index];
              const x = padX + step * (sourceIndex + 0.5);
              return <text key={`${point.time}-${index}`} x={x} y={height - volHeight - gap + 12} textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"} className="fill-muted-foreground text-[9px]">{point.time}</text>;
            })}
          </>
        ) : (
          points.map((point, index) => {
            const x = padX + step * (index + 0.5);
            const up = point.close >= point.open;
            const color = up ? "var(--up)" : "var(--down)";
            const bodyTop = y(Math.max(point.open, point.close));
            const bodyBottom = y(Math.min(point.open, point.close));
            return (
              <g key={`${point.time}-${index}`}>
                <line x1={x} x2={x} y1={y(point.high)} y2={y(point.low)} stroke={color} strokeWidth="1" />
                <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={Math.max(1, bodyBottom - bodyTop)} fill={color} />
                <rect x={x - bodyWidth / 2} y={volY(point.volume ?? 0)} width={bodyWidth} height={Math.max(0.5, height - volY(point.volume ?? 0))} fill={color} opacity="0.45" />
                {labelIndexes.includes(index) && (
                  <text x={x} y={height - 4} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[9px]">{point.time}</text>
                )}
              </g>
            );
          })
        )}
      </svg>
    </div>
  );
}
