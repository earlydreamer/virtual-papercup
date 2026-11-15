import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, loadPreferences, parsePreferences, qualityPixelRatio, resetPresentation, savePreferences } from '../src/preferences.ts';

test('저장된 선택값을 복원하고 꺼진 알림도 유지한다', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const preferences = { ...DEFAULT_PREFERENCES, renderMode: '2d' as const, quality: 'economy' as const, sound: false, vibration: false, fill: 45, keepFill: true };
  assert.equal(savePreferences(storage, preferences), true);
  assert.deepEqual(loadPreferences(storage), preferences);
});

test('기존 2D 선택을 이어받되 새 설정이 있으면 새 값을 우선한다', () => {
  assert.equal(loadPreferences({ getItem: key => key === 'papercup-render-mode' ? '2d' : null }).renderMode, '2d');
  assert.equal(loadPreferences({ getItem: key => key === PREFERENCES_KEY ? '{"renderMode":"3d"}' : '2d' }).renderMode, '3d');
});

test('손상된 저장값과 저장소 접근 실패에도 기본 설정으로 사용할 수 있다', () => {
  assert.deepEqual(loadPreferences({ getItem: () => '{broken' }), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences({ getItem: () => { throw new Error('blocked'); } }), DEFAULT_PREFERENCES);
  assert.equal(savePreferences({ setItem: () => { throw new Error('full'); } }, { ...DEFAULT_PREFERENCES }), false);
});

test('유효한 설정만 받아들이고 물 높이 범위와 자료형을 검증한다', () => {
  for (const value of [null, [], '3d', { fill: Infinity }, { fill: -3 }, { fill: 200 }]) {
    assert.deepEqual(parsePreferences(value), DEFAULT_PREFERENCES);
  }
  const result = parsePreferences({ sound: 'false', keepFill: 1, quality: 'ultra', fill: 41.6, extra: 'ignore' });
  assert.deepEqual(result, { ...DEFAULT_PREFERENCES, fill: 42 });
});

test('화면·알림 기본값 복원은 다음 측정의 물 설정을 보존한다', () => {
  const result = resetPresentation({ ...DEFAULT_PREFERENCES, renderMode: '2d', sound: false, cameraLocked: true, fill: 88, keepFill: true });
  assert.deepEqual(result, { ...DEFAULT_PREFERENCES, fill: 88, keepFill: true });
});

test('선명도는 해상도 상한을 적용하며 잘못된 화면 배율도 처리한다', () => {
  assert.equal(qualityPixelRatio('economy', 3), 1);
  assert.equal(qualityPixelRatio('balanced', 3), 1.75);
  assert.equal(qualityPixelRatio('high', 3), 2);
  assert.equal(qualityPixelRatio('high', 1), 1);
  assert.equal(qualityPixelRatio('high', NaN), 1);
});

test('물 높이 유지는 기본으로 켜지고 저장된 선택은 그대로 복원한다', () => {
  assert.equal(loadPreferences({ getItem: () => null }).keepFill, true);
  assert.equal(loadPreferences({ getItem: key => key === PREFERENCES_KEY ? '{"keepFill":false}' : null }).keepFill, false);
  assert.equal(loadPreferences({ getItem: key => key === PREFERENCES_KEY ? '{"keepFill":true}' : null }).keepFill, true);
  assert.equal(loadPreferences({ getItem: key => key === PREFERENCES_KEY ? '{"renderMode":"2d"}' : null }).keepFill, true);
});
