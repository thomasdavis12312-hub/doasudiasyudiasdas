import { escapeHtml } from "../../utils/text";

export function formatOnlineDuration(secondsRaw: number): string {
  const total = Math.max(0, Math.floor(secondsRaw));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}ч ${m}м ${s}с`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

export function formatOnlineWatchOnlineText(profileUrl: string, comment: string | null, onlineSeconds: number) {
  const safeComment = comment ? ` (${escapeHtml(comment)})` : "";
  const safeUrl = escapeHtml(profileUrl);
  return (
    `🟢 <a href="${safeUrl}">Профиль</a>${safeComment} находится онлайн!\n\n` +
    `Находится онлайн: <b>${formatOnlineDuration(onlineSeconds)}</b>`
  );
}

export function formatOnlineWatchOfflineText(profileUrl: string, comment: string | null, onlineSeconds: number) {
  const safeComment = comment ? ` (${escapeHtml(comment)})` : "";
  const safeUrl = escapeHtml(profileUrl);
  return (
    `🔴 <a href="${safeUrl}">Профиль</a>${safeComment} был онлайн но покинул сеть.\n\n` +
    `Находился онлайн: <b>${formatOnlineDuration(onlineSeconds)}</b>`
  );
}
