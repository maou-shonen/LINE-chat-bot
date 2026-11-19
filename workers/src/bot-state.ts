import { DurableObject } from "cloudflare:workers";
import { applyImportBatch } from "./import-apply";
import {
  IMPORT_SECRET_HEADER,
  ImportBatchError,
  importGate,
  parseImportBatch,
} from "./import-plan";
import { SqliteBotRepository, type BotRepository } from "./repository";
import type { SchemaSnapshot } from "./schema";
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
      const result = this.ctx.storage.transactionSync(() =>
        applyImportBatch(this.ctx.storage.sql, batch),
      );
      return Response.json(result);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return new Response("batch rejected", { status: 409 });
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

  async countSettings(key: SettingsKey): Promise<number> {
    return this.repo.countSettings(parseSettingsKey(key));
  }

  async inspectSchema(): Promise<SchemaSnapshot> {
    return this.repo.inspectSchema();
  }
}
