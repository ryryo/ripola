import { createFileRoute } from '@tanstack/react-router';
import { DistributedBooks } from '../distribution-ui/DistributedBooks';
export const Route = createFileRoute('/books')({ component: DistributedBooks });
