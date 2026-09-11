import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import SectionIntro from '@/components/SectionIntro';
import SegmentedControl from '@/components/SegmentedControl';
import { colors, radius, spacing } from '@/theme';
import PlanDayView from './PlanDayView';
import { usePlanDay } from './usePlanDay';

type PlanSegment = 'plan' | 'tasks' | 'goals';

const planSegments = [
  { value: 'plan', label: 'План' },
  { value: 'tasks', label: 'Задания' },
  { value: 'goals', label: 'Цели' },
] as const;

const deferredIntros: Record<'tasks' | 'goals', { title: string; description: string }> = {
  tasks: {
    title: 'Задания',
    description: 'Здесь появятся задания и назначенные задачи.',
  },
  goals: {
    title: 'Цели',
    description: 'Здесь будут цели по неделям, месяцам и годам.',
  },
};

/**
 * Main Plans workspace: the План / Задания / Цели selector is always visible
 * above the content, so any segment remains reachable. The relative
 * Today/Tomorrow state is owned here (not inside PlanDayView) and given to the
 * plan segment, so switching segments preserves the selected day.
 */
export default function PlansScreen() {
  const [segment, setSegment] = useState<PlanSegment>('plan');
  const day = usePlanDay();

  return (
    <Screen>
      <View style={styles.content}>
        <SegmentedControl items={planSegments} value={segment} onChange={setSegment} />
        {segment === 'plan' ? (
          <PlanDayView day={day} />
        ) : (
          <View style={styles.deferred}>
            <View style={styles.hero}>
              <LinearGradient
                colors={[colors.headerGradient.from, colors.headerGradient.to]}
                style={styles.heroGradient}
              />
              <AppText variant="label" color="accent">
                Планирование
              </AppText>
              <AppText variant="pageTitle">Планы</AppText>
            </View>
            <SectionIntro
              title={deferredIntros[segment].title}
              description={deferredIntros[segment].description}
            />
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  deferred: {
    gap: spacing.lg,
  },
  hero: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: radius.card,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    gap: spacing.xs,
  },
  heroGradient: {
    ...StyleSheet.absoluteFill,
  },
});