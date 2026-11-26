import { useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { exampleLesson, gradeLesson, parseLessonJson } from '../../../packages/contracts/dist/index.js';
import { Action, styles } from './ui';

export function Learning({ close }: { close: () => void }) {
  const [lesson, setLesson] = useState(exampleLesson);
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState(() => JSON.stringify(exampleLesson, null, 2));
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<{ answers: number[]; correct: number }>();
  const [invalid, setInvalid] = useState<number>();
  const inputs = useRef<Record<number, TextInput | null>>({});

  function submit() {
    const next = gradeLesson(lesson, lesson.questions.map((_, index) => answers[index]));
    if ('invalidQuestion' in next) {
      setInvalid(next.invalidQuestion);
      inputs.current[next.invalidQuestion]?.focus();
      return;
    }
    Keyboard.dismiss();
    setInvalid(undefined);
    setResult(next);
  }

  function load() {
    try {
      const next = parseLessonJson(source);
      Keyboard.dismiss();
      setLesson(next);
      setAnswers({});
      setResult(undefined);
      setInvalid(undefined);
      setError('');
      setImporting(false);
    } catch (failure) {
      setError(failure instanceof SyntaxError ? 'JSON 格式不正确，请检查后重新导入。'
        : failure instanceof Error ? failure.message : '无法读取课程内容。');
    }
  }

  return <SafeAreaView style={styles.safe} accessibilityViewIsModal>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>学习模式</Text>
        <Action title="返回历史" onPress={close} />
      </View>
      <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.label}>{lesson.title}</Text>
        {lesson.guide.map((line, index) => <Text key={index} style={styles.body}>{line}</Text>)}
        {lesson.chart && <View style={styles.message}>
          <Text accessibilityRole="header" style={styles.label}>{lesson.chart.title}</Text>
          {lesson.chart.points.map(({ label, value }) => <Text key={label} style={styles.body}>
            {label}　{value}{lesson.chart?.unit ? ' ' + lesson.chart.unit : ''}
          </Text>)}
        </View>}
        {lesson.questions.map((question, index) => <View style={styles.message} key={index}>
          <Text accessibilityRole="header" style={styles.label}>{index + 1}. {question.prompt}</Text>
          {question.options.map((option, position) => <Text key={option} style={styles.body}>{position + 1}. {option}</Text>)}
          <TextInput ref={(input) => { inputs.current[index] = input; }} style={styles.input}
            keyboardType="number-pad" maxLength={2} value={answers[index] ?? ''}
            accessibilityLabel={`第 ${index + 1} 题答案序号`}
            placeholder="输入答案序号"
            onChangeText={(value) => {
              setAnswers((current) => ({ ...current, [index]: value }));
              setResult(undefined);
              if (invalid === index) setInvalid(undefined);
            }} />
          {invalid === index && <Text accessibilityLiveRegion="polite" style={styles.error}>请选择第 {index + 1} 题的有效选项。</Text>}
          {result && <Text style={styles.body}>
            {result.answers[index] === question.answer ? '正确。' : '答错了。'}
            {' 正确选项是「' + question.options[question.answer - 1] + '」。' + question.explanation}
          </Text>}
        </View>)}
        <Action primary title="提交答案" onPress={submit} />
        {result && <Text accessibilityLiveRegion="polite" style={styles.label}>答对 {result.correct} / {lesson.questions.length} 题。</Text>}
        <Action title={importing ? '收起课程导入' : '导入课程 JSON'} selected={importing}
          onPress={() => { setImporting((current) => !current); setError(''); }} />
        {importing && <View style={styles.message}>
          <TextInput accessibilityLabel="课程 JSON" style={[styles.input, styles.messageInput]}
            multiline autoCapitalize="none" autoCorrect={false} value={source} maxLength={16384} onChangeText={setSource} />
          <Action title="载入课程" onPress={load} />
          {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        </View>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
