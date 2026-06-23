import React from 'react';

export default function TopicPage({ topics = [], currentTopic, onOpenTopic, onOpenFinal, finalUnlocked }) {
  return (
    <section className="topicPage">
      <div className="sectionHead">
        <div>
          <span className="eyebrow">Mavzular</span>
          <h1>Grammatika va mashqlar</h1>
        </div>
        <button type="button" className="primaryBtn" disabled={!finalUnlocked} onClick={onOpenFinal}>Final test</button>
      </div>

      <div className="topicGrid">
        {topics.map(topic => (
          <button
            key={topic.id || `${topic.level}-${topic.topicNo}`}
            type="button"
            className={`topicCard ${topic.unlocked ? 'open' : 'locked'} ${currentTopic?.id === topic.id ? 'current' : ''}`}
            disabled={!topic.unlocked}
            onClick={() => onOpenTopic?.(topic)}
          >
            <span>{topic.topicNo}</span>
            <b>{topic.title}</b>
            <small>Eng yaxshi natija: {topic.bestScore || 0}%</small>
          </button>
        ))}
      </div>
    </section>
  );
}
