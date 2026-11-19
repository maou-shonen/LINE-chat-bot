export type JsonPrimitive = string | number | boolean | null;

export type SettingsPatch = Record<string, JsonPrimitive>;

export interface SettingsKey {
  groupId: string;
  userId: string;
}

export interface SettingsView {
  groupId: string;
  userId: string;
  options: SettingsPatch;
  stored: boolean;
}

export function parseSettingsKey(value: unknown): SettingsKey {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("settings key must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.groupId !== "string" || typeof record.userId !== "string") {
    throw new TypeError("settings key ids must be strings");
  }
  return { groupId: record.groupId, userId: record.userId };
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("settings patch must be a flat object");
  }
  const patch: SettingsPatch = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isJsonPrimitive(entry)) {
      throw new TypeError(
        "settings values must be string, number, boolean, or null",
      );
    }
    patch[key] = entry;
  }
  return patch;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}
