import { Text, type TextProps } from 'react-native';
import type { PropsWithChildren } from 'react';
import { colors, typography, type TypographyVariant } from '@/theme';

export const semanticColors = {
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  muted: colors.textMuted,
  accent: colors.accent,
  success: colors.success,
  danger: colors.danger,
} as const;

export type SemanticColor = keyof typeof semanticColors;

type AppTextProps = PropsWithChildren<
  TextProps & {
    variant?: TypographyVariant;
    color?: SemanticColor;
  }
>;

/**
 * Base text with a named type variant and a semantic color.
 * Font scaling stays enabled (default) for accessibility.
 */
export default function AppText({
  variant = 'body',
  color = 'primary',
  style,
  children,
  ...rest
}: AppTextProps) {
  return (
    <Text
      style={[{ color: semanticColors[color], ...typography[variant] }, style]}
      {...rest}
    >
      {children}
    </Text>
  );
}