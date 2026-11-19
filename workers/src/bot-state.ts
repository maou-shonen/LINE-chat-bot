import { applyCountMessage } from "./handler";
import { DurableObject } from "cloudflare:workers";
import {
  parseKeywordDelete,
  parseKeywordLookup,
  parseKeywordWrite,
  parseScopeId,
  SqliteBotRepository,
  type BotRepository,
  type KeywordDelete,
  type KeywordDeleteStatus,
  type KeywordLookup,
  type KeywordSnapshot,
  type KeywordWrite,
  type KeywordWriteStatus,
  type TouchRows,
} from "./repository";
import type { SchemaSnapshot } from "./schema";
import {
  parseSettingsKey,
  parseSettingsPatch,
  type SettingsKey,
  type SettingsPatch,
  type SettingsView,
} from "./settings";

export const GLOBAL_BOT_STATE = "global";

export class BotState extends DurableObject<Env> {
  private readonly repo: BotRepository;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repo = new SqliteBotRepository(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await this.repo.migrate();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response("ok", {
      status: 200,
      headers: { "x-bot-state": "accepted" },
    });
  }

  async migrate(): Promise<void> {
    await this.repo.migrate();
  }

  async getSettings(key: SettingsKey): Promise<SettingsView> {
    return this.repo.getSettings(parseSettingsKey(key));
  }

  async upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void> {
    await this.repo.upsertSettings(parseSettingsKey(key), parseSettingsPatch(patch));
  }

  async omitSettings(key: SettingsKey, names: readonly string[]): Promise<void> {
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new TypeError("omit names must be strings");
    }
    await this.repo.omitSettings(parseSettingsKey(key), names);
  }

  async countSettings(key: SettingsKey): Promise<number> {
    return this.repo.countSettings(parseSettingsKey(key));
  }

  async inspectSchema(): Promise<SchemaSnapshot> {
    return this.repo.inspectSchema();
  }

  async recordMessage(input: unknown, now: unknown): Promise<void> {
    await applyCountMessage(this.repo, input, now);
  }

  async inspectTouch(): Promise<TouchRows> {
    return this.repo.inspectTouch();
  }

  async upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus> {
    return this.repo.upsertKeyword(parseKeywordWrite(input));
  }

  async deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus> {
    return this.repo.deleteKeyword(parseKeywordDelete(input));
  }

  async getKeyword(input: KeywordLookup): Promise<string | null> {
    return this.repo.getKeyword(parseKeywordLookup(input));
  }

  async listKeywords(scopeId: string | null): Promise<string[]> {
    return this.repo.listKeywords(parseScopeId(scopeId));
  }

  async inspectKeywords(): Promise<KeywordSnapshot> {
    return this.repo.inspectKeywords();
  }
}
