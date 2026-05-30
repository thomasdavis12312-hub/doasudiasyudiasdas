import type Database from "better-sqlite3";

export function createJoinRequest(db: Database.Database, number: number, userId: number, discordTag: string, createdAt: string) {
  return db
    .prepare("INSERT INTO join_requests (number, user_id, discord_tag, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
    .run(number, userId, discordTag, createdAt);
}

export function getJoinRequestById(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM join_requests WHERE id = ?").get(id) as any;
}

export function approveJoinRequest(db: Database.Database, id: number, reviewerId: number) {
  return db.prepare("UPDATE join_requests SET status = 'APPROVED', reviewed_by_user_id = ? WHERE id = ? AND status = 'PENDING'").run(reviewerId, id);
}

export function rejectJoinRequest(db: Database.Database, id: number, reviewerId: number, reason: string | null) {
  return db.prepare("UPDATE join_requests SET status = 'REJECTED', reason = ?, reviewed_by_user_id = ? WHERE id = ? AND status = 'PENDING'").run(reason, reviewerId, id);
}
