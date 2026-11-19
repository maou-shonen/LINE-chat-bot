import { messageCountDelta, parseCountMessage, parseNow } from "./counts";
import type { BotRepository } from "./repository";

export async function applyCountMessage(
  repo: BotRepository,
  input: unknown,
  now: unknown,
): Promise<void> {
  const message = parseCountMessage(input);
  await repo.touchAndCount({
    source: message.source,
    now: parseNow(now),
    delta: messageCountDelta(message),
  });
}
