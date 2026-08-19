import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 加载等待提示：3×3 像素网格动画（Drive 方块 / Dots 圆点 / Orbit 彗星环绕）
 * + 微光渐变标签 + 实时计时器。设计参考 beautifului.dev 的 Loading State。
 * prefers-reduced-motion 下网格冻结为暗态，计时器仍工作。
 */

const chevron = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, index) => {
  const position = ORBIT_ORDER.indexOf(index);
  return position === -1 ? null : position * 110;
});

const PATTERNS = {
  Drive: { delays: chevron, duration: 650, round: false },
  Dots: { delays: chevron, duration: 650, round: true },
  Orbit: { delays: orbit, duration: 950, round: false },
} as const;

export type LoadingVariant = keyof typeof PATTERNS;

function useElapsed() {
  const [tenths, setTenths] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTenths((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, []);
  const total = tenths / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export function LoadingState({
  label = "正在加载",
  variant = "Drive",
  className,
}: {
  label?: string;
  variant?: LoadingVariant;
  className?: string;
}) {
  const elapsed = useElapsed();
  const { delays, duration, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-2.5", className)}>
      <span aria-hidden="true" className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {delays.map((delay, index) => (
          <span
            key={index}
            className={cn("size-[4px] bg-foreground", round ? "rounded-full" : "rounded-[1px]")}
            style={{
              opacity: delay === null ? 0.07 : 0.15,
              animation: delay === null ? "none" : `pixel-on ${duration}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <span className="loading-shimmer text-[13px] font-medium">{label}</span>
      <span className="font-mono text-xs text-muted-foreground tabular">{elapsed}</span>
    </div>
  );
}
