/**
 * 雪球品牌图标（内联 SVG，避免依赖外链资源）：
 * 品牌红圆形底 + 白色 S 形雪球标志。
 */
export function XueqiuIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <circle cx="24" cy="24" r="22.5" fill="#E02130" />
      <circle cx="24" cy="24" r="21.5" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="1.4" />
      <path
        d="M14.5 17.2c0-4.4 3.6-7 9-7 4.8 0 9.5 1.8 9.5 6.4 0 7.6-18.4 5.4-18.4 15.4 0 4.4 3.6 6.8 9 6.8 5.2 0 9.4-2.6 9.4-7.2"
        fill="none"
        stroke="#fff"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
