import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import type { ColumnInfo, SchemaSnapshot } from "../src/schema";

describe("sqlite schema", () => {
  it("creates the domain tables, composite keys, and keyword indexes", async () => {
    const state = freshState();
    await state.migrate();
    await state.migrate();
    const snapshot = await state.inspectSchema();

    expect(snapshot.migrationVersion).toBe(1);
    for (const name of ["user", "group", "group_user", "keywords_logs", "user_keyword", "user_settings"]) {
      expect(snapshot.tables).toContain(name);
    }

    expect(column(snapshot, "user_settings", "group_id")).toMatchObject({
      notNull: true,
      primaryKey: 1,
    });
    expect(column(snapshot, "user_settings", "user_id")).toMatchObject({
      notNull: true,
      primaryKey: 2,
    });
    expect(emptyDefault(column(snapshot, "user_settings", "group_id").defaultValue)).toBe(true);
    expect(emptyDefault(column(snapshot, "user_settings", "user_id").defaultValue)).toBe(true);

    expect(column(snapshot, "group_user", "gid")).toMatchObject({ notNull: true, primaryKey: 1 });
    expect(column(snapshot, "group_user", "uid")).toMatchObject({ notNull: true, primaryKey: 2 });
    expect(emptyDefault(column(snapshot, "group_user", "gid").defaultValue)).toBe(true);
    expect(emptyDefault(column(snapshot, "group_user", "uid").defaultValue)).toBe(true);

    expect(column(snapshot, "user_keyword", "anchor").notNull).toBe(true);
    const names = snapshot.indexes.map((index) => index.name);
    expect(names).toContain("ix_user_keyword_anchor");
    expect(names).toContain("ix_user_keyword_anchor_len");
    expect(names).toContain("ux_user_keyword_id_keyword");
    const lengthIndex = snapshot.indexes.find((index) => index.name === "ix_user_keyword_anchor_len");
    const uniqueIndex = snapshot.indexes.find((index) => index.name === "ux_user_keyword_id_keyword");
    expect(lengthIndex?.sql ?? "").toContain("length");
    expect((uniqueIndex?.sql ?? "").toLowerCase()).toContain("unique");
  });
});

function freshState(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`schema-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}

function column(snapshot: SchemaSnapshot, table: string, name: string): ColumnInfo {
  const found = snapshot.columns[table]?.find((item) => item.name === name);
  if (found === undefined) throw new Error(`missing ${table}.${name}`);
  return found;
}

function emptyDefault(value: string | null): boolean {
  return value === "''" || value === "\"\"" || value === "";
}
