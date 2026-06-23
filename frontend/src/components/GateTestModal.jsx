import React, { useMemo, useState } from 'react';

export default function GateTestModal({ test, title = 'Daraja testi', onSubmit, onCancel, submitText = 'Tekshirish' }) {
  const [answers, setAnswers] = useState({});
  const questions = useMemo(() => test?.questions || [], [test]);
  if (!test) return null;

  async function handleSubmit(event) {
    event.preventDefault();
    await onSubmit?.(answers);
  }

  return (
    <div className="gateTestOverlay" role="dialog" aria-modal="true">
      <form className="gateTestCard" onSubmit={handleSubmit}>
        <div className="gateTestHead">
          <div>
            <span className="eyebrow">Ruxsat testi</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="iconBtn" onClick={onCancel}>✕</button>
        </div>

        <div className="gateQuestionList">
          {questions.map((q, index) => (
            <div className="gateQuestion" key={q.id || index}>
              <b>{index + 1}. {q.question || q.text}</b>
              <div className="gateOptions">
                {(q.options || []).map(option => (
                  <label key={option} className="gateOption">
                    <input
                      type="radio"
                      name={`q_${index}`}
                      value={option}
                      checked={answers[index] === option}
                      onChange={() => setAnswers(prev => ({ ...prev, [index]: option }))}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="gateTestActions">
          <button type="button" className="secondaryBtn" onClick={onCancel}>Bekor qilish</button>
          <button type="submit" className="primaryBtn">{submitText}</button>
        </div>
      </form>
    </div>
  );
}
