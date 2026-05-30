import type Database from "better-sqlite3";

export function createPanelRequest(db: Database.Database, number: number, userId: number, steamId: string, createdAt: string) {
  return db
    .prepare("INSERT INTO panel_requests (number, user_id, steam_id, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
    .run(number, userId, steamId, createdAt);
}

export function getPendingPanelRequest(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM panel_requests WHERE id = ?").get(id) as any;
}

export function resolvePanelRequest(db: Database.Database, id: number, verdict: "YES" | "NO", reviewerId: number) {
  return db
    .prepare("UPDATE panel_requests SET status = ?, reviewed_by_user_id = ? WHERE id = ? AND status = 'PENDING'")
    .run(verdict, reviewerId, id);
}
