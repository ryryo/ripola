import { useEffect, useRef } from 'react';
import type { PlaybackController, PlaybackSnapshot } from '../playback';

/** Only the gauge animates; position text updates when paused or on an action. */
export function PlaybackProgress({ controller, snapshot, characters, totalCharacters }: {
  controller: PlaybackController;
  snapshot: PlaybackSnapshot;
  characters: number;
  totalCharacters: number;
}) {
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const percentage = useRef<HTMLSpanElement>(null);
  const remaining = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let lastPaint = -Infinity;
    // Animate the gauge; keep all surrounding words stable until playback stops.
    const labels = () => {
      const progress = controller.getProgress();
      const percent = Math.round(progress.fraction * 100);
      const seconds = Math.ceil(progress.remainingMs / 1000);
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      const running = snapshot.status === 'playing';
      const percentLabel = running ? '再生中' : `${percent}%`;
      const remainingLabel = running ? '' : snapshot.status === 'completed' ? '読了' : `残り 約${time}`;
      if (percentage.current && percentage.current.textContent !== percentLabel) percentage.current.textContent = percentLabel;
      if (remaining.current && remaining.current.textContent !== remainingLabel) remaining.current.textContent = remainingLabel;
      track.current?.setAttribute('aria-valuenow', String(percent));
      track.current?.setAttribute('aria-valuetext', running ? '再生中。進捗と残り時間は一時停止すると確認できます。' : `再生時間の${percent}%、残り約${time}`);
    };
    const paint = (now: number) => {
      const progress = controller.getProgress();
      if (fill.current) fill.current.style.transform = `scaleX(${progress.fraction})`;
      if (track.current) track.current.dataset.progress = String(progress.fraction);
      lastPaint = now;
    };
    const tick = (now: number) => {
      if (now - lastPaint >= 1000 / 30) paint(now);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      paint(performance.now());
      labels();
      if (snapshot.status === 'playing' && !motion.matches) frame = requestAnimationFrame(tick);
    };
    start();
    const changedMotion = () => start();
    motion.addEventListener('change', changedMotion);
    return () => { cancelAnimationFrame(frame); motion.removeEventListener('change', changedMotion); };
  }, [controller, snapshot]);
  return <div className="reading-progress">
    <div ref={track} className="reading-track" role="progressbar" aria-label="読書の進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
      <div ref={fill} className="reading-fill" style={{ transform: 'scaleX(0)' }} aria-hidden="true" />
    </div>
    <div className="progress-caption"><span><span ref={percentage} className="progress-percentage">0%</span><span className="progress-definition">再生時間</span></span><span ref={remaining}>残り 約0:00</span></div>
    <span className="visually-hidden" data-testid="character-progress">{snapshot.status === 'playing' ? '' : `${characters.toLocaleString()} / ${totalCharacters.toLocaleString()} 字`}</span>
  </div>;
}
