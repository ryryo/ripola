import { useEffect, useState } from 'react';
import { audioPositionKey, audioPositionPercent, loadAudioPosition, type AudioPosition } from '../audio-position';
import { bookDurationLabel } from './Bookshelf';

export function BookReadingProgress({ book, incomplete = false, catalogStatus = 'ready' }: { book: { id: string; revision: string; title: string; durationSeconds: number }; incomplete?: boolean; catalogStatus?: 'loading' | 'ready' | 'failed' }) {
  const [position, setPosition] = useState<AudioPosition>();
  const key = audioPositionKey(book);
  useEffect(() => {
    const refresh = () => setPosition(loadAudioPosition(book));
    const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh(); };
    const visible = () => { if (!document.hidden) refresh(); };
    refresh();
    window.addEventListener('storage', storage);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [key]);

  const seconds = position?.status === 'saved' ? position.seconds : 0;
  const available = Number.isFinite(book.durationSeconds) && book.durationSeconds > 0;
  const percent = catalogStatus === 'ready' && position && position.status !== 'unavailable' ? audioPositionPercent(seconds, book.durationSeconds) : undefined;
  const note = catalogStatus === 'failed' ? '進捗を更新できません' : catalogStatus === 'loading' || !position ? '進捗を確認中…' : !available ? '音声を準備中' : position.status === 'unavailable' ? '保存位置を取得できません' : position.status === 'empty' ? '' : `${bookDurationLabel(Math.min(seconds, book.durationSeconds))}から再開`;
  return <div className="bookshelf-progress">
    {available && <span className="bookshelf-book-duration">{bookDurationLabel(book.durationSeconds)}</span>}
    <div className="bookshelf-progress-track" role="progressbar" aria-label={`${book.title}の読書位置`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent === undefined ? note : [`${percent}%`, note, incomplete ? '生成途中の保存済み音声内の位置' : ''].filter(Boolean).join('、')}><span style={{ width: `${percent ?? 0}%` }} /></div>
    {incomplete && available && <span className="bookshelf-book-status">生成途中</span>}
    {note && <p className="bookshelf-progress-note" title={note}>{note}</p>}
    {percent !== undefined && <span className="bookshelf-progress-percent">{percent}%</span>}
  </div>;
}
