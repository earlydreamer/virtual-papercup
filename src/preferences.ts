export type RenderMode = '2d' | '3d';
export type Quality = 'economy' | 'balanced' | 'high';
export interface Preferences {
  renderMode: RenderMode;
  quality: Quality;
  cameraLocked: boolean;
  showGauge: boolean;
  sound: boolean;
  vibration: boolean;
  fill: number;
  keepFill: boolean;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  renderMode: '3d', quality: 'balanced', cameraLocked: false, showGauge: true,
  sound: true, vibration: true, fill: 72, keepFill: false,
};
export const PREFERENCES_KEY = 'papercup-preferences';

export function parsePreferences(value: unknown): Preferences {
  const result = { ...DEFAULT_PREFERENCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const data = value as Record<string, unknown>;
  if (data.renderMode === '2d' || data.renderMode === '3d') result.renderMode = data.renderMode;
  if (data.quality === 'economy' || data.quality === 'balanced' || data.quality === 'high') result.quality = data.quality;
  for (const key of ['cameraLocked', 'showGauge', 'sound', 'vibration', 'keepFill'] as const) {
    if (typeof data[key] === 'boolean') result[key] = data[key];
  }
  if (typeof data.fill === 'number' && Number.isFinite(data.fill) && data.fill >= 30 && data.fill <= 92) result.fill = Math.round(data.fill);
  return result;
}

export function loadPreferences(storage: Pick<Storage, 'getItem'>): Preferences {
  try {
    const saved = storage.getItem(PREFERENCES_KEY);
    if (saved !== null) return parsePreferences(JSON.parse(saved));
    return { ...DEFAULT_PREFERENCES, renderMode: storage.getItem('papercup-render-mode') === '2d' ? '2d' : '3d' };
  } catch { return { ...DEFAULT_PREFERENCES }; }
}

export function savePreferences(storage: Pick<Storage, 'setItem'>, preferences: Preferences): boolean {
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify(parsePreferences(preferences))); return true; }
  catch { return false; }
}

export function resetPresentation(preferences: Preferences): Preferences {
  return { ...DEFAULT_PREFERENCES, fill: preferences.fill, keepFill: preferences.keepFill };
}

export function qualityPixelRatio(quality: Quality, deviceRatio: number): number {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.min(ratio, quality === 'economy' ? 1 : quality === 'high' ? 2 : 1.75);
}
