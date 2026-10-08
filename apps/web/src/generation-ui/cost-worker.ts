import { countSpokenCharacters, type CostSource } from '../generation/cost-source';
self.onmessage = (event: MessageEvent<CostSource>) => {
  try { self.postMessage({ characters: countSpokenCharacters(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '費用目安を計算できませんでした。' }); }
};
