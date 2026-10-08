import { Button, Select } from '@mantine/core';
import { useMemo, useState } from 'react';
import { FORMAT_NAMES, resolveInputFormat, type InputFormat } from '../input-format';
import type { ReadingDocument } from '../model';

export function InputFormatControl({ text, value, sourceFormat, disabled, onChange }: {
  text: string; value: InputFormat; sourceFormat?: ReadingDocument['format']; disabled?: boolean;
  onChange: (value: InputFormat) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detected = useMemo(() => sourceFormat ?? resolveInputFormat(text, value), [sourceFormat, text, value]);
  const dedicated = detected === 'pdf' || detected === 'aozora';
  return <div className="input-format-control">
    <div className="input-format-result"><span role="status">形式：{value === 'auto' ? '自動判定' : '手動指定'} · {FORMAT_NAMES[detected]}</span>
      {!dedicated && <Button variant="subtle" size="sm" aria-expanded={expanded} disabled={disabled} onClick={() => setExpanded(previous => !previous)}>変更</Button>}
    </div>
    {!dedicated && expanded && <Select label="貼り付け形式" data={[{ value: 'auto', label: '自動判定' }, { value: 'md', label: 'Markdown' }, { value: 'txt', label: 'テキスト' }]} value={value} allowDeselect={false} disabled={disabled} onChange={choice => { if (choice === 'auto' || choice === 'md' || choice === 'txt') onChange(choice); }} />}
    {dedicated && <p className="input-note">元ファイルの専用形式で取り込んでいます。本文を編集すると、貼り付けた文章として判定し直します。</p>}
    {!dedicated && expanded && <p className="input-note">見出し・リンクなどから判定します。記号をそのまま読む場合は「テキスト」を選べます。元の入力は保持します。</p>}
  </div>;
}
