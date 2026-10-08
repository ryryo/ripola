import { createFileRoute } from '@tanstack/react-router';
import { GenerationApp } from '../generation-ui/GenerationApp';
export const Route = createFileRoute('/generate')({ component: GenerationApp });
