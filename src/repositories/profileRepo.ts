import type Database from "better-sqlite3";

export function getUserByQuery(db: Database.Database, q: string) {
  return db
    .prepare("SELECT * FROM users WHERE id = ? OR LOWER(IFNULL(discord_tag,'')) = LOWER(?) OR LOWER(IFNULL(tg_username,'')) = LOWER(?) LIMIT 1")
    .get(Number(q) || -1, q, q.replace("@", "")) as any;
}

export function incrementProfileViews(db: Database.Database, userId: number) {
  db.prepare("UPDATE users SET profile_views = profile_views + 1 WHERE id = ?").run(userId);
}

export function updateProfileCurrency(db: Database.Database, userId: number, currency: string) {
  db.prepare("UPDATE users SET profile_currency = ? WHERE id = ?").run(currency, userId);
}
