import React from 'react';

export default function AdminLevelConfirmModal({ level, onConfirm, onCancel }) {
  if (!level) return null;
  return (
    <div className="adminLevelConfirmOverlay" role="dialog" aria-modal="true">
      <div className="adminLevelConfirmCard">
        <div className="adminLevelConfirmIcon">✅</div>
        <h2>{level} bo‘limiga o‘tmoqchimisiz?</h2>
        <p>Bu bo‘lim admin tomonidan ochib berilgan. “Ha” bossangiz, ruxsat testisiz mavzularga o‘tasiz.</p>
        <div className="adminLevelConfirmActions">
          <button type="button" className="secondaryBtn" onClick={onCancel}>Yo‘q</button>
          <button type="button" className="primaryBtn" onClick={onConfirm}>Ha, o‘tish</button>
        </div>
      </div>
    </div>
  );
}
