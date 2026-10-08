import { useEffect, useState } from 'react';
import { MAX_TITLE_LENGTH, resolveDocumentTitle } from '../document-title';

export function TitleEditor({ title, onRename }: { title: string; onRename: (title: string) => Promise<void> }) {
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => setDraft(title), [title]);
  return <form className="title-editor" onSubmit={event => {
    event.preventDefault(); if (busy) return;
    let next: string;
    try { next = resolveDocumentTitle(draft); } catch (error) { setNotice(error instanceof Error ? error.message : 'タイトルを確認してください。'); return; }
    setBusy(true); setNotice('');
    void onRename(next).then(() => { setDraft(next); setNotice('名前を変更しました。'); }).catch(error => setNotice(error instanceof Error ? error.message : '名前を変更できませんでした。')).finally(() => setBusy(false));
  }}><label>タイトルを変更<input aria-label="タイトルを変更" value={draft} maxLength={MAX_TITLE_LENGTH} disabled={busy} onChange={event => setDraft(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? '変更中…' : '名前を変更'}</button><p className="input-note">任意。空欄ならこの端末の日付と時刻を使います。本文・音声・読書位置は変えません。</p><p role="status" className="title-status">{notice}</p></form>;
}
