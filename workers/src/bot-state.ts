import { DurableObject } from "cloudflare:workers";
import { SqliteBotRepository, type BotRepository } from "./repository";
import type { SchemaSnapshot } from "./schema";
import type { KeywordSelect, KeywordSelectResult } from "./keywords";
import type { ColdKeywordMeasure, KeywordCacheStats, KeywordMeasure, KeywordProfile, KeywordSeed } from "./repository";
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

  async countSettings(key: SettingsKey): Promise<number> {
    return this.repo.countSettings(parseSettingsKey(key));
  }

  async inspectSchema(): Promise<SchemaSnapshot> {
    return this.repo.inspectSchema();
  }

  async putKeywords(rows: KeywordSeed[]): Promise<void> {
    await this.repo.putKeywords(rows);
  }

  async deleteKeyword(id: string, keyword: string): Promise<void> {
    await this.repo.deleteKeyword(id, keyword);
  }

  async anchorLengths(): Promise<number[]> {
    return this.repo.anchorLengths();
  }

  async selectKeywordReplies(query: KeywordSelect): Promise<KeywordSelectResult> {
    return this.repo.selectKeywordReplies(query);
  }

  async measureKeywordSelect(query: KeywordSelect, rounds: number): Promise<KeywordMeasure> {
    return this.repo.measureKeywordSelect(query, rounds);
  }

  async profileKeywordSelect(query: KeywordSelect): Promise<KeywordProfile> {
    return this.repo.profileKeywordSelect(query);
  }

  async measureColdRequest(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure> {
    return this.repo.measureColdRequest(query, rounds);
  }

  async keywordCacheStats(): Promise<KeywordCacheStats> {
    return this.repo.keywordCacheStats();
  }
}
