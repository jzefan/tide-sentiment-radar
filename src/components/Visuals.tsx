import { useRef, useState } from "react";
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
        tone === "mixed" && "bg-warning-soft text-warning",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <i className={cn("size-1.5 rounded-full", tone === "positive" ? "bg-up" : tone === "negative" ? "bg-down" : tone === "mixed" ? "bg-warning" : "bg-muted-foreground")} />
      {toneLabel(tone)}
    </Badge>
  );
}

/**
 * 蜡烛图 / 分时折线图：分时线用折线（line），日/周/月线用蜡烛（candle）。
 * 红涨绿跌沿用 A 股语义色。悬停显示十字光标与当时 OHLC 数值。
 */
export function KlineChart({
  points,
  variant = "candle",
  previousClose = null,
}: {
  points: KlinePoint[];
  variant?: "line" | "candle";
  previousClose?: number | null;
}) {
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (points.length < 2) return null;
  const width = 900;
  const height = 380;
  const padX = 10;
  /** 右侧价格刻度留白，避免数值被裁切。 */
  const padRight = 58;
  const padY = 18;
  const volHeight = 58;
  const gap = 10;
  const plotRight = width - padRight;
  const plotWidth = plotRight - padX;
  const chartHeight = height - volHeight - gap - padY;
  const lows = points.map((point) => point.low);
  const highs = points.map((point) => point.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const maxVolume = Math.max(1, ...points.map((point) => point.volume ?? 0));
  const step = plotWidth / points.length;
  /** 分时横轴拼接上午（09:00–11:30）与下午（13:00–15:00），午休时段不在坐标轴上。 */
  const MORNING_START = 9 * 60;
  const MORNING_END = 11 * 60 + 30;
  const AFTERNOON_START = 13 * 60;
  const CLOSE = 15 * 60;
  const TRADE_MINUTES = (MORNING_END - MORNING_START) + (CLOSE - AFTERNOON_START);
  const minuteOfDay = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return (Number.isFinite(hour) && Number.isFinite(minute)) ? hour * 60 + minute : null;
  };
  const timeX = (time: string) => {
    const minutes = minuteOfDay(time);
    if (minutes === null) return padX + step / 2;
    const offset = minutes <= MORNING_END
      ? minutes - MORNING_START
      : (MORNING_END - MORNING_START) + (minutes - AFTERNOON_START);
    return padX + (offset / TRADE_MINUTES) * plotWidth;
  };
  const xFor = (index: number, time: string) => (variant === "line" ? timeX(time) : padX + step * (index + 0.5));
  const y = (value: number) => padY + (1 - (value - min) / range) * chartHeight;
  const priceAt = (svgY: number) => min + (1 - Math.min(1, Math.max(0, (svgY - padY) / chartHeight))) * range;
  const volY = (volume: number) => height - (volume / maxVolume) * volHeight;
  const bodyWidth = Math.max(1.5, Math.min(9, step * 0.62));
  const linePath = points.map((point, index) => {
    const x = xFor(index, point.time);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y(point.close).toFixed(1)}`;
  }).join(" ");
  const avgPath = points.filter((point) => point.avgPrice !== null && point.avgPrice !== undefined).map((point) => {
    const index = points.indexOf(point);
    const x = xFor(index, point.time);
    return `${x.toFixed(1)},${y(point.avgPrice!).toFixed(1)}`;
  }).join(" L");
  const areaPath = `${linePath} L${plotRight},${height - volHeight - gap} L${padX},${height - volHeight - gap} Z`;
  const gridLevels = [0.25, 0.5, 0.75].map((ratio) => min + range * ratio);
  const labelIndexes = [0, Math.floor(points.length / 2), points.length - 1];
  /** 分时刻度：上午 09:30/10:30/11:30，下午 13:00/14:00/15:00，午休拼接点用竖虚线分隔。 */
  const timelineTicks: Array<{ label: string; x: number; anchor: "start" | "middle" | "end" }> = [
    { label: "09:30", x: timeX("09:30"), anchor: "middle" },
    { label: "10:30", x: timeX("10:30"), anchor: "middle" },
    { label: "11:30", x: timeX("11:30"), anchor: "end" },
    { label: "13:00", x: timeX("13:00"), anchor: "start" },
    { label: "14:00", x: timeX("14:00"), anchor: "middle" },
    { label: "15:00", x: timeX("15:00"), anchor: "end" },
  ];

  const hoveredPoint = hover ? points[hover.index] : null;
  const hoverX = hover && hoveredPoint ? xFor(hover.index, hoveredPoint.time) : 0;
  const hoverPrice = hover ? priceAt(hover.y) : 0;
  /** 分时涨幅相对昨收计算；蜡烛图相对开盘价计算。 */
  const hoverChange = hoveredPoint
    ? variant === "line" && previousClose
      ? ((hoveredPoint.close - previousClose) / previousClose) * 100
      : hoveredPoint.open
        ? ((hoveredPoint.close - hoveredPoint.open) / hoveredPoint.open) * 100
        : 0
    : 0;

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xRatio = (event.clientX - rect.left) / rect.width;
    const yRatio = (event.clientY - rect.top) / rect.height;
    const svgX = xRatio * width;
    const svgY = yRatio * height;
    if (svgX < padX || svgX > plotRight || svgY < padY || svgY > height - volHeight - gap) {
      setHover(null);
      return;
    }
    // 找横坐标最近的 K 线点（分时含午休留白，不能用等距索引推算）
    let index = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < points.length; candidate += 1) {
      const distance = Math.abs(xFor(candidate, points[candidate].time) - svgX);
      if (distance < best) {
        best = distance;
        index = candidate;
      }
    }
    setHover({ index, y: svgY });
  };

  return (
    <div className="relative w-full">
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-up" />涨</span>
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-down" />跌</span>
        <span className="ml-auto font-mono text-[11px] tabular">高 {max.toFixed(2)} · 低 {min.toFixed(2)}</span>
      </div>
      {hover && hoveredPoint && (
        <div className="pointer-events-none absolute right-1 top-8 z-10 min-w-[172px] rounded-md border bg-card/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
          <p className="flex items-center justify-between gap-3 font-mono text-muted-foreground"><span>{hoveredPoint.time}</span><span className={cn("font-medium", hoverChange >= 0 ? "text-up" : "text-down")}>{hoverChange >= 0 ? "+" : ""}{hoverChange.toFixed(2)}%</span></p>
          <dl className="mt-1.5 space-y-0.5">
            {variant === "line" ? (
              <>
                <HoverRow label="价格" value={hoveredPoint.close.toFixed(2)} />
                {previousClose && (
                  <HoverRow
                    label="涨跌"
                    value={`${hoveredPoint.close - previousClose >= 0 ? "+" : ""}${(hoveredPoint.close - previousClose).toFixed(2)}`}
                    tone={hoverChange >= 0 ? "text-up" : "text-down"}
                  />
                )}
                {hoveredPoint.avgPrice !== null && hoveredPoint.avgPrice !== undefined && <HoverRow label="均价" value={hoveredPoint.avgPrice.toFixed(2)} />}
              </>
            ) : (
              <>
                <HoverRow label="开" value={hoveredPoint.open.toFixed(2)} />
                <HoverRow label="高" value={hoveredPoint.high.toFixed(2)} />
                <HoverRow label="低" value={hoveredPoint.low.toFixed(2)} />
                <HoverRow label="收" value={hoveredPoint.close.toFixed(2)} tone={hoverChange >= 0 ? "text-up" : "text-down"} />
              </>
            )}
            {hoveredPoint.volume !== null && <HoverRow label="量" value={formatKlineVolume(hoveredPoint.volume)} />}
          </dl>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="K线图"
        className="h-[300px] w-full cursor-crosshair sm:h-[340px]"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="klineArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.12" />
            <stop offset="1" stopColor="var(--up)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLevels.map((level) => (
          <g key={level}>
            <line x1={padX} x2={plotRight} y1={y(level)} y2={y(level)} className="stroke-border" strokeDasharray="3 5" />
            <text x={width - 8} y={y(level) + 3} textAnchor="end" className="fill-muted-foreground text-[10px] font-mono">{level.toFixed(2)}</text>
          </g>
        ))}
        <text x={width - 8} y={padY + 3} textAnchor="end" className="fill-muted-foreground text-[10px] font-mono">{max.toFixed(2)}</text>
        {variant === "line" ? (
          <>
            <path d={areaPath} fill="url(#klineArea)" />
            <path d={linePath} fill="none" strokeWidth="1.6" className="stroke-up" />
            {avgPath && <path d={`M${avgPath}`} fill="none" strokeWidth="1.2" strokeDasharray="5 4" className="stroke-warning" />}
            {/* 午休拼接分隔线 */}
            <line x1={timeX("11:30")} x2={timeX("11:30")} y1={padY} y2={height - volHeight - gap} className="stroke-border" strokeDasharray="2 4" />
            {timelineTicks.map((tick) => (
              <g key={tick.label}>
                <line x1={tick.x} x2={tick.x} y1={height - volHeight - gap} y2={height - volHeight - gap + 5} className="stroke-border" />
                <text x={tick.x} y={height - volHeight - gap + 16} textAnchor={tick.anchor} className="fill-muted-foreground text-[10px] font-mono">{tick.label}</text>
              </g>
            ))}
          </>
        ) : (
          points.map((point, index) => {
            const x = xFor(index, point.time);
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
                  <text x={x} y={height - 4} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px] font-mono">{point.time}</text>
                )}
              </g>
            );
          })
        )}
        {hover && hoveredPoint && (
          <g className="pointer-events-none">
            <line x1={hoverX} x2={hoverX} y1={padY} y2={height - volHeight - gap} strokeDasharray="3 4" className="stroke-foreground/50" strokeWidth="1" />
            <line x1={padX} x2={plotRight} y1={hover.y} y2={hover.y} strokeDasharray="3 4" className="stroke-foreground/50" strokeWidth="1" />
            <circle cx={hoverX} cy={y(variant === "line" ? hoveredPoint.close : hoveredPoint.close)} r="3.5" className="fill-foreground" />
            <g>
              <rect x={plotRight + 2} y={hover.y - 9} width={padRight - 4} height={18} rx="3" className="fill-foreground" />
              <text x={plotRight + 2 + (padRight - 4) / 2} y={hover.y + 3.5} textAnchor="middle" className="fill-background text-[10px] font-mono">{hoverPrice.toFixed(2)}</text>
            </g>
            <text x={hoverX} y={height - volHeight - gap - 5} textAnchor="middle" className="fill-foreground text-[10px] font-mono">{hoveredPoint.time}</text>
          </g>
        )}
      </svg>
    </div>
  );
}

function HoverRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono font-medium tabular", tone)}>{value}</span>
    </div>
  );
}

function formatKlineVolume(volume: number) {
  if (volume >= 1e8) return `${(volume / 1e8).toFixed(2)}亿`;
  if (volume >= 1e4) return `${(volume / 1e4).toFixed(2)}万`;
  return volume.toFixed(0);
}
