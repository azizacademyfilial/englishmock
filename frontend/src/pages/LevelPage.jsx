import React from 'react';
import { hasOpenedLevel, NOT_READY_LEVELS } from '../utils/levelAccess.js';

export default function LevelPage({ content, progress, user, subject, level, onSelectLevel }) {
  const levels = content?.levels || ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate'];
  const subjectAccess = progress?.access?.[subject] || {};
  const unlockedFromUser = Array.isArray(user?.unlockedLevels) ? user.unlockedLevels : [];

  return (
    <section className="levelPage">
      <div className="sectionHead">
        <div>
          <span className="eyebrow">Darajalar</span>
          <h1>O‘quv darajasini tanlang</h1>
        </div>
      </div>
      <div className="levelGrid">
        {levels.map(lv => {
          const adminOpen = hasOpenedLevel(subjectAccess, unlockedFromUser, lv, levels);
          const locked = !adminOpen && NOT_READY_LEVELS.includes(lv);
          return (
            <button
              key={lv}
              type="button"
              className={`levelCard ${level === lv ? 'active' : ''} ${adminOpen ? 'open' : 'locked'}`}
              disabled={locked}
              onClick={() => onSelectLevel?.(lv)}
            >
              <b>{lv}</b>
              <span>{adminOpen ? 'Admin tomonidan ochilgan' : locked ? 'Ishlanmoqda' : 'Test orqali ochiladi'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
