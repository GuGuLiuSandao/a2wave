/**
 * BrandWaveField — an animated signal field for the login / setup left panel.
 * Soft, near-straight semantic-color bands drift seamlessly across the active
 * theme's authentication panel, plus a slow bloom and an oscilloscope-style
 * scan sweep. Pure CSS/SVG (no canvas, no deps). Respects reduced motion via
 * the .wave-* classes in globals.css.
 */

/** One horizontal sine path tiled twice end-to-end so the drift loops seamlessly. */
function wavePath(amp: number, periods: number, phase: number, mid: number): string {
  // viewBox is 0..200 wide (two 100-unit tiles) so translateX(-50%) is seamless.
  const steps = 96
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * 200
    const y = mid + amp * Math.sin((x / 100) * periods * Math.PI * 2 + phase)
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return `M${pts.join(' L')}`
}

interface Layer {
  amp: number
  periods: number
  phase: number
  mid: number
  width: number
  opacity: number
  duration: number
  color: string
}

// Same signal field, but each line is widened into a soft BAND (thick stroke +
// low opacity). Depth-sorted from faint/back to bright/front; cool-tech hues.
// `periods` MUST be integers: the wave is drawn across two tiles and drifts by
// exactly one (translateX -50%), so an integer period makes x=0 meet x=100
// seamlessly — the loop is perfectly continuous, no jump/restart.
// Band widths kept within ~10% of each other (9 → 10) so the field reads as
// uniform ribbons. Low amplitude + long wavelength (periods=1) makes the bands
// gently sloping and stretched — nearly straight, with wide peak-to-trough gaps.
// `periods` stays an integer so the drift loop is seamless.
const LAYERS: Layer[] = [
  {
    amp: 5,
    periods: 1,
    phase: 0.0,
    mid: 34,
    width: 9.5,
    opacity: 0.11,
    duration: 40,
    color: 'var(--color-primary)',
  },
  {
    amp: 6,
    periods: 1,
    phase: 1.1,
    mid: 50,
    width: 10,
    opacity: 0.1,
    duration: 52,
    color: 'var(--color-interactive-foreground)',
  },
  {
    amp: 5,
    periods: 1,
    phase: 2.3,
    mid: 64,
    width: 9,
    opacity: 0.12,
    duration: 46,
    color: 'var(--color-brand-panel-foreground)',
  },
  {
    amp: 7,
    periods: 1,
    phase: 0.6,
    mid: 48,
    width: 9.5,
    opacity: 0.16,
    duration: 34,
    color: 'var(--color-gradient-accent)',
  },
]

export function BrandWaveField() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* faint measurement grid */}
      <div className="brand-wave-grid absolute inset-0" />

      {/* soft emitted bloom behind the focus wave — the only "fill", and it's faint */}
      <div className="brand-wave-bloom wave-bloom absolute left-1/2 top-1/2 h-[55%] w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl" />

      {/* the signal field */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <title>signal field</title>
        {LAYERS.map((l, i) => (
          <g
            key={l.mid + l.phase}
            className="wave-layer"
            style={{
              animation: `wave-drift ${l.duration}s linear infinite`,
              // alternate a couple layers in reverse for cross-drift interference
              animationDirection: i % 2 === 0 ? 'normal' : 'reverse',
            }}
          >
            <path
              d={wavePath(l.amp, l.periods, l.phase, l.mid)}
              fill="none"
              stroke={l.color}
              strokeWidth={l.width}
              strokeOpacity={l.opacity}
              strokeLinecap="round"
            />
          </g>
        ))}
      </svg>

      {/* oscilloscope trigger sweep */}
      <div className="brand-wave-scanline wave-scanline absolute inset-y-0 w-px" />

      {/* thin frame so the field reads as an instrument screen */}
      <div className="absolute inset-4 rounded-lg border border-brand-panel-foreground/5" />
    </div>
  )
}
