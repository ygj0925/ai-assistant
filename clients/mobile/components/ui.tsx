import { Pressable, StyleSheet, Text } from 'react-native';

export function Action({ title, onPress, primary, disabled, selected, accessibilityLabel }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean;
  selected?: boolean; accessibilityLabel?: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled: !!disabled, selected }}
    style={({ pressed }) => [styles.button, primary && styles.primary, (pressed || disabled) && styles.dim]}
    disabled={disabled} onPress={onPress}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text>
  </Pressable>;
}

export const palette = {
  canvas: '#f8faf8', surface: '#ffffff', accent: '#dcefe2', ink: '#172821', muted: '#4e6458',
  brand: '#176143', line: '#cbd8cf', danger: '#9e3025',
};

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.canvas },
  center: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, maxWidth: 480, width: '100%', alignSelf: 'center' },
  wordmark: { color: palette.brand, fontSize: 18, fontWeight: '700' },
  heading: { color: palette.ink, fontSize: 25, fontWeight: '700' },
  flexibleHeading: { flex: 1 },
  toolbar: { minHeight: 64, borderBottomWidth: 1, borderColor: palette.line, paddingHorizontal: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { flex: 1, textAlign: 'center', color: palette.ink, fontSize: 16, fontWeight: '600' },
  label: { color: palette.ink, fontWeight: '700', fontSize: 15 },
  body: { color: palette.ink, fontSize: 17, lineHeight: 25 },
  muted: { color: palette.muted, fontSize: 13 },
  error: { color: palette.danger, fontSize: 15 },
  hero: { marginTop: 78, gap: 12 },
  thread: { padding: 16, width: '100%', maxWidth: 760, alignSelf: 'center', gap: 12 },
  message: { backgroundColor: palette.surface, borderColor: palette.line, borderWidth: 1, borderRadius: 16, padding: 14, gap: 9 },
  userMessage: { backgroundColor: palette.accent },
  historyRow: { padding: 12, minHeight: 50, borderRadius: 12, backgroundColor: palette.surface },
  historyTools: { paddingHorizontal: 12, alignSelf: 'flex-start' },
  jobControls: { paddingHorizontal: 16, paddingTop: 8, gap: 6 },
  composer: { paddingHorizontal: 12, paddingVertical: 8, gap: 6, width: '100%', maxWidth: 760, alignSelf: 'center' },
  messageInput: { minHeight: 50, maxHeight: 160, textAlignVertical: 'top' },
  input: { minHeight: 48, borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 12,
    color: palette.ink, backgroundColor: palette.surface, fontSize: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { borderRadius: 10, paddingHorizontal: 12, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: palette.brand, fontSize: 15, fontWeight: '700' },
  primary: { backgroundColor: palette.brand },
  primaryText: { color: palette.surface },
  dim: { opacity: 0.55 },
});
