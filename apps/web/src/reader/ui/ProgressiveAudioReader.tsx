import { Alert } from '@mantine/core';
import type { ComponentProps, ReactNode } from 'react';
import type { AudioBookManifest } from '../../generation/contracts';
import { useProgressiveBook } from '../progressive-session';
import { AudioReader } from './AudioReader';

type Props = Omit<ComponentProps<typeof AudioReader>, 'book' | 'generationStatus' | 'localTools'> & {
  book: AudioBookManifest;
  requestedJobId?: string;
  renderTools?: (book: AudioBookManifest) => ReactNode;
};
export function ProgressiveAudioReader({ book: initial, requestedJobId, renderTools, ...props }: Props) {
  const { book, job, error } = useProgressiveBook(initial, requestedJobId);
  return <>
    {error && <Alert color="yellow" role="status">{error}</Alert>}
    <AudioReader {...props} book={book} generationStatus={job?.status} localTools={renderTools?.(book)} />
  </>;
}
