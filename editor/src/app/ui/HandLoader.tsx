/**
 * A hand-drawn loading mark for the start page: a wobbly navy loop that draws and undraws itself while it slowly
 * turns, with a terracotta brush dab. Still (fully drawn) when the user prefers reduced motion.
 */
export function HandLoader({ size = 56 }: { size?: number }) {
  return (
    <svg className="hand-loader" aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" fill="none">
      <path
        className="hand-loader-loop"
        pathLength={100}
        d="M33 8 C 47 7, 57 18, 56 32 C 56 46, 45 57, 31 56 C 17 56, 7 45, 8 31 C 9 18, 19 9, 35 10 C 39 10, 42 11, 45 13"
      />
      <path className="hand-loader-dab" d="M27 33 C 30 29, 33 36, 37 31" />
    </svg>
  )
}
