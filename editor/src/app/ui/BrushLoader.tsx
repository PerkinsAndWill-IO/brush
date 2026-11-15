/**
 * Loading mark: the Brush logo with its five letters drifting apart and back
 * together in an endless loop. Used wherever the app waits on a file (opening a
 * PDF or .drawing, downloading a sample, rendering a sheet, reading a photo).
 *
 * No animation library (AGENTS.md rule 6): each letter is the logo image
 * clipped to that letter's column, moved by a CSS keyframe that reads its
 * offset and tilt from custom properties. The pattern is "harmonic": letters
 * spread outward from the middle (outer letters furthest), alternate up/down
 * and tilt in alternate directions, with staggered timing so the word breathes
 * like a wave. It is also random: at every return to the assembled pose the
 * letter picks fresh offsets, so no two cycles look the same and the swap is
 * seamless (the keyframe starts and ends at rest).
 */
import { useCallback, useState, type AnimationEvent, type CSSProperties } from 'react'
import brushLogo from './assets/brush-logo.png'
import brushLogoRed from './assets/brush-logo-red.png'

/** Letter columns in the logo image (1635 px wide), as % from the left and right edges. */
const LETTERS = [
  { left: 0, right: 82.0 }, // B
  { left: 18.6, right: 60.4 }, // R
  { left: 40.6, right: 41.3 }, // U
  { left: 59.6, right: 23.5 }, // S
  { left: 77.4, right: 0 }, // H
] as const

interface Pose {
  dx: number // % of logo width
  dy: number // % of logo height
  rot: number // degrees
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

function scatter(i: number): Pose {
  const c = (i - (LETTERS.length - 1) / 2) / ((LETTERS.length - 1) / 2) // -1 … 1, 0 in the middle
  const alt = i % 2 === 0 ? 1 : -1
  return {
    dx: c * rand(4, 9) + rand(-1.5, 1.5),
    dy: alt * rand(8, 18) * (Math.random() < 0.2 ? -1 : 1),
    rot: alt * rand(6, 20) + c * rand(0, 8),
  }
}

export function BrushLoader({ tone = 'blue', label = 'Loading', className }: { tone?: 'blue' | 'red'; label?: string; className?: string }) {
  const src = tone === 'red' ? brushLogoRed : brushLogo
  const [poses, setPoses] = useState<Pose[]>(() => LETTERS.map((_, i) => scatter(i)))
  const reshuffle = useCallback((i: number) => (e: AnimationEvent) => {
    if (e.target !== e.currentTarget) return
    setPoses((p) => p.map((q, j) => (j === i ? scatter(i) : q)))
  }, [])

  return (
    <span className={`brush-loader${className ? ` ${className}` : ''}`} role="status" aria-label={label} data-testid="brush-loader">
      {/* sizes the box to the logo's aspect ratio */}
      <img className="brush-loader-sizer" src={src} alt="" aria-hidden="true" />
      {LETTERS.map((l, i) => (
        <img
          key={i}
          className="brush-loader-letter"
          src={src}
          alt=""
          aria-hidden="true"
          onAnimationIteration={reshuffle(i)}
          style={
            {
              clipPath: `inset(0 ${l.right}% 0 ${l.left}%)`,
              transformOrigin: `${(l.left + 100 - l.right) / 2}% 50%`,
              '--dx': `${poses[i].dx}%`,
              '--dy': `${poses[i].dy}%`,
              '--rot': `${poses[i].rot}deg`,
              animationDelay: `${i * 0.09}s`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  )
}
