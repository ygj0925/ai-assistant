import { Text, TextInput } from 'react-native';
import { palette, styles } from './ui';

export const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const zonePattern = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/;

export function validZone(zone: string) {
  if (!zonePattern.test(zone) || zone.length > 64) return false;
  try { Intl.DateTimeFormat('zh-CN', { timeZone: zone }); return true; }
  catch { return false; }
}

export function displayTime(value: string, timeZone?: string) {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(value)); }
  catch { return value; }
}

export function ReminderField({ label, placeholder, value, onChange, limit, editable }: {
  label: string; placeholder?: string; value: string; onChange: (value: string) => void; limit: number; editable: boolean;
}) {
  return <>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholder={placeholder} placeholderTextColor={palette.muted}
      style={styles.input} maxLength={limit} autoCapitalize="none" autoCorrect={false} editable={editable}
      value={value} onChangeText={onChange} />
  </>;
}
