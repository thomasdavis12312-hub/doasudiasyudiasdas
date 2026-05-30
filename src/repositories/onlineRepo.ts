import type Database from "better-sqlite3";

export function findOnlineWatch(db: Database.Database, userId: number, profileUrl: string) {
  return db.prepare("SELECT id FROM online_watch WHERE user_id = ? AND profile_url = ?").get(userId, profileUrl) as any;
}

export function createOnlineWatch(db: Database.Database, userId: number, profileUrl: string, comment: string | null) {
  db.prepare("INSERT INTO online_watch (user_id, profile_url, comment) VALUES (?, ?, ?)").run(userId, profileUrl, comment);
}

export function deleteOnlineWatchById(db: Database.Database, id: number) {
  db.prepare("DELETE FROM online_watch WHERE id = ?").run(id);
}
