/**
 * Finance form sheets (Slice 6A): expense/income/obligation/balance/limit/
 * expectation/receipt. Every sheet is keyboard-safe, keeps Save/Cancel reachable,
 * uses a decimal keyboard with a visible currency and never invents money: the
 * entered text is parsed to minor units with the shared integer parser.
 */
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AppText from '@/components/AppText';
import { colors, radius, spacing, touchTarget } from '@/theme';
import type { FinanceCurrency, FinanceLimitMode, FinanceObligationKind } from '@/types/finance';
import { isValidIsoDate } from './financeDates';
import { formatMoneyMinor, parseMoneyToMinor } from './financeMoney';

export type SheetShellProps = {
  title: string;
  subtitle?: string;
  primaryLabel: string;
  onPrimary: () => void;
  onClose: () => void;
  busy: boolean;
  primaryDisabled?: boolean;
  errorText: string | null;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

/** Shared modal shell: persistent reachable Cancel/Save and safe-area padding. */
export function FinanceSheetShell({
  title,
  subtitle,
  primaryLabel,
  onPrimary,
  onClose,
  busy,
  primaryDisabled = false,
  errorText,
  children,
  footer,
}: SheetShellProps) {
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Отмена"
              onPress={onClose}
              style={styles.headerButton}
            >
              <AppText variant="label" color="muted">
                Отмена
              </AppText>
            </Pressable>
            <AppText variant="section">{title}</AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={primaryLabel}
              accessibilityState={{ disabled: busy || primaryDisabled }}
              disabled={busy || primaryDisabled}
              onPress={onPrimary}
              style={styles.headerButton}
            >
              <AppText variant="label" color={busy || primaryDisabled ? 'muted' : 'accent'}>
                {busy ? '…' : primaryLabel}
              </AppText>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            {subtitle === undefined ? null : (
              <AppText variant="meta" color="muted">
                {subtitle}
              </AppText>
            )}
            {errorText === null ? null : (
              <View style={styles.errorBox}>
                <AppText variant="meta" color="danger">
                  {errorText}
                </AppText>
              </View>
            )}
            {children}
            {footer}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

type MoneyFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  currency: FinanceCurrency;
  allowNegative?: boolean;
  placeholder?: string;
};

/** Decimal money input with a visible currency; parsing happens on save. */
export function MoneyField({
  label,
  value,
  onChange,
  currency,
  allowNegative = false,
  placeholder = '0,00',
}: MoneyFieldProps) {
  const parsed = value.trim().length === 0 ? null : parseMoneyToMinor(value);
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <View style={styles.moneyRow}>
        <TextInput
          accessibilityLabel={label}
          keyboardType={allowNegative ? 'numbers-and-punctuation' : 'decimal-pad'}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={styles.moneyInput}
        />
        <AppText variant="body" color="muted">
          {currency}
        </AppText>
      </View>
      {parsed !== null && parsed.ok ? (
        <AppText variant="meta" color="muted">
          {formatMoneyMinor(parsed.amountMinor, currency)}
        </AppText>
      ) : null}
    </View>
  );
}

type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
};

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
}: TextFieldProps) {
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
      />
    </View>
  );
}

/** Validated money text -> minor units, or a Russian error line. */
export function readMoney(
  value: string,
  label: string,
): { ok: true; minor: number } | { ok: false; message: string } {
  const parsed = parseMoneyToMinor(value);
  if (!parsed.ok) {
    const message =
      parsed.error === 'precision'
        ? 'не больше двух знаков после запятой'
        : parsed.error === 'too-large'
          ? 'слишком большая сумма'
          : 'введите сумму, например 350,00';
    return { ok: false, message: `${label}: ${message}.` };
  }
  return { ok: true, minor: parsed.amountMinor };
}

export function readDate(
  value: string,
  label: string,
): { ok: true; date: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!isValidIsoDate(trimmed)) {
    return { ok: false, message: `${label}: дата в формате ГГГГ-ММ-ДД.` };
  }
  return { ok: true, date: trimmed };
}

export function readTime(
  value: string,
): { ok: true; time: string | undefined } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, time: undefined };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    return { ok: false, message: 'Время: формат ЧЧ:ММ, например 09:00.' };
  }
  return { ok: true, time: trimmed };
}

export const OBLIGATION_KIND_LABELS: Record<FinanceObligationKind, string> = {
  payment: 'Платёж',
  debt: 'Я должен',
  receivable: 'Мне должны',
  purchase: 'Покупка',
};

export const LIMIT_MODE_LABELS: Record<FinanceLimitMode, string> = {
  auto: 'Авто',
  manual: 'Ручной',
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headerButton: { minHeight: touchTarget, justifyContent: 'center', minWidth: 64 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.lg },
  field: { gap: spacing.xs },
  input: {
    minHeight: touchTarget,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    color: colors.textPrimary,
    fontSize: 17,
  },
  inputMultiline: { minHeight: 96, paddingTop: spacing.sm, textAlignVertical: 'top' },
  moneyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
  },
  moneyInput: { flex: 1, minHeight: touchTarget, color: colors.textPrimary, fontSize: 17 },
  errorBox: {
    borderRadius: radius.item,
    backgroundColor: colors.surfaceElevated,
    padding: spacing.md,
  },
});
