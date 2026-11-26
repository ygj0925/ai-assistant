import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { components } from '../../../packages/contracts/dist/index.js';
import { palette, styles } from './ui';

type Data = components['schemas'];
type Body = { sheet: Data['Spreadsheet'] } | { presentation: Data['Presentation'] } | { code: Data['CodeDraft'] }
  | { website: Data['WebsiteDraft'] } | { image: { altText: string } } | { content: string };

export function ArtifactBody({ body }: { body: Body }) {
  if ('sheet' in body) return <Spreadsheet sheet={body.sheet} />;
  if ('presentation' in body) return <>
    {body.presentation.slides.map((slide, index) => <View key={index} style={styles.message}>
      <Text style={styles.muted}>{`幻灯片 ${index + 1}`}</Text>
      <Text accessibilityRole="header" style={styles.label}>{slide.title}</Text>
      {slide.bullets.map((bullet, item) => <Text key={item} style={styles.body}>{`• ${bullet}`}</Text>)}
    </View>)}
  </>;
  if ('website' in body) return <View style={styles.message}>
    <Text accessibilityRole="header" style={styles.heading}>{body.website.heading}</Text>
    {!!body.website.introduction && <Text style={styles.body}>{body.website.introduction}</Text>}
    {body.website.sections.map((section, index) => <View key={index} style={styles.message}>
      <Text accessibilityRole="header" style={styles.label}>{section.title}</Text>
      {section.paragraphs.map((paragraph, item) => <Text key={item} style={styles.body}>{paragraph}</Text>)}
    </View>)}
  </View>;
  if ('code' in body) return <View style={styles.message}>
    <Text style={styles.muted}>{body.code.language}</Text>
    <Text style={[styles.body, artifactStyles.source]}>{body.code.source || '此版本为空。'}</Text>
  </View>;
  const text = 'image' in body ? body.image.altText : body.content;
  return <View style={styles.message}><Text style={styles.body}>{text || '此版本为空。'}</Text></View>;
}

function Spreadsheet({ sheet }: { sheet: Data['Spreadsheet'] }) {
  return <View style={styles.message}>
    <Text accessibilityRole="header" style={styles.label}>{sheet.name}</Text>
    <Text style={styles.muted}>{`${sheet.rows.length} 行 · ${sheet.rows[0]?.length ?? 0} 列`}</Text>
    <ScrollView horizontal nestedScrollEnabled accessibilityLabel="工作表单元格，可横向滚动">
      <View>
        <View style={artifactStyles.row}>
          <Text style={artifactStyles.index}>行</Text>
          {sheet.rows[0]?.map((_, column) => <Text key={column} style={artifactStyles.cell}>
            {String.fromCharCode(65 + column)}
          </Text>)}
        </View>
        {sheet.rows.map((row, index) => <View key={index} style={artifactStyles.row}>
          <Text style={artifactStyles.index}>{index + 1}</Text>
          {row.map((value, column) => {
            const description = value === null ? '空值' : typeof value === 'boolean' ? '布尔值' : typeof value === 'number' ? '数字' : '文本';
            const displayed = value === null ? '空值' : String(value);
            return <Text key={column} accessibilityLabel={`${String.fromCharCode(65 + column)}${index + 1} ${description} ${displayed}`}
              style={artifactStyles.cell}>{displayed || '空字符串'}</Text>;
          })}
        </View>)}
      </View>
    </ScrollView>
  </View>;
}

const artifactStyles = StyleSheet.create({
  source: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  index: { color: palette.muted, width: 38, padding: 6, borderWidth: 1, borderColor: palette.line },
  cell: { color: palette.ink, fontSize: 15, width: 128, padding: 8, borderWidth: 1, borderColor: palette.line },
});
