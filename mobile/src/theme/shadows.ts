/**
 * Default is no shadow. A single subtle reusable card shadow is available
 * if a later slice actually needs it; keep the dark UI calm.
 */
export const shadows = {
  none: {},
  subtle: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 24,
    elevation: 6,
  },
} as const;