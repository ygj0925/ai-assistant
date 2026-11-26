import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleLesson, gradeLesson, parseLessonJson } from '../dist/index.js';

test('grades the same imported lesson and normalizes text, radio, and full-width input', () => {
  const lesson = parseLessonJson(JSON.stringify(exampleLesson));
  assert.deepEqual(lesson, exampleLesson);
  assert.deepEqual(gradeLesson(lesson, ['2', '２']), { answers: [2, 2], correct: 2 });
  assert.deepEqual(gradeLesson(lesson, ['2', '1']), { answers: [2, 1], correct: 1 });
  assert.deepEqual(gradeLesson(lesson, ['２', '４']), { invalidQuestion: 1 });
});

test('bounds JSON bytes and rejects unknown fields before delivering a lesson', () => {
  assert.throws(() => parseLessonJson(JSON.stringify({ ...exampleLesson, script: 'fixture' })), /多余字段/);
  assert.throws(() => parseLessonJson(JSON.stringify({ ...exampleLesson, title: '字'.repeat(6000) })), /16 KiB/);
});
