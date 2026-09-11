/**
 * Type variants. Native iOS system font (no downloads).
 * Font metrics keep `fontScale` allowed so large-text accessibility works;
 * no fixed-height containers clipp text.
 */
export const typography = {
  pageTitle: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  section: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  meta: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
} as const;

export type TypographyVariant = keyof typeof typography;