import { Pressable, StyleSheet } from 'react-native';
import { router, Stack } from 'expo-router';
import AppText from '@/components/AppText';
import Card from '@/components/Card';
import Screen from '@/components/Screen';
import { colors, radius, spacing } from '@/theme';

export default function NotFoundScreen() {
  return (
    <Screen scroll contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Страница не найдена' }} />
      <AppText variant="pageTitle">Страница не найдена</AppText>
      <Card>
        <AppText variant="body" color="secondary">
          Здесь пока ничего нет. Вернитесь к плану — он ждёт вас.
        </AppText>
      </Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Вернуться к планам"
        onPress={() => router.replace('/(tabs)/plans')}
        style={({ pressed }) => [
          styles.link,
          pressed && styles.linkPressed,
        ]}
      >
        <AppText variant="label" color="accent" style={styles.linkLabel}>
          К плану
        </AppText>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  link: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  linkPressed: {
    opacity: 0.72,
  },
  linkLabel: {
    textAlign: 'center',
  },
});