import type { Role } from "./types";

export const BOT_TOKEN = process.env.BOT_TOKEN || "";
export const DB_PATH = process.env.SQLITE_PATH || "./bot.db";
export const TELEGRAM_PROVIDER_TOKEN = process.env.TELEGRAM_PROVIDER_TOKEN || "";
export const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || "").trim();
export const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || "").trim();
export const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI || "").trim();
export const DISCORD_OAUTH_PORT = Number(process.env.DISCORD_OAUTH_PORT || 8787);
export const TELEGRAM_BOT_LINK = (process.env.TELEGRAM_BOT_LINK || "https://t.me/ccutils_bot").trim();
export const DISCORD_OAUTH_STATE_SECRET_FALLBACK = "state-secret";
export const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter(Boolean);

export const STEAM_WEB_API_KEY = (process.env.STEAM_WEB_API_KEY || "").trim();
export const STEAMWEBAPI_KEY = (process.env.STEAMWEBAPI_KEY || "").trim();
export const STEAMWEBAPI_BASE_URL = (process.env.STEAMWEBAPI_BASE_URL || "https://www.steamwebapi.com").replace(/\/+$/, "");

export const roleLabel: Record<Role, string> = {
  ADMIN: "🤴 Администратор",
  DOBIVER: "💇 Добивер",
  SELLER: "👨‍💻 Продавец",
  LANDLORD: "👨‍💻 Арендодатель",
  CHATER: "👨‍💻 Чатер",
  USER: "👨‍🔧 Пользователь",
};

export const roleLabelPlain: Record<Role, string> = {
  ADMIN: "Администратор",
  DOBIVER: "Добивер",
  SELLER: "Продавец",
  LANDLORD: "Арендодатель",
  CHATER: "Чатер",
  USER: "Пользователь",
};

