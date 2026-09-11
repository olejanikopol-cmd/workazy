import { useState } from 'react';
import { StyleSheet } from 'react-native';
import AppText from '@/components/AppText';
import Screen from '@/components/Screen';
import SectionIntro from '@/components/SectionIntro';
import SegmentedControl from '@/components/SegmentedControl';
import { spacing } from '@/theme';

type RecordsSegment = 'journal' | 'ideas';

const recordsSegments = [
  { value: 'journal', label: 'Дневник' },
  { value: 'ideas', label: 'Идеи' },
] as const;

const recordsIntros: Record<RecordsSegment, { title: string; description: string }> = {
  journal: {
    title: 'Дневник',
    description: 'Здесь будут записи, настроение, теги и история.',
  },
  ideas: {
    title: 'Идеи',
    description: 'Здесь будут идеи с их категориями и статусами.',
  },
};

/** Records workspace: Дневник / Идеи switch and intro card. */
export default function RecordsScreen() {
  const [segment, setSegment] = useState<RecordsSegment>('journal');
  const intro = recordsIntros[segment];

  return (
    <Screen scroll contentContainerStyle={styles.content}>
      <AppText variant="pageTitle">Записи</AppText>
      <SegmentedControl items={recordsSegments} value={segment} onChange={setSegment} />
      <SectionIntro title={intro.title} description={intro.description} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
});