import type { AiService } from './types';
import { AnthropicAiService } from './anthropic';

export * from './types';
export { AnthropicAiService };

let instance: AiService | null = null;

/**
 * The app's AI service. Adding a vendor means adding a case here — every
 * caller keeps working unchanged because they only depend on the interface.
 */
export function getAiService(): AiService {
  instance ??= new AnthropicAiService();
  return instance;
}

/** Test seam: inject a fake without touching the modules under test. */
export function setAiService(service: AiService): void {
  instance = service;
}
