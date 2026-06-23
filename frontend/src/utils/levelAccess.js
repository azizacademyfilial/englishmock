export const LEVELS = ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate'];
export const NOT_READY_LEVELS = ['Intermediate'];

export function normalizeLevelName(value, availableLevels = LEVELS) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '');
  return availableLevels.find(level => level.toLowerCase().replace(/\s+/g, '') === compact) || '';
}

export function hasOpenedLevel(accessMap = {}, unlockedLevels = [], levelName, availableLevels = LEVELS) {
  if (levelName === 'Beginner') return true;
  if (accessMap?.[levelName] === true) return true;
  const normalized = (Array.isArray(unlockedLevels) ? unlockedLevels : [])
    .map(item => normalizeLevelName(item, availableLevels))
    .filter(Boolean);
  return normalized.includes(levelName);
}

export function getAutoOpenedLevels(unlockedLevels = []) {
  const set = new Set(['Beginner', ...(Array.isArray(unlockedLevels) ? unlockedLevels : [])]);
  if (set.has('Pre-Intermediate')) set.add('Elementary');
  if (set.has('Intermediate')) {
    set.add('Elementary');
    set.add('Pre-Intermediate');
  }
  return [...set];
}
