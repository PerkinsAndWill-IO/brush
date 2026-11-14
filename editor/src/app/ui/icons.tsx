/** Inline SVG icons from the design canvas (docs/design/project/*.dc.html). */
import type { ReactNode } from 'react'

function Icon({ size = 20, sw = 1.7, children }: { size?: number; sw?: number; children: ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export const SelectIcon = () => (
  <Icon>
    <path d="M5 3l11 6.5-5 1.5-1.5 5z" />
  </Icon>
)
export const BrushIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M14.5 3.5l2 2L7 15l-3 1 1-3z" />
    <path d="M12.5 5.5l2 2" />
  </Icon>
)
export const EraserIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9 16h7" />
    <path d="M4.5 12.5l7-7a1.5 1.5 0 0 1 2 0l2 2a1.5 1.5 0 0 1 0 2L10 15H7z" />
  </Icon>
)
export const PanIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M10 3v14M3 10h14M8 5l2-2 2 2M8 15l2 2 2-2M5 8l-2 2 2 2M15 8l2 2-2 2" />
  </Icon>
)
export const UndoIcon = () => (
  <Icon size={18}>
    <path d="M7 5L3.5 8.5 7 12" />
    <path d="M4 8.5h7.5a4 4 0 0 1 0 8H9" />
  </Icon>
)
export const RedoIcon = () => (
  <Icon size={18}>
    <path d="M13 5l3.5 3.5L13 12" />
    <path d="M16 8.5H8.5a4 4 0 0 0 0 8H11" />
  </Icon>
)
export const ChevronDown = () => (
  <Icon size={12} sw={1.8}>
    <path d="M5 8l5 5 5-5" />
  </Icon>
)
export const ChevronRight = ({ open }: { open: boolean }) => (
  <svg aria-hidden="true" width={11} height={11} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
    <path d="M7 4l6 6-6 6" />
  </svg>
)

export const EmptyIllustration = () => (
  <svg aria-hidden="true" width="88" height="70" viewBox="0 0 88 70" fill="none">
    <rect x="6" y="10" width="68" height="54" rx="2" fill="#FFFFFF" stroke="#8A9099" strokeWidth="1.2" />
    <rect x="14" y="4" width="68" height="54" rx="2" fill="#FFFFFF" stroke="#1B1D21" strokeWidth="1.4" />
    <path d="M66 4V58M66 46H82" stroke="#1B1D21" strokeWidth="1" />
    <rect x="21" y="12" width="38" height="38" stroke="#1B1D21" strokeWidth="2.2" />
    <path d="M40 12V31M21 31H50" stroke="#1B1D21" strokeWidth="1.4" />
    <circle cx="70" cy="58" r="13" fill="var(--accent)" />
    <path d="M70 52V64M65 59l5 5 5-5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const MeasureIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M2.5 13.5l11-11 4 4-11 11z" />
    <path d="M6 10l1.5 1.5M8.5 7.5l1.5 1.5M11 5l1.5 1.5" />
  </Icon>
)
export const MenuIcon = () => (
  <Icon size={18}>
    <path d="M3.5 5.5h13" />
    <path d="M3.5 10h13" />
    <path d="M3.5 14.5h13" />
  </Icon>
)
