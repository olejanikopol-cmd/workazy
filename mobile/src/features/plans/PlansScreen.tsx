import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import SegmentedControl from '@/components/SegmentedControl';
import GoalsView from '@/features/goals/GoalsView';
import SettingsButton from '@/features/product/SettingsButton';
import { spacing } from '@/theme';
import PlanDayView from './PlanDayView';
import { planSegments } from './plansProduct';
import { usePlanDay } from './usePlanDay';

type PlanSegment = 'plan' | 'goals';

/** Native Plans contains the daily Plan and persisted Goals. */
export default function PlansScreen() {
  const [segment, setSegment] = useState<PlanSegment>('plan');
  const day = usePlanDay();

  return (
    <Screen>
      <View style={styles.content}>
        <View style={styles.toolbar}>
          <AppText variant="label" color="muted">
            Workazy
          </AppText>
          <SettingsButton />
        </View>
        <SegmentedControl items={planSegments} value={segment} onChange={setSegment} />
        {segment === 'plan' ? <PlanDayView day={day} /> : <GoalsView today={day.today} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  content: {
    flex: 1,
  },
});
