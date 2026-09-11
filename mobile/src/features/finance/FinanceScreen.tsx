import { StyleSheet } from 'react-native';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import SectionIntro from '@/components/SectionIntro';
import { spacing } from '@/theme';

/** Finance workspace shell with semantic mint tint. */
export default function FinanceScreen() {
  return (
    <Screen scroll contentContainerStyle={styles.content}>
      <AppText variant="pageTitle">Финансы</AppText>
      <SectionIntro
        financeTint
        title="Баланс и дневной лимит"
        description="Здесь будут баланс, фиксированный дневной лимит, расходы и обязательства."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
});