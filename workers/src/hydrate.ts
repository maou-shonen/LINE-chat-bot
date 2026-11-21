import { groupBlobKey, userShardIndex, userShardKey, type GroupBlob, type GroupBlobUser, type UserShard } from "./blob-store";
import type { SettingsKey } from "./settings";

export const HYDRATE_BATCH = 80;

interface ColdGroup {
  cursor: number;
  members: number;
  done: boolean;
}

export class Hydrator {
  private readonly users = new Set<string>();
  private readonly groups = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly enabled: boolean,
  ) {}

  async beforeUser(id: string): Promise<void> {
    if (!this.enabled || this.users.has(id)) return;
    if (this.checkedUser(id)) {
      this.users.add(id);
      return;
    }
    const shard = asUserShard(await this.storage.get(userShardKey(userShardIndex(id))));
    const row = shard?.users.find((user) => user.id === id) ?? null;
    this.storage.transactionSync(() => {
      if (row !== null) {
        this.storage.sql.exec(
          `INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             create_on = COALESCE(user.create_on, excluded.create_on),
             update_on = COALESCE(user.update_on, excluded.update_on)`,
          row.id,
          row.name,
          row.create_on,
          row.update_on,
        );
        for (const setting of shard?.settings ?? []) {
          if (setting.user_id !== id) continue;
          this.storage.sql.exec(
            "INSERT INTO user_settings (group_id, user_id, options) VALUES ('', ?, ?) ON CONFLICT(group_id, user_id) DO NOTHING",
            setting.user_id,
            setting.options,
          );
        }
      }
      this.storage.sql.exec("INSERT INTO cold_user (id) VALUES (?) ON CONFLICT(id) DO NOTHING", id);
    });
    this.users.add(id);
  }

  async beforeSettings(key: SettingsKey): Promise<void> {
    if (key.groupId === "") {
      await this.beforeUser(key.userId);
      return;
    }
    await this.ensureHeader(key.groupId);
  }

  async beforeGroup(id: string): Promise<void> {
    await this.ensureHeader(id);
  }

  async beforeTouch(groupId: string | null, userId: string | null): Promise<void> {
    if (userId !== null) await this.beforeUser(userId);
    if (groupId === null) return;
    await this.ensureHeader(groupId);
    await this.advance(groupId, userId);
  }

  async pendingBlob(groupId: string): Promise<GroupBlob | null> {
    if (!this.enabled || this.groups.has(groupId)) return null;
    const state = this.readGroup(groupId);
    if (state?.done) {
      this.groups.add(groupId);
      return null;
    }
    await this.ensureHeader(groupId);
    await this.advance(groupId, null);
    const after = this.readGroup(groupId);
    if (after === null || after.done) return null;
    return asGroupBlob(await this.storage.get(groupBlobKey(groupId)));
  }

  omitted(groupId: string): Set<string> {
    if (!this.enabled) return new Set();
    const ids = new Set<string>();
    for (const row of this.storage.sql.exec("SELECT uid FROM cold_omit WHERE gid = ?", groupId).toArray()) {
      const uid = row.uid;
      if (typeof uid === "string") ids.add(uid);
    }
    return ids;
  }

  noteDelete(groupId: string, userId: string | null): void {
    if (!this.enabled) return;
    this.storage.transactionSync(() => {
      if (userId === null) {
        this.storage.sql.exec("UPDATE cold_group SET done = 1 WHERE id = ?", groupId);
        this.storage.sql.exec("DELETE FROM cold_omit WHERE gid = ?", groupId);
        return;
      }
      this.storage.sql.exec(
        "INSERT INTO cold_omit (gid, uid) VALUES (?, ?) ON CONFLICT(gid, uid) DO NOTHING",
        groupId,
        userId,
      );
    });
    if (userId === null) this.groups.add(groupId);
  }

  async pump(): Promise<boolean> {
    if (!this.enabled) return false;
    const row = this.storage.sql.exec("SELECT id FROM cold_group WHERE done = 0 LIMIT 1").toArray()[0];
    const id = row?.id;
    if (typeof id !== "string") return false;
    await this.advance(id, null);
    return this.storage.sql.exec("SELECT id FROM cold_group WHERE done = 0 LIMIT 1").toArray()[0] !== undefined;
  }

  private async ensureHeader(groupId: string): Promise<void> {
    if (!this.enabled || this.groups.has(groupId)) return;
    const state = this.readGroup(groupId);
    if (state?.done) {
      this.groups.add(groupId);
      return;
    }
    if (state !== null) return;
    const blob = asGroupBlob(await this.storage.get(groupBlobKey(groupId)));
    this.storage.transactionSync(() => {
      if (this.readGroup(groupId) !== null) return;
      if (blob === null) {
        this.storage.sql.exec(
          "INSERT INTO cold_group (id, cursor, members, done) VALUES (?, 0, 0, 1)",
          groupId,
        );
        return;
      }
      const group = blob.group;
      if (group !== null) {
        this.storage.sql.exec(
          `INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          group.id,
          group._id,
          group._count,
          group._setting,
          group._admin,
          group.create_on,
          group.update_on,
        );
      }
      for (const setting of blob.settings) {
        this.storage.sql.exec(
          "INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO NOTHING",
          groupId,
          setting.user_id,
          setting.options,
        );
      }
      this.storage.sql.exec(
        "INSERT INTO cold_group (id, cursor, members, done) VALUES (?, 0, ?, 0)",
        groupId,
        blob.users.length,
      );
    });
    if (blob === null) this.groups.add(groupId);
  }

  private async advance(groupId: string, actor: string | null): Promise<void> {
    const state = this.readGroup(groupId);
    if (state === null || state.done) return;
    const blob = asGroupBlob(await this.storage.get(groupBlobKey(groupId)));
    if (blob === null) {
      this.storage.sql.exec("UPDATE cold_group SET done = 1 WHERE id = ?", groupId);
      this.groups.add(groupId);
      return;
    }
    const omit = this.omitted(groupId);
    this.storage.transactionSync(() => {
      const current = this.readGroup(groupId);
      if (current === null || current.done) return;
      const end = Math.min(blob.users.length, current.cursor + HYDRATE_BATCH);
      this.insertMembers(groupId, blob.users.slice(current.cursor, end), omit);
      if (actor !== null) {
        const extra = blob.users.find((user) => user.uid === actor);
        if (extra !== undefined) this.insertMembers(groupId, [extra], omit);
      }
      const done = end >= blob.users.length;
      this.storage.sql.exec(
        "UPDATE cold_group SET cursor = ?, members = ?, done = ? WHERE id = ?",
        end,
        blob.users.length,
        done ? 1 : 0,
        groupId,
      );
      if (done) this.groups.add(groupId);
    });
    const after = this.readGroup(groupId);
    if (after !== null && !after.done) await this.storage.setAlarm(Date.now() + 10);
  }

  private insertMembers(groupId: string, members: readonly GroupBlobUser[], omit: Set<string>): void {
    for (const member of members) {
      if (omit.has(member.uid)) continue;
      this.storage.sql.exec(
        "INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, NULL, NULL) ON CONFLICT(id) DO NOTHING",
        member.uid,
        member.name,
      );
      this.storage.sql.exec(
        "INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?) ON CONFLICT(gid, uid) DO NOTHING",
        groupId,
        member.uid,
        member._count,
        member._setting,
      );
    }
  }

  private checkedUser(id: string): boolean {
    return this.storage.sql.exec("SELECT id FROM cold_user WHERE id = ?", id).toArray()[0] !== undefined;
  }

  private readGroup(id: string): ColdGroup | null {
    const row = this.storage.sql.exec(
      "SELECT cursor, members, done FROM cold_group WHERE id = ?",
      id,
    ).toArray()[0];
    if (row === undefined) return null;
    return {
      cursor: numberField(row.cursor),
      members: numberField(row.members),
      done: numberField(row.done) === 1,
    };
  }
}

function numberField(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("cold cursor was not a number");
  return value;
}

function asGroupBlob(value: unknown): GroupBlob | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as GroupBlob;
  if (!Array.isArray(record.users) || !Array.isArray(record.settings)) return null;
  return record;
}

function asUserShard(value: unknown): UserShard | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as UserShard;
  if (!Array.isArray(record.users) || !Array.isArray(record.settings)) return null;
  return record;
}
