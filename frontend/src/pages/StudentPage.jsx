import React from 'react';
import LevelPage from './LevelPage.jsx';
import TopicPage from './TopicPage.jsx';

export default function StudentPage(props) {
  return (
    <main className="studentPage">
      <LevelPage {...props} onSelectLevel={props.selectLevel} />
      <TopicPage
        topics={props.topics}
        currentTopic={props.currentTopic}
        onOpenTopic={props.openTopic}
        onOpenFinal={props.openFinal}
        finalUnlocked={props.finalUnlocked}
      />
    </main>
  );
}
