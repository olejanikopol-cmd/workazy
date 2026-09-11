/**
 * Workazy color tokens.
 * Derived from `app/globals.css` and the visual references in the harness bundle.
 *
 * Theme: dark, minimal, premium; violet accent; mint reserved for Finance/success.
 */
export const colors = {
  background: '#08090C',
  surface: '#111319',
  surfaceElevated: '#171922',
  surfaceSelected: '#242039',
  border: 'rgba(255, 255, 255, 0.08)',
  borderStrong: 'rgba(255, 255, 255, 0.16)',
  textPrimary: '#F6F7FB',
  textSecondary: '#B0B2BE',
  textMuted: '#888B97',
  accent: '#8D7CFF',
  accentSoft: 'rgba(141, 124, 255, 0.12)',
  success: '#73D6AA',
  financeAccent: '#73D6AA',
  /** Restrained mint border for the Finance intro card. */
  successBorder: 'rgba(115, 214, 170, 0.24)',
  danger: '#EF7186',
  /**
   * Single low-opacity violet header gradient used on the Plans hero.
   * No neon, no repeated glows, no decorative loops.
   */
  headerGradient: {
    from: 'rgba(141, 124, 255, 0.16)',
    to: 'rgba(141, 124, 255, 0)',
  },
} as const;