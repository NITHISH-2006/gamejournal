/**
 * Animated ambient background.
 *
 * Provides the coloured light sources that the glass surfaces refract. The
 * three orbs drift on long, offset cycles so the page never visibly loops.
 * Rendered once in the root layout and marked `aria-hidden` / `pointer-events-none`.
 *
 * Honours prefers-reduced-motion via the global CSS rule in globals.css.
 */
export default function Ambient() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      <div
        className="orb animate-float-a"
        style={{
          top: '-12%',
          left: '-6%',
          width: '46rem',
          height: '46rem',
          background:
            'radial-gradient(circle, oklch(0.65 0.21 293 / 0.5), transparent 68%)',
        }}
      />
      <div
        className="orb animate-float-b"
        style={{
          top: '-6%',
          right: '-10%',
          width: '40rem',
          height: '40rem',
          background:
            'radial-gradient(circle, oklch(0.68 0.2 330 / 0.4), transparent 68%)',
        }}
      />
      <div
        className="orb animate-float-c"
        style={{
          bottom: '-18%',
          left: '32%',
          width: '44rem',
          height: '44rem',
          background:
            'radial-gradient(circle, oklch(0.7 0.17 200 / 0.28), transparent 70%)',
        }}
      />

      {/* Fine grain: stops the large gradients from banding on wide gamut displays. */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  );
}
