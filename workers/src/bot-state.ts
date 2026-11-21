import { BlobPutError, parseBlobPut } from "./blob-store";
import { handleCallback, type DispatchEnv } from "./dispatch";
import { applyCountMessage } from "./handler";
import { DurableObject } from "cloudflare:workers";
import {
  IMPORT_SECRET_HEADER,
  ImportBatchError,
  importGate,
  parseImportBatch,
} from "./import-plan";
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
  type FixtureSlices,
  type TouchRows,
  type ColdKeywordMeasure,
  type KeywordAudit,
  type KeywordCacheStats,
  type KeywordCompact,
  type KeywordMeasure,
  type KeywordProfile,
  type KeywordSeed,
  type KeywordWriteMeasure,
  type KeywordWriteSample,
} from "./repository";
import type { SchemaSnapshot } from "./schema";
import type { KeywordSelect, KeywordSelectResult } from "./keywords";
import {
  parseSettingsKey,
  parseSettingsPatch,
  type SettingsKey,
  type SettingsPatch,
  type SettingsView,
} from "./settings";

export const GLOBAL_BOT_STATE = "global";

function parsedBatch(payload: unknown): ReturnType<typeof parseImportBatch> | Response {
  try {
    return parseImportBatch(payload);
  } catch (error) {
    if (error instanceof ImportBatchError) {
      return new Response("invalid batch", { status: 400 });
    }
    throw error;
  }
}

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
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/import") {
      return this.importRequest(request);
    }
    if (request.method === "POST" && url.pathname === "/import/kv") {
      return this.importKv(request);
    }
    if (request.method === "POST" && url.pathname.startsWith("/callback/")) {
      await handleCallback(this.repo, request, this.env as unknown as DispatchEnv);
      return new Response("ok");
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response("ok", {
      status: 200,
      headers: { "x-bot-state": "accepted" },
    });
  }

  private async importRequest(request: Request): Promise<Response> {
    const presented = request.headers.get(IMPORT_SECRET_HEADER);
    const gate = importGate(this.env.IMPORT_SECRET, presented);
    if (gate === "disabled") return new Response("not found", { status: 404 });
    if (gate === "reject") return new Response("unauthorized", { status: 401 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid batch", { status: 400 });
    }
    const batch = parsedBatch(payload);
    if (batch instanceof Response) return batch;
    try {
      const result = await this.repo.importKeywordBatch(batch);
      return Response.json(result);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return new Response("batch rejected", { status: 409 });
    }
  }

  private async importKv(request: Request): Promise<Response> {
    const presented = request.headers.get(IMPORT_SECRET_HEADER);
    const gate = importGate(this.env.IMPORT_SECRET, presented);
    if (gate === "disabled") return new Response("not found", { status: 404 });
    if (gate === "reject") return new Response("unauthorized", { status: 401 });
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid blob", { status: 400 });
    }
    try {
      const put = parseBlobPut(payload);
      if (put.bytes !== undefined) {
        const bytes = put.bytes.buffer.slice(
          put.bytes.byteOffset,
          put.bytes.byteOffset + put.bytes.byteLength,
        );
        await this.ctx.storage.put(put.key, bytes);
        return Response.json({ ok: true, bytes: put.bytes.byteLength });
      }
      await this.ctx.storage.put(put.key, put.json);
      const bytes = new TextEncoder().encode(JSON.stringify(put.json)).byteLength;
      return Response.json({ ok: true, bytes });
    } catch (error) {
      if (error instanceof BlobPutError) return new Response("invalid blob", { status: 400 });
      throw error;
    }
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

  async fixtureSlices(): Promise<FixtureSlices> {
    return this.repo.fixtureSlices();
  }

  async inspectSchema(): Promise<SchemaSnapshot> {
    return this.repo.inspectSchema();
  }

  async putKeywords(rows: KeywordSeed[]): Promise<void> {
    await this.repo.putKeywords(rows);
  }

  async deleteKeyword(id: string, keyword: string): Promise<void>;
  async deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  async deleteKeyword(
    idOrInput: string | KeywordDelete,
    keyword?: string,
  ): Promise<void | KeywordDeleteStatus> {
    if (typeof idOrInput === "string") return this.repo.deleteKeyword(idOrInput, keyword ?? "");
    return this.repo.deleteKeyword(parseKeywordDelete(idOrInput));
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

  async measureKeywordRender(query: KeywordSelect, rounds: number): Promise<KeywordMeasure> {
    return this.repo.measureKeywordRender(query, rounds);
  }

  async measureColdRender(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure> {
    return this.repo.measureColdRender(query, rounds);
  }

  async keywordCacheStats(): Promise<KeywordCacheStats> {
    return this.repo.keywordCacheStats();
  }

  async auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit> {
    return this.repo.auditKeywordSelect(query);
  }

  async compactKeywordCache(): Promise<KeywordCompact> {
    return this.repo.compactKeywordCache();
  }

  async measureKeywordWrite(sample: KeywordWriteSample): Promise<KeywordWriteMeasure> {
    return this.repo.measureKeywordWrite(sample);
  }

  async alarm(): Promise<void> {
    const step = await this.repo.compactKeywordCache();
    if (!step.done) await this.ctx.storage.setAlarm(Date.now() + 10);
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
