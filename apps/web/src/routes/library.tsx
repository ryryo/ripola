import { createFileRoute } from '@tanstack/react-router';
import { LibraryApp } from '../generation-ui/LibraryApp';
export const Route = createFileRoute('/library')({ component: LibraryApp });
