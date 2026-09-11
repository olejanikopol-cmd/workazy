import { StyleSheet } from 'react-native';
import AppText from '@/components/AppText';
import Card from '@/components/Card';
import { colors, spacing } from '@/theme';

type SectionIntroProps = {
  title: string;
  description: string;
  /** Semantic mint tint reserved for Finance. */
  financeTint?: boolean;
};

/**
 * Honest informational card: no hidden actions, no fictitious data.
 */
export default function SectionIntro({
  title,
  description,
  financeTint = false,
}: SectionIntroProps) {
  return (
    <Card style={financeTint ? styles.financeCard : undefined}>
      <AppText variant="label" color={financeTint ? 'success' : 'accent'}>
        {title}
      </AppText>
      <AppText variant="body" color="secondary" style={styles.description}>
        {description}
      </AppText>
    </Card>
  );
}

const styles = StyleSheet.create({
  description: {
    marginTop: spacing.xs,
  },
  financeCard: {
    borderColor: colors.successBorder,
  },
});