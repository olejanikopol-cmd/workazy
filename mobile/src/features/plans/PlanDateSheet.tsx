import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppText from '@/components/AppText';
import ProductButton from '@/components/ProductButton';
import { isoToLocalDate, localDateToIso } from '@/features/calendar/calendarDates';
import { colors, radius, spacing, touchTarget } from '@/theme';
import { isValidIsoDate } from './planDates';

/** Exact text entry covers the full domain range independently of native picker limits. */
export default function PlanDateSheet({ initialDate, onSelect, onClose }: {
  initialDate: string;
  onSelect(date: string): void;
  onClose(): void;
}) {
  const [date, setDate] = useState(initialDate);
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isValidIsoDate(date);
  // Keep the optional native picker in a conservative range. Exact entry is
  // always available; an out-of-range stored date is never clamped or remapped.
  const pickerSafe = valid && date >= '1900-01-01' && date <= '2100-12-31';
  return (
    <Modal presentationStyle="fullScreen" animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <AppText variant="section" accessibilityRole="header">Дата плана</AppText>
            <AppText color="secondary">Введите дату в формате ГГГГ-ММ-ДД (0001–9999).</AppText>
            <TextInput accessibilityLabel="Дата плана" value={date}
              onChangeText={(value) => { setDate(value); setShowPicker(false); setError(null); }}
              keyboardType="numbers-and-punctuation" style={styles.input} />
            {error ? <AppText accessibilityRole="alert" color="danger">{error}</AppText> : null}
            {pickerSafe ? <ProductButton label="Открыть календарь" secondary onPress={() => setShowPicker(true)} /> : null}
            {showPicker && pickerSafe ? <DateTimePicker
              value={isoToLocalDate(date)} mode="date" themeVariant="dark"
              minimumDate={isoToLocalDate('1900-01-01')} maximumDate={isoToLocalDate('2100-12-31')}
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onChange={(event, selected) => {
                if (Platform.OS === 'android') setShowPicker(false);
                if (event.type === 'dismissed' || !selected) return;
                const next = localDateToIso(selected);
                if (isValidIsoDate(next)) { setDate(next); setError(null); }
              }} /> : null}
            <ProductButton label="Показать день" onPress={() => {
              if (!isValidIsoDate(date)) { setError('Введите существующую дату в формате ГГГГ-ММ-ДД.'); return; }
              onSelect(date);
            }} />
            <ProductButton label="Отмена" secondary onPress={onClose} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg },
  input: { minHeight: touchTarget, borderRadius: radius.input, padding: spacing.md,
    color: colors.textPrimary, backgroundColor: colors.surface, fontSize: 17 },
});
