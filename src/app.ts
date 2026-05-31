import "dotenv/config";
import Database from "better-sqlite3";
import { Input, Markup, Telegraf } from "telegraf";
import iconv from "iconv-lite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { configureBotCommands, syncChatCommandsForUser } from "./core/commands";
import {
  ADMIN_IDS,
  BOT_TOKEN,
  DB_PATH,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_OAUTH_PORT,
  DISCORD_OAUTH_STATE_SECRET_FALLBACK,
  DISCORD_REDIRECT_URI,
  STEAMWEBAPI_BASE_URL,
  STEAMWEBAPI_KEY,
  STEAM_WEB_API_KEY,
  TELEGRAM_BOT_LINK,
  TELEGRAM_PROVIDER_TOKEN,
  roleLabel,
  roleLabelPlain,
} from "./core/config";
import { adminKb, langInlineKb, mainKb } from "./core/ui";
import { joinRequestText, panelRequestText } from "./features/requests/text";
import { formatOnlineWatchOfflineText, formatOnlineWatchOnlineText } from "./features/online/text";
import { buildDiscordAuthUrl as buildDiscordAuthUrlCore, parseDiscordOAuthState } from "./features/oauth/state";
import { registerBasicHandlers } from "./features/router/basicHandlers";
import { escapeHtml, nowIso } from "./utils/text";
import { createJoinRequest, getJoinRequestById, approveJoinRequest, rejectJoinRequest } from "./repositories/joinRepo";
import { createPanelRequest, getPendingPanelRequest, resolvePanelRequest } from "./repositories/panelRepo";
import { getUserByQuery, incrementProfileViews, updateProfileCurrency } from "./repositories/profileRepo";
import { findOnlineWatch, createOnlineWatch, deleteOnlineWatchById } from "./repositories/onlineRepo";
import type { Role } from "./core/types";

type Ctx = any;
const DISCORD_OAUTH_STATE_SECRET = (process.env.DISCORD_OAUTH_STATE_SECRET || BOT_TOKEN || DISCORD_OAUTH_STATE_SECRET_FALLBACK).trim();

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);
const db = new Database(DB_PATH);
const state = new Map<number, { mode: string; payload?: any }>();
const dialogs = new Map<number, { workerTgId: number; userTgId: number; active: boolean }>();
const onlineWatchRuntime = new Map<
  number,
  {
    onlineSince: number;
    messageChatId: number;
    messageId: number;
    profileUrl: string;
    comment: string | null;
    lastStatusCheckAt: number;
  }
>();
const onlineWatchProbeState = new Map<number, { lastStatusCheckAt: number; onlineStreak: number }>();
const steamIdResolveCache = new Map<string, { steamId: string; updatedAt: number }>();
let onlineWatchLoopStarted = false;
let usdRubCache = { rate: Number(process.env.USD_RUB_RATE || 90), updatedAt: 0 };
let usdUahCache = { rate: Number(process.env.USD_UAH_RATE || 40), updatedAt: 0 };
const uiPromptMsg = new Map<number, number>();
const adminLogsViewState = new Map<number, { query: string }>();
const adminReqListState = new Map<number, { kind: "work" | "panel" | "rent"; query: string }>();
let steamBrowser: any = null;
let steamPage: any = null;
let steamAddFriendPage: any = null;
let steamSourcePage: any = null;
let steamTemplatePage: any = null;
let steamRenderChain: Promise<any> = Promise.resolve();
let steamWarmupPromise: Promise<void> | null = null;
let steamReadyPromise: Promise<void> | null = null;
let discordOAuthServerStarted = false;
const steamProfileCache = new Map<
  string,
  {
    name: string;
    avatarFull: string | null;
    avatarMedium: string | null;
    avatarIcon: string | null;
    avatarFrame: string | null;
    level: string | null;
    levelClass: string | null;
    profilePageHtml: string | null;
    bodyClass: string | null;
    headerContentHtml: string | null;
    badgeHtml: string | null;
    rightColHtml: string | null;
    updatedAt: number;
  }
>();
const STEAM_GUARD_CODE_CHARS = "23456789BCDFGHJKMNPQRTVWXY";
const STEAM_ABORT_RESOURCE_TYPES = new Set(["media", "font", "websocket"]);

async function prepareSteamPageForFastRender(page: any) {
  if ((page as any).__fastRenderPrepared) return;
  await page.route("**/*", (route: any) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url().toLowerCase();
    if (STEAM_ABORT_RESOURCE_TYPES.has(type)) return route.abort();
    if (type === "image" && (url.includes("/videos/") || url.includes("broadcast"))) return route.abort();
    return route.continue();
  });
  (page as any).__fastRenderPrepared = true;
}

async function ensureSteamRendererReady() {
  if (steamReadyPromise) {
    await steamReadyPromise;
    return;
  }
  steamReadyPromise = (async () => {
    const { chromium } = (await import("playwright")) as any;
    if (!steamBrowser) {
      steamBrowser = await chromium.launch({ headless: true });
    }
    if (!steamPage || steamPage.isClosed?.()) {
      steamPage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamPage);
      await steamPage.goto("about:blank").catch(() => null);
    }
    if (!steamAddFriendPage || steamAddFriendPage.isClosed?.()) {
      steamAddFriendPage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamAddFriendPage);
      await steamAddFriendPage.goto("about:blank").catch(() => null);
    }
    if (!steamSourcePage || steamSourcePage.isClosed?.()) {
      steamSourcePage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamSourcePage);
      await steamSourcePage.goto("about:blank").catch(() => null);
    }
    if (!steamTemplatePage || steamTemplatePage.isClosed?.()) {
      steamTemplatePage = await steamBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
      await prepareSteamPageForFastRender(steamTemplatePage);
      await steamTemplatePage.goto("about:blank").catch(() => null);
    }
  })();
  await steamReadyPromise;
}

function normalizeBase64Secret(value: string): string {
  const compact = value.trim().replace(/\s+/g, "");
  const base64 = compact.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad === 0) return base64;
  return `${base64}${"=".repeat(4 - pad)}`;
}

function generateSteamGuardCodeFromSharedSecret(sharedSecret: string, atMs = Date.now()): string {
  const secret = Buffer.from(normalizeBase64Secret(sharedSecret), "base64");
  if (!secret.length) throw new Error("shared_secret is empty");

  const timeStep = Math.floor(atMs / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(timeStep, 4);

  const digest = crypto.createHmac("sha1", secret).update(timeBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  let codePoint = digest.readUInt32BE(offset) & 0x7fffffff;

  let result = "";
  for (let i = 0; i < 5; i += 1) {
    result += STEAM_GUARD_CODE_CHARS[codePoint % STEAM_GUARD_CODE_CHARS.length];
    codePoint = Math.floor(codePoint / STEAM_GUARD_CODE_CHARS.length);
  }
  return result;
}

function isLikelySteamSharedSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 16) return false;
  if (/^(code|guard)\s*:/i.test(v)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(v);
}

function isValidSteamLogin(value: string): boolean {
  const v = value.trim();
  return /^[A-Za-z0-9_.-]{3,64}$/.test(v);
}

function isValidRentalPassword(value: string): boolean {
  const v = value.trim();
  return v.length >= 6 && v.length <= 128;
}

function parseGuardInput(rawValue: string): { kind: "shared"; value: string } | null {
  const raw = rawValue.trim();
  if (!raw) return null;

  const prefixedShared = raw.match(/^(?:shared|secret)\s*:\s*(.+)$/i)?.[1]?.trim();
  if (prefixedShared) {
    try {
      generateSteamGuardCodeFromSharedSecret(prefixedShared);
      return { kind: "shared", value: prefixedShared };
    } catch {
      return null;
    }
  }

  if (isLikelySteamSharedSecret(raw)) {
    try {
      generateSteamGuardCodeFromSharedSecret(raw);
      return { kind: "shared", value: raw };
    } catch {
      return null;
    }
  }

  return null;
}

function parseMaFileData(rawText: string): { sharedSecret: string; accountName: string | null; steamId: string | null } | null {
  const text = rawText.trim();
  if (!text) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const secret = String(parsed?.shared_secret || "").trim();
  if (!secret) return null;
  try {
    generateSteamGuardCodeFromSharedSecret(secret);
    const accountNameRaw = String(parsed?.account_name || parsed?.AccountName || "").trim();
    const steamIdRaw =
      String(parsed?.Session?.SteamID || parsed?.session?.SteamID || parsed?.steamid || parsed?.SteamID || "").trim();
    const steamId = /^7\d{15,18}$/.test(steamIdRaw) ? steamIdRaw : null;
    return {
      sharedSecret: secret,
      accountName: accountNameRaw || null,
      steamId,
    };
  } catch {
    return null;
  }
}

function extractRentalSharedSecret(rental: any): string | null {
  const raw = String(rental?.guard_code || "").trim();
  if (!raw) return null;
  const prefixedShared = raw.match(/^(?:shared|secret)\s*:\s*(.+)$/i)?.[1]?.trim();
  if (prefixedShared) return prefixedShared;
  if (isLikelySteamSharedSecret(raw)) return raw;
  return null;
}

async function steamLoginSecure(payload: Record<string, any>): Promise<any> {
  if (!STEAMWEBAPI_KEY) throw new Error("STEAMWEBAPI_KEY не настроен");
  const u = new URL("/steam/api/steamloginsecure", `${STEAMWEBAPI_BASE_URL}/`);
  u.searchParams.set("key", STEAMWEBAPI_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(u.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).catch((e: any) => {
    if (e?.name === "AbortError") throw new Error("SteamWebAPI timeout (15s)");
    throw e;
  });
  clearTimeout(timer);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const msg = String(json?.message || `SteamWebAPI login error (${res.status})`);
    throw new Error(msg);
  }
  return json;
}

async function refreshRentalSteamSession(rental: any): Promise<any> {
  const refreshToken = String(rental?.steam_refresh_token || "").trim();
  if (refreshToken) {
    return steamLoginSecure({ steamrefreshtoken: refreshToken });
  }

  const sharedSecret = extractRentalSharedSecret(rental);
  if (!sharedSecret) throw new Error("shared_secret missing");
  const login = String(rental?.login || "").trim();
  const pass = String(rental?.pass || "").trim();
  if (!login || !pass) throw new Error("login/password missing");

  return steamLoginSecure({
    username: login,
    password: pass,
    code: sharedSecret,
  });
}

function persistRentalSteamSession(rentalId: number, sessionData: any) {
  const c = sessionData?.cookies || {};
  db.prepare(
    `UPDATE rentals
      SET steam_refresh_token = COALESCE(?, steam_refresh_token),
          steam_login_secure = ?,
          steam_login_secure_exp = ?,
          steam_session_id = ?,
          steam_browser_id = ?,
          steam_id = COALESCE(?, steam_id)
      WHERE id = ?`,
  ).run(
    c.steamrefreshtoken || null,
    c.steamloginsecure || null,
    c.steamloginsecureexp || null,
    c.sessionid || null,
    c.browserid || null,
    c.steamid || null,
    rentalId,
  );
}

async function getRentalGuardCode(rental: any): Promise<string> {
  const raw = String(rental?.guard_code || "").trim();
  if (!raw) throw new Error("Guard data is empty");

  const sharedSecret = extractRentalSharedSecret(rental);
  if (!sharedSecret) throw new Error("shared_secret missing");
  return generateSteamGuardCodeFromSharedSecret(sharedSecret);
}

function maybeFixMojibake(input: any): any {
  if (typeof input === "string") {
    const suspicious = /\uFFFD/.test(input);
    if (!suspicious) return input;
    try {
      return iconv.decode(iconv.encode(input, "win1251"), "utf8");
    } catch {
      return input;
    }
  }
  if (Array.isArray(input)) return input.map(maybeFixMojibake);
  if (input && typeof input === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) out[k] = maybeFixMojibake(v);
    return out;
  }
  return input;
}

const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
(bot.telegram as any).sendMessage = (chatId: any, text: any, extra?: any) =>
  originalSendMessage(chatId, maybeFixMojibake(text), maybeFixMojibake(extra));
const originalCallApi = (bot.telegram as any).callApi?.bind(bot.telegram);
if (originalCallApi) {
  (bot.telegram as any).callApi = (method: string, payload?: any, ...rest: any[]) =>
    originalCallApi(method, maybeFixMojibake(payload), ...rest);
}

bot.use(async (ctx, next) => {
  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = (text: any, extra?: any) => originalReply(maybeFixMojibake(text), maybeFixMojibake(extra));
  const originalAnswerCb = ctx.answerCbQuery?.bind(ctx);
  if (originalAnswerCb) {
    ctx.answerCbQuery = (text?: any, extra?: any) => originalAnswerCb(maybeFixMojibake(text), maybeFixMojibake(extra));
  }
  return next();
});



function buildDiscordAuthUrl(tgId: number): string | null {
  return buildDiscordAuthUrlCore({
    tgId,
    clientId: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    redirectUri: DISCORD_REDIRECT_URI,
    stateSecret: DISCORD_OAUTH_STATE_SECRET,
  });
}

async function sendDiscordOAuthLink(ctx: any, tgId: number) {
  const oauthUrl = buildDiscordAuthUrl(tgId);
  if (!oauthUrl) {
    await ctx.reply("Discord OAuth не настроен. Заполните DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET и DISCORD_REDIRECT_URI в .env").catch(() => null);
    return;
  }
  await ctx.reply("Для вступления привяжите Discord:", {
    reply_markup: Markup.inlineKeyboard([[Markup.button.url("Привязать Discord", oauthUrl)]]).reply_markup,
  }).catch(() => null);
}

async function createJoinRequestForUser(user: any, discordTag: string) {
  db.prepare("UPDATE users SET discord_tag = ? WHERE id = ?").run(discordTag, user.id);
  const existing = db.prepare("SELECT id FROM join_requests WHERE user_id = ? AND status = 'PENDING'").get(user.id) as any;
  if (existing) {
    await bot.telegram
      .sendMessage(
        user.tg_id,
        `Discord привязан: ${discordTag}\nВаша заявка на вступление уже находится на рассмотрении (№${existing.id}).`,
      )
      .catch(() => null);
    return;
  }
  const last = db.prepare("SELECT number FROM join_requests ORDER BY number DESC LIMIT 1").get() as any;
  const num = (last?.number ?? -1) + 1;
  const ins = db
    .prepare("INSERT INTO join_requests (number, user_id, discord_tag, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
    .run(num, user.id, discordTag, nowIso());
  await bot.telegram.sendMessage(user.tg_id, `✅ Заявка №${num} на вступление отправлена. Ожидайте решения администрации.`).catch(() => null);
  const joinCardText =
    `<tg-emoji emoji-id="5240106271465582633">🆕</tg-emoji> <b>Новая заявка №${num} на вступление</b>\n` +
    `├ Пользователь: <b>@${user.tg_username || user.tg_id}</b>\n` +
    `╰ Discord: <b>${discordTag}</b>`;
  const admins = db
    .prepare(
      "SELECT DISTINCT u.id, u.tg_id FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN notification_prefs np ON np.user_id = u.id WHERE r.role = 'ADMIN' AND IFNULL(u.is_banned,0)=0 AND IFNULL(np.notif_join,1)=1",
    )
    .all() as any[];
  for (const a of admins) {
    const adminTgId = Number(a?.tg_id || 0);
    if (!adminTgId) continue;
    const sent = await bot.telegram
      .sendMessage(
        adminTgId,
        joinCardText,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("✅ Принять", `join:approve:${ins.lastInsertRowid}`), Markup.button.callback("❌ Отклонить", `join:reject:${ins.lastInsertRowid}`)],
          ]).reply_markup,
        },
      )
      .catch(() => null as any);
    if (sent?.message_id) {
      db.prepare("INSERT INTO join_request_messages (join_request_id, admin_tg_id, message_id) VALUES (?, ?, ?)")
        .run(ins.lastInsertRowid, adminTgId, sent.message_id);
    }
  }
}

function startDiscordOAuthServer() {
  if (discordOAuthServerStarted) return;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    console.log("[DISCORD OAUTH] disabled: missing env", {
      hasClientId: Boolean(DISCORD_CLIENT_ID),
      hasClientSecret: Boolean(DISCORD_CLIENT_SECRET),
      hasRedirect: Boolean(DISCORD_REDIRECT_URI),
    });
    return;
  }
  discordOAuthServerStarted = true;
  console.log("[DISCORD OAUTH] server starting", { port: DISCORD_OAUTH_PORT, redirect: DISCORD_REDIRECT_URI });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${DISCORD_OAUTH_PORT}`);
      console.log("[DISCORD OAUTH] request", { path: url.pathname, query: url.search });
      if (url.pathname !== "/discord/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      const st = parseDiscordOAuthState(state, DISCORD_OAUTH_STATE_SECRET);
      if (!code || !st.valid || st.expired) {
        console.log("[DISCORD OAUTH] invalid state/code", { hasCode: Boolean(code), validState: st.valid, expired: st.expired });
        if (st.tgId) {
          await bot.telegram
            .sendMessage(
              st.tgId,
              "Ошибка OAuth: неверная или просроченная ссылка авторизации. Повторите привязку Discord в боте.",
            )
            .catch(() => null);
        }
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><head><meta http-equiv="refresh" content="1;url=${TELEGRAM_BOT_LINK}"></head><body>` +
            `<h3>Ошибка OAuth. Возвращаемся в Telegram...</h3>` +
            `</body></html>`,
        );
        return;
      }
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        }),
      });
      const tokenJson: any = await tokenRes.json();
      const accessToken = tokenJson?.access_token;
      if (!accessToken) throw new Error("discord access token missing");
      const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const discordUser: any = await meRes.json();
      const discordTag = discordUser?.discriminator && discordUser.discriminator !== "0"
        ? `${discordUser.username}#${discordUser.discriminator}`
        : `${discordUser.username}`;
      const discordId = String(discordUser?.id || "");
      const discordAvatar = String(discordUser?.avatar || "");
      let avatarUrl: string | null = null;
      if (discordId && discordAvatar && discordAvatar !== "null") {
        avatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${discordAvatar}.png?size=512`;
      } else if (discordId) {
        // Fallback to Discord default avatar when custom avatar is absent.
        const discRaw = String(discordUser?.discriminator || "0");
        let defaultIdx = 0;
        if (discRaw !== "0") {
          defaultIdx = Number(discRaw) % 5;
        } else {
          defaultIdx = Number((BigInt(discordId) >> 22n) % 6n);
        }
        avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
      }
      const tgUser = getUserByTgId(st.tgId);
      if (!tgUser) throw new Error("telegram user not found");
      db.prepare("UPDATE users SET discord_id = ?, discord_avatar_url = ? WHERE id = ?").run(discordId || null, avatarUrl, tgUser.id);
      await createJoinRequestForUser(tgUser, discordTag);
      console.log("[DISCORD OAUTH] success", { tgId: st.tgId, discordTag });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><meta http-equiv="refresh" content="1;url=${TELEGRAM_BOT_LINK}"></head><body>` +
          `<h2>Discord успешно привязан. Возвращаемся в Telegram...</h2>` +
          `</body></html>`,
      );
    } catch (e: any) {
      console.log("[DISCORD OAUTH] error", e?.message || e);
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${DISCORD_OAUTH_PORT}`);
        const state = url.searchParams.get("state") || "";
        const st = parseDiscordOAuthState(state, DISCORD_OAUTH_STATE_SECRET);
        if (st.tgId) {
          await bot.telegram
            .sendMessage(st.tgId, "Ошибка привязки Discord. Попробуйте снова через кнопку привязки в боте.")
            .catch(() => null);
        }
      } catch {}
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><meta http-equiv="refresh" content="2;url=${TELEGRAM_BOT_LINK}"></head><body>` +
          `<h3>Ошибка OAuth. Возвращаемся в Telegram...</h3>` +
          `</body></html>`,
      );
    }
  });
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE") {
      console.log(`[DISCORD OAUTH] port ${DISCORD_OAUTH_PORT} is already in use; oauth callback disabled for this process`);
      return;
    }
    console.log("[DISCORD OAUTH] server error", err?.message || err);
  });
  server.listen(DISCORD_OAUTH_PORT);
}


function initDb() {
  db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER UNIQUE NOT NULL,
    tg_username TEXT,
    discord_tag TEXT,
    discord_id TEXT,
    discord_avatar_url TEXT,
    language TEXT DEFAULT 'ru',
    is_approved INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    registered_at TEXT NOT NULL,
    profile_views INTEGER DEFAULT 0,
    sessions_given INTEGER DEFAULT 0,
    sessions_taken INTEGER DEFAULT 0,
    sessions_failed INTEGER DEFAULT 0,
    total_given_usd REAL DEFAULT 0,
    total_taken_usd REAL DEFAULT 0,
    total_failed_usd REAL DEFAULT 0,
    total_dodep_usd REAL DEFAULT 0,
    total_dodep_yuan REAL DEFAULT 0,
    worker_taken INTEGER DEFAULT 0,
    worker_failed INTEGER DEFAULT 0,
    worker_taken_usd REAL DEFAULT 0,
    worker_failed_usd REAL DEFAULT 0,
    seller_sales_usd REAL DEFAULT 0,
    profile_currency TEXT DEFAULT 'USD'
  );
  CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    UNIQUE(user_id, role)
  );
  CREATE TABLE IF NOT EXISTS join_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    discord_tag TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewed_by_user_id INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS join_request_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    join_request_id INTEGER NOT NULL,
    admin_tg_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(join_request_id, admin_tg_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS work_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER UNIQUE NOT NULL,
    owner_id INTEGER NOT NULL,
    worker_id INTEGER,
    steam_id TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    region TEXT NOT NULL,
    status TEXT NOT NULL,
    rejection_reason TEXT,
    fail_reason TEXT,
    bot_link TEXT,
    dodep_usd REAL DEFAULT 0,
    dodep_yuan REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS work_request_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_request_id INTEGER NOT NULL,
    admin_tg_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(work_request_id, admin_tg_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    actor_tg_id INTEGER,
    actor_role TEXT,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rentals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER UNIQUE NOT NULL,
    owner_user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    login TEXT NOT NULL,
    pass TEXT NOT NULL,
    guard_code TEXT NOT NULL,
    steam_id TEXT,
    steam_refresh_token TEXT,
    steam_login_secure TEXT,
    steam_login_secure_exp TEXT,
    steam_session_id TEXT,
    steam_browser_id TEXT,
    description TEXT,
    is_busy INTEGER DEFAULT 0,
    rented_by_user_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS guard_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rental_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    attempts_left INTEGER DEFAULT 1,
    UNIQUE(rental_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS online_watch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    profile_url TEXT NOT NULL,
    comment TEXT,
    UNIQUE(user_id, profile_url)
  );
  CREATE TABLE IF NOT EXISTS panel_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    steam_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewed_by_user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS panel_request_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_request_id INTEGER NOT NULL,
    admin_tg_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(panel_request_id, admin_tg_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS rent_request_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rental_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    admin_tg_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(rental_id, user_id, admin_tg_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id INTEGER PRIMARY KEY,
    notif_work INTEGER DEFAULT 1,
    notif_join INTEGER DEFAULT 1,
    notif_panel INTEGER DEFAULT 1,
    notif_rent INTEGER DEFAULT 1
  );
  `);
  try {
    db.prepare("ALTER TABLE users ADD COLUMN profile_currency TEXT DEFAULT 'USD'").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE users ADD COLUMN discord_id TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE users ADD COLUMN discord_avatar_url TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE panel_requests ADD COLUMN reviewed_by_user_id INTEGER").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE join_requests ADD COLUMN reviewed_by_user_id INTEGER").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_id TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_refresh_token TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_login_secure TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_login_secure_exp TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_session_id TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE rentals ADD COLUMN steam_browser_id TEXT").run();
  } catch {}
  try {
    db.prepare("UPDATE user_roles SET role = 'DOBIVER' WHERE role = 'WORKER'").run();
  } catch {}
  try {
    db.prepare("DELETE FROM user_roles WHERE role = 'SELLER'").run();
  } catch {}
}

function ensureNotificationPrefs(userId: number) {
  db.prepare(
    "INSERT OR IGNORE INTO notification_prefs (user_id, notif_work, notif_join, notif_panel, notif_rent) VALUES (?, 1, 1, 1, 1)",
  ).run(userId);
}

function renderNotifyText(p: any) {
  return (
    `<b>Уведомления</b>\n` +
    `Новая заявка на добив: <b>${Number(p?.notif_work || 0) ? "Включено" : "Выключено"}</b>\n` +
    `Новая заявка на вступление: <b>${Number(p?.notif_join || 0) ? "Включено" : "Выключено"}</b>\n` +
    `Проверка на панеле: <b>${Number(p?.notif_panel || 0) ? "Включено" : "Выключено"}</b>\n` +
    `Заявки на аренду: <b>${Number(p?.notif_rent || 0) ? "Включено" : "Выключено"}</b>`
  );
}

function renderNotifyKb(p: any) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${Number(p?.notif_work || 0) ? "✅" : "❌"} Добив`, "notify:toggle:work")],
    [Markup.button.callback(`${Number(p?.notif_join || 0) ? "✅" : "❌"} Вступление`, "notify:toggle:join")],
    [Markup.button.callback(`${Number(p?.notif_panel || 0) ? "✅" : "❌"} Панель`, "notify:toggle:panel")],
    [Markup.button.callback(`${Number(p?.notif_rent || 0) ? "✅" : "❌"} Заявки на аренду`, "notify:toggle:rent")],
  ]);
}

function getUserByTgId(tgId: number) {
  return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId) as any;
}

function rolesByUserId(userId: number): Role[] {
  return db
    .prepare("SELECT role FROM user_roles WHERE user_id = ?")
    .all(userId)
    .map((x: any) => x.role);
}

function ensureUser(ctx: Ctx) {
  const tgId = ctx.from?.id;
  if (!tgId) return null;
  let user = getUserByTgId(tgId);
  if (!user) {
    db.prepare("INSERT INTO users (tg_id, tg_username, registered_at) VALUES (?, ?, ?)").run(
      tgId,
      ctx.from.username || null,
      nowIso(),
    );
    user = getUserByTgId(tgId);
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'USER')").run(user.id);
  }
  if (ADMIN_IDS.includes(tgId)) {
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'ADMIN')").run(user.id);
    if (!user.is_approved) {
      db.prepare("UPDATE users SET is_approved = 1 WHERE id = ?").run(user.id);
      user.is_approved = 1;
    }
  }
  ensureNotificationPrefs(user.id);
  user.roles = rolesByUserId(user.id);
  return user;
}

function hasRole(user: any, roles: Role[]) {
  return user.roles.some((r: Role) => roles.includes(r));
}

function hasLinkedDiscord(user: any) {
  const v = String(user?.discord_tag || "").trim();
  return v.length > 0 && v !== "-";
}

function logEvent(user: any, eventType: string, details: string) {
  db.prepare(
    "INSERT INTO logs (actor_user_id, actor_tg_id, actor_role, event_type, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(user?.id || null, user?.tg_id || null, user?.roles?.[0] || "USER", eventType, details, nowIso());
}

const STEAM_TEMPLATE_HTML_PATH =
  process.env.STEAM_TEMPLATE_HTML_PATH || "C:/Users/xvapl/Downloads/Ryan Cooper ?????.html";
async function resolveSteamFriendTemplatePath(): Promise<string> {
  if (process.env.STEAM_TEMPLATE_HTML_PATH) return process.env.STEAM_TEMPLATE_HTML_PATH;
  const downloadsDir = "C:/Users/xvapl/Downloads";
  const candidates = [
    "Ryan Cooper ?????.html",
    "Steam Community __ cuteboy.html",
    "Steam Community __ Ryan Cooper ?????.html",
  ];
  for (const name of candidates) {
    const p = path.join(downloadsDir, name);
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  try {
    const files = await fs.readdir(downloadsDir);
    const picked =
      files.find((f) => /^Ryan Cooper .*\.html$/i.test(f)) ||
      files.find((f) => /^Steam Community __ .*\.html$/i.test(f));
    if (picked) return path.join(downloadsDir, picked);
  } catch {}
  return STEAM_TEMPLATE_HTML_PATH;
}
const PROFILE_ACTIONS_HTML = `<a data-panel="{&quot;autoFocus&quot;:true,&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}" role="button" id="btn_add_friend" class="btn_profile_action btn_medium" href="javascript:AddFriend()"><span>Add Friend</span></a>
<span data-panel="{&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}" role="button" class="btn_profile_action btn_medium" id="profile_action_dropdown_link" onclick="ShowMenu( this, 'profile_action_dropdown', 'right' );"><span>More... <img src="https://community.fastly.steamstatic.com/public/images/profile/profile_action_dropdown.png"></span></span>
<div class="popup_block" id="profile_action_dropdown" style="display: none;">
  <div class="shadow_ul"></div><div class="shadow_top"></div><div class="shadow_ur"></div><div class="shadow_left"></div><div class="shadow_right"></div><div class="shadow_bl"></div><div class="shadow_bottom"></div><div class="shadow_br"></div>
  <div data-panel="{&quot;flow-children&quot;:&quot;row&quot;}" class="popup_body popup_menu shadow_content">
    <a class="popup_menu_item" href="javascript:void(0)"><img src="https://community.fastly.steamstatic.com/public/shared/images/award_icon.svg" class="reward_btn_icon">&nbsp; <span>Give a Community Award</span></a>
    <a class="popup_menu_item" href="javascript:void(0)"><img src="https://cdn.fastly.steamstatic.com/steamcommunity/public/assets/profile/equipped_items_icon.svg" class="reward_btn_icon">&nbsp; <span>View Equipped Point Shop Items</span></a>
    <span class="popup_menu_item group_invite_menu_option_disabled tooltip" data-tooltip-text="You must be friends before you can invite a player to join a group."><img src="https://community.fastly.steamstatic.com/public/images/profile/icon_invitegroup.png">&nbsp; Invite to Join Your Group</span>
    <a class="popup_menu_item" href="javascript:void(0)"><img src="https://community.fastly.steamstatic.com/public/images/profile/icon_block.png">&nbsp; Block All Communication</a>
    <a class="popup_menu_item" href="javascript:void(0)"><img src="https://community.fastly.steamstatic.com/public/images/skin_1/notification_icon_flag.png" style="margin: 0 1px;">&nbsp; Report Player</a>
  </div>
</div>`;
const ADD_FRIEND_ERROR_MODAL_HTML = `<div class="newmodal" data-panel="{&quot;onCancelButton&quot;:&quot;CModal.DismissActiveModal()&quot;}" style="position: fixed; z-index: 1000; max-width: 841px; left: 210px; top: 338px;"><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close" data-panel="{&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"></div><div class="title_text">Add Friend</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 726px;"><div>Error adding friend. Please try again.</div><div class="newmodal_buttons" data-panel="{&quot;flow-children&quot;:&quot;row&quot;}"><div class="btn_grey_steamui btn_medium" data-panel="{&quot;autoFocus&quot;:true,&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"><span>OK</span></div></div></div></div></div>`;
const ACCOUNT_BLOCKED_MODAL_HTML = `<div class="newmodal" data-panel="{&quot;onCancelButton&quot;:&quot;CModal.DismissActiveModal()&quot;}" style="position: fixed; z-index: 1000; max-width: 841px; left: 189px; top: 317px;"><div class="modal_top_bar"></div><div class="newmodal_header_border"><div class="newmodal_header"><div class="newmodal_close" data-panel="{&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"></div><div class="title_text">Add Friend</div></div></div><div class="newmodal_content_border"><div class="newmodal_content" style="max-height: 726px;"><div>The account has been blocked and is currently being checked by Steam Support. Please wait for the verification process to complete and try again.</div><div class="newmodal_buttons" data-panel="{&quot;flow-children&quot;:&quot;row&quot;}"><div class="btn_grey_steamui btn_medium" data-panel="{&quot;autoFocus&quot;:true,&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}"><span>OK</span></div></div></div></div></div>`;
const ADD_FRIEND_INVITE_BANNER_HTML = `<div class="invite_banner" id="invite_banner"><div class="invite_ctn"><div class="header">Invitation to connect</div><div class="content"><p>You have been invited to be friends on Steam!</p><div class="invite_banner_actions"><a class="btn_profile_action btn_medium" href="#" onclick="RedeemInviteToken( &quot;CCPJVDGJ&quot; );"><span>Add As Friend</span></a><a class="btn_profile_action btn_medium" href="https://steamcommunity.com/id/ktese"><span>Ignore</span></a></div></div></div></div>`;
const STEAM_SCREENSHOT_CLIP_DEFAULT = { x: 0, y: 122, width: 1920, height: 810 };
function normalizeProfileInput(input: string): { profileUrl: string; steamId: string | null } | null {
  const value = input.trim();
  const prepared = /^https?:\/\//i.test(value)
    ? value
    : (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value) ? `https://${value}` : value);
  if (/^7\d{15,16}$/.test(value)) {
    return { profileUrl: `https://steamcommunity.com/profiles/${value}/`, steamId: value };
  }
  try {
    const u = new URL(prepared);
    const host = u.hostname.toLowerCase();
    if (!host) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (host !== "steamcommunity.com" && host !== "my.steamchina.com") {
      return { profileUrl: u.toString(), steamId: null };
    }
    if (parts.length !== 2) return { profileUrl: u.toString(), steamId: null };
    const [kind, slug] = parts;
    if (kind === "profiles" && /^7\d{15,16}$/.test(slug)) {
      return { profileUrl: `https://${host}/profiles/${slug}/`, steamId: slug };
    }
    if (kind === "id" && /^[A-Za-z0-9_-]{2,64}$/.test(slug)) {
      return { profileUrl: `https://${host}/id/${slug}/`, steamId: null };
    }
    return { profileUrl: u.toString(), steamId: null };
  } catch {
    return null;
  }
}

async function makeSteamProfileScreenshot(
  profileUrl: string,
  options?: { showAddFriendErrorModal?: boolean; showAddFriendInviteBanner?: boolean; showAccountBlockedModal?: boolean },
) {
  const task = async () => {
    const isAddFriendRender = Boolean(options?.showAddFriendErrorModal || options?.showAddFriendInviteBanner);
    await ensureSteamRendererReady();
    if (isAddFriendRender) {
      if (!steamAddFriendPage || steamAddFriendPage.isClosed?.()) {
        await ensureSteamRendererReady();
      }
    } else if (!steamPage || steamPage.isClosed?.()) {
      await ensureSteamRendererReady();
    }
    const renderPage = isAddFriendRender ? steamAddFriendPage : steamPage;

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-"));
    const screenshotPath = path.join(tmpDir, `profile_${stamp}.png`);
    await renderPage.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (isAddFriendRender) {
      await ensureSteamProfileQuickLoaded(renderPage);
    } else {
      await ensureSteamProfileFullyLoaded(renderPage);
    }
    await renderPage.evaluate(({ actionsHtml }: { actionsHtml: string }) => {
      const actions = document.querySelector(".profile_header_actions") as HTMLElement | null;
      if (actions) actions.innerHTML = actionsHtml;
    }, { actionsHtml: PROFILE_ACTIONS_HTML });
    const screenshotClip = STEAM_SCREENSHOT_CLIP_DEFAULT;
    if (options?.showAddFriendInviteBanner) {
      await renderPage.evaluate(({ bannerHtml, clip }: { bannerHtml: string; clip: { x: number; y: number; width: number; height: number } }) => {
        document.querySelector("#invite_banner")?.remove();
        document.querySelector("#codex_invite_banner_style")?.remove();

        const style = document.createElement("style");
        style.id = "codex_invite_banner_style";
        style.textContent = `
          #invite_banner {
            background: linear-gradient(180deg, #6f8298 0%, #6a7f95 100%) !important;
            border-top: 1px solid rgba(255,255,255,.12) !important;
            border-bottom: 1px solid rgba(0,0,0,.25) !important;
            --btn-background: rgb(66, 76, 92) !important;
            --btn-background-hover: rgb(76, 86, 102) !important;
            --btn-outline: rgb(106, 126, 142) !important;
          }
          #invite_banner .invite_banner_actions {
            display: flex !important;
            gap: 12px !important;
            align-items: center !important;
          }
          #invite_banner .invite_banner_actions .btn_profile_action {
            border: 1px solid var(--btn-outline) !important;
            background-color: var(--btn-background) !important;
          }
          #invite_banner .invite_banner_actions .btn_profile_action span {
            background-color: var(--btn-background) !important;
            color: #dbe7f5 !important;
          }
          #invite_banner .invite_banner_actions .btn_profile_action:hover,
          #invite_banner .invite_banner_actions .btn_profile_action:hover > span {
            background-color: var(--btn-background-hover) !important;
            color: #ffffff !important;
          }
        `;
        document.head.appendChild(style);

        const container = document.querySelector("#responsive_page_template_content") as HTMLElement | null;
        if (container) {
          container.insertAdjacentHTML("afterbegin", bannerHtml);
        } else {
          document.body.insertAdjacentHTML("afterbegin", bannerHtml);
        }
        const banner = document.querySelector("#invite_banner") as HTMLElement | null;
        if (banner) {
          const rect = banner.getBoundingClientRect();
          if (rect.top < clip.y) {
            const delta = Math.ceil(clip.y - rect.top);
            const currentMargin = Number.parseFloat(window.getComputedStyle(banner).marginTop || "0") || 0;
            banner.style.marginTop = `${currentMargin + delta}px`;
          }
        }
      }, { bannerHtml: ADD_FRIEND_INVITE_BANNER_HTML, clip: screenshotClip });
    }
    if (options?.showAddFriendErrorModal) {
      await renderPage.evaluate(({ modalHtml, clip }: { modalHtml: string; clip: { x: number; y: number; width: number; height: number } }) => {
        document.querySelector(".newmodal_background")?.remove();
        document.querySelector(".newmodal")?.remove();

        const overlay = document.createElement("div");
        overlay.className = "newmodal_background";
        overlay.style.opacity = "0.8";
        overlay.style.top = `${clip.y}px`;
        overlay.style.height = `calc(100% - ${clip.y}px)`;
        document.body.appendChild(overlay);
        document.body.insertAdjacentHTML("beforeend", modalHtml);
        const modal = document.querySelector(".newmodal") as HTMLElement | null;
        if (modal) {
          modal.style.left = `${clip.x + clip.width / 2}px`;
          modal.style.top = `${clip.y + clip.height / 2}px`;
          modal.style.transform = "translate(-50%, -50%)";
          modal.style.border = "none";
          modal.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.45)";
          modal.style.overflow = "hidden";
          modal.querySelectorAll(".newmodal_header_border, .newmodal_content_border, .newmodal_content, .newmodal_buttons, .modal_top_bar").forEach((el) => {
            const node = el as HTMLElement;
            node.style.border = "none";
            node.style.boxShadow = "none";
          });
          modal.querySelectorAll(".shadow_ul, .shadow_top, .shadow_ur, .shadow_left, .shadow_right, .shadow_bl, .shadow_bottom, .shadow_br").forEach((el) => el.remove());
        }
      }, { modalHtml: ADD_FRIEND_ERROR_MODAL_HTML, clip: screenshotClip });
    }
    if (options?.showAccountBlockedModal) {
      await renderPage.evaluate(({ modalHtml, clip }: { modalHtml: string; clip: { x: number; y: number; width: number; height: number } }) => {
        document.querySelector(".newmodal_background")?.remove();
        document.querySelector(".newmodal")?.remove();

        const overlay = document.createElement("div");
        overlay.className = "newmodal_background";
        overlay.style.opacity = "0.8";
        overlay.style.top = `${clip.y}px`;
        overlay.style.height = `calc(100% - ${clip.y}px)`;
        document.body.appendChild(overlay);
        document.body.insertAdjacentHTML("beforeend", modalHtml);
        const modal = document.querySelector(".newmodal") as HTMLElement | null;
        if (modal) {
          modal.style.left = `${clip.x + clip.width / 2}px`;
          modal.style.top = `${clip.y + clip.height / 2}px`;
          modal.style.transform = "translate(-50%, -50%)";
          modal.style.border = "none";
          modal.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.45)";
          modal.style.overflow = "hidden";
          modal.querySelectorAll(".newmodal_header_border, .newmodal_content_border").forEach((el) => {
            (el as HTMLElement).style.border = "none";
          });
        }
      }, { modalHtml: ACCOUNT_BLOCKED_MODAL_HTML, clip: screenshotClip });
    }
    await renderPage.waitForTimeout(55);
    await renderPage.evaluate(() => window.scrollTo(0, 0));
    await renderPage.screenshot({
      path: screenshotPath,
      clip: screenshotClip,
    });
    return screenshotPath;
  };
  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}

async function ensureSteamProfileQuickLoaded(page: any) {
  await page.waitForLoadState("domcontentloaded", { timeout: 1200 }).catch(() => null);
  await Promise.race([
    (async () => {
      await page.waitForLoadState("networkidle", { timeout: 4200 }).catch(() => null);
      await page.waitForTimeout(220).catch(() => null);
    })(),
    page.waitForTimeout(4200),
  ]).catch(() => null);
  await page.waitForSelector(".profile_page, .responsive_page_template_content", { timeout: 500 }).catch(() => null);
}

async function ensureSteamProfileFullyLoaded(page: any) {
  await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => null);
  await page
    .evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, Math.floor((maxY * i) / steps));
        await sleep(70);
      }
      window.scrollTo(0, 0);
    })
    .catch(() => null);
  await page
    .waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
        if (!imgs.length) return false;
        const relevant = imgs.filter((img) => {
          const src = img.currentSrc || img.src || "";
          return src.includes("steamstatic.com") || src.includes("steamcommunity");
        });
        const set = relevant.length ? relevant : imgs;
        const loaded = set.filter((img) => img.complete && (img.naturalWidth || 0) > 0).length;
        return loaded / set.length >= 0.9;
      },
      { timeout: 2200, polling: 120 },
    )
    .catch(() => null);
}

async function warmupSteamRenderer() {
  try {
    await ensureSteamRendererReady();
    const targets = [steamPage, steamAddFriendPage, steamSourcePage].filter(Boolean);
    await Promise.all(
      targets.map((p: any) =>
        p.goto("https://steamcommunity.com/", { waitUntil: "domcontentloaded", timeout: 4500 }).catch(() => null),
      ),
    );
  } catch {}
}

async function cleanupSteamTempDirs() {
  try {
    const base = process.cwd();
    const entries = await fs.readdir(base, { withFileTypes: true });
    const targets = entries
      .filter((e) => e.isDirectory() && (/^\.tmp-steam-/i.test(e.name) || /^\.tmp-steam-template-/i.test(e.name)))
      .map((e) => path.join(base, e.name));
    await Promise.all(targets.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => null)));
  } catch {}
}

async function fetchSteamProfileData(
  profileUrl: string,
): Promise<{
  name: string;
  avatarFull: string | null;
  avatarMedium: string | null;
  avatarIcon: string | null;
  avatarFrame: string | null;
  level: string | null;
  levelClass: string | null;
  profilePageHtml: string | null;
  bodyClass: string | null;
  headerContentHtml: string | null;
  badgeHtml: string | null;
  rightColHtml: string | null;
} | null> {
  const cached = steamProfileCache.get(profileUrl);
  const now = Date.now();
  if (cached && now - cached.updatedAt < 10 * 60 * 1000) {
    return {
      name: cached.name,
      avatarFull: cached.avatarFull,
      avatarMedium: cached.avatarMedium,
      avatarIcon: cached.avatarIcon,
      avatarFrame: cached.avatarFrame || null,
      level: cached.level,
      levelClass: cached.levelClass,
      profilePageHtml: cached.profilePageHtml,
      bodyClass: cached.bodyClass,
      headerContentHtml: cached.headerContentHtml,
      badgeHtml: cached.badgeHtml,
      rightColHtml: cached.rightColHtml,
    };
  }
  try {
    const normalized = profileUrl.replace(/\/+$/, "");
    await ensureSteamRendererReady();
    if (!steamSourcePage || steamSourcePage.isClosed?.()) {
      await ensureSteamRendererReady();
    }
    await steamSourcePage.goto(normalized, { waitUntil: "domcontentloaded", timeout: 7000 });
    await steamSourcePage.waitForTimeout(90);
    const parsed = (await steamSourcePage.evaluate(() => {
      const name = (document.querySelector(".actual_persona_name") as HTMLElement | null)?.innerText?.trim() || "";
      const lvlNode = document.querySelector(".friendPlayerLevelNum") as HTMLElement | null;
      const level = lvlNode?.innerText?.trim() || null;
      const lvlWrap = document.querySelector(".friendPlayerLevel") as HTMLElement | null;
      let levelClass: string | null = null;
      if (lvlWrap?.className) {
        const m = lvlWrap.className.match(/\blvl_\d+\b/);
        levelClass = m ? m[0] : null;
      }
      const avatarCandidates = Array.from(
        document.querySelectorAll(".playerAvatarAutoSizeInner img, .playerAvatar img"),
      ) as HTMLImageElement[];
      const nonFrame = avatarCandidates.filter((img) => !img.closest(".profile_avatar_frame"));
      const pick = (arr: HTMLImageElement[]) =>
        arr.find((img) => {
          const srcset = String(img.getAttribute("srcset") || "");
          const src = String(img.getAttribute("src") || img.src || "");
          const u = `${srcset} ${src}`.toLowerCase();
          return /_full\.(jpg|png|webp)/.test(u) || /avatars\./.test(u);
        }) || arr[0] || null;
      const avatarImg = pick(nonFrame) || pick(avatarCandidates);
      const rawSet = String(avatarImg?.getAttribute("srcset") || "").split(",")[0]?.trim() || "";
      const avatarFull = rawSet.split(" ")[0] || avatarImg?.getAttribute("src") || avatarImg?.src || null;
      const rightColHtml = (document.querySelector(".profile_rightcol") as HTMLElement | null)?.outerHTML || null;
      const badgeHtml = (document.querySelector(".profile_header_badge") as HTMLElement | null)?.outerHTML || null;
      const headerContentHtml = (document.querySelector(".profile_header_content") as HTMLElement | null)?.outerHTML || null;
      const profilePageHtml = (document.querySelector(".profile_page") as HTMLElement | null)?.outerHTML || null;
      const bodyClass = document.body?.className || null;
      const frameImg =
        (document.querySelector(".profile_avatar_frame img") as HTMLImageElement | null) ||
        (document.querySelector(".profile_avatar_frame source[srcset]") as HTMLSourceElement | null);
      const frameRaw = String(frameImg?.getAttribute("srcset") || frameImg?.getAttribute("src") || "").split(",")[0]?.trim() || "";
      const avatarFrame = frameRaw.split(" ")[0] || null;
      return { name, level, levelClass, avatarFull, avatarFrame, rightColHtml, badgeHtml, headerContentHtml, profilePageHtml, bodyClass };
    })) as any;
    if (parsed?.name) {
      const toAbs = (u: string | null) => {
        if (!u) return null;
        try {
          return new URL(u, `${normalized}/`).toString();
        } catch {
          return u;
        }
      };
      const avatarFull = toAbs(parsed.avatarFull || null);
      const avatarFrame = toAbs(parsed.avatarFrame || null);
      const avatarMedium = avatarFull ? avatarFull.replace(/_full\.jpg$/i, "_medium.jpg") : null;
      const avatarIcon = avatarFull ? avatarFull.replace(/_full\.jpg$/i, ".jpg") : null;
      const item = {
        name: parsed.name,
        avatarFull,
        avatarMedium,
        avatarIcon,
        avatarFrame,
        level: parsed.level || null,
        levelClass: parsed.levelClass || null,
        profilePageHtml: parsed.profilePageHtml || null,
        bodyClass: parsed.bodyClass || null,
        headerContentHtml: parsed.headerContentHtml || null,
        badgeHtml: parsed.badgeHtml || null,
        rightColHtml: parsed.rightColHtml || null,
      };
      steamProfileCache.set(profileUrl, { ...item, updatedAt: now });
      return item;
    }
  } catch {}
  try {
    const target = `https://steamcommunity.com/oembed?url=${encodeURIComponent(profileUrl)}`;
    const res = await fetch(target);
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const raw = String(data?.author_name || data?.title || "").trim();
    const name = raw.replace(/^Steam Community ::\s*/i, "").trim();
    if (name) {
      steamProfileCache.set(profileUrl, {
        name,
        avatarFull: null,
        avatarMedium: null,
        avatarIcon: null,
        avatarFrame: null,
        level: null,
        levelClass: null,
        profilePageHtml: null,
        bodyClass: null,
        headerContentHtml: null,
        badgeHtml: null,
        rightColHtml: null,
        updatedAt: now,
      });
      return {
        name,
        avatarFull: null,
        avatarMedium: null,
        avatarIcon: null,
        avatarFrame: null,
        level: null,
        levelClass: null,
        profilePageHtml: null,
        bodyClass: null,
        headerContentHtml: null,
        badgeHtml: null,
        rightColHtml: null,
      };
    }
    return null;
  } catch {
    return null;
  }
}


async function makeSteamFriendPageFromTemplateScreenshot(profileUrl: string) {
  const task = async () => {
    await ensureSteamRendererReady();
    const profile = await fetchSteamProfileData(profileUrl);
    if (!profile?.name) {
      throw new Error("profile_data_not_found");
    }
    if (!steamTemplatePage || steamTemplatePage.isClosed?.()) {
      await ensureSteamRendererReady();
    }
    const page = steamTemplatePage;

    const templatePath = await resolveSteamFriendTemplatePath();
    const templateDir = path.dirname(templatePath);
    const templateRaw = await fs.readFile(templatePath, "utf8");
    const filesDirs = (await fs.readdir(templateDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /_files$/i.test(d.name))
      .map((d) => d.name);
    const fallbackFilesDir =
      filesDirs.find((n) => n.toLowerCase().includes("ryan cooper")) ||
      filesDirs.find((n) => n.toLowerCase().includes("steam community __")) ||
      filesDirs[0] ||
      "";
    const filesAbsDir = fallbackFilesDir ? path.join(templateDir, fallbackFilesDir).replace(/\\/g, "/") : "";
    const filesBase = filesAbsDir ? `file:///${filesAbsDir}/` : "";
    const templateHtml = filesBase
      ? templateRaw
          .replace(/(["'(])(?:\.\/)?[^"'()]*_files\//g, `$1${filesBase}`)
          .replace(/(["'(])(?:\.\/)?images\//g, `$1${filesBase}images/`)
      : templateRaw;
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-steam-template-"));
    const tempHtmlPath = path.join(tmpDir, `friend_page_${stamp}.html`);
    const screenshotPath = path.join(tmpDir, `friend_page_${stamp}.png`);
    await fs.writeFile(tempHtmlPath, templateHtml, "utf8");
    await page.goto(`file:///${tempHtmlPath.replace(/\\/g, "/")}`, {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    await page.waitForTimeout(110);

    await page.evaluate((data: { name: string; avatarFull: string | null; avatarMedium: string | null; avatarFrame: string | null; friendCode: string; inviteLink: string }) => {
      const setText = (selector: string, value: string) => {
        const el = document.querySelector(selector);
        if (el) el.textContent = value;
      };
      const setAttr = (selector: string, attr: string, value: string | null) => {
        if (!value) return;
        const el = document.querySelector(selector) as HTMLElement | null;
        if (el) el.setAttribute(attr, value);
      };

      setText(".friends_header_name a", data.name);
      setText(".responsive_menu_user_persona .persona a[data-miniprofile]", data.name);

      const avatar = data.avatarFull || data.avatarMedium;
      const resolveAbs = (url: string | null) => {
        if (!url) return null;
        try {
          return new URL(url, location.href).toString();
        } catch {
          return url;
        }
      };
      const avatarAbs = resolveAbs(avatar);

      setAttr(".friends_header_avatar img", "src", avatar);
      setAttr(".friends_header_avatar img", "alt", data.name);
      setAttr(".friends_header_avatar img", "srcset", avatarAbs);

      setAttr(".responsive_menu_user_persona .playerAvatar img", "src", avatarAbs);
      setAttr(".responsive_menu_user_persona .playerAvatar img", "alt", data.name);

      const avatarPictureImg = document.querySelector(".playerAvatarAutoSizeInner > picture:last-of-type img") as HTMLImageElement | null;
      if (avatarPictureImg && avatarAbs) {
        avatarPictureImg.setAttribute("src", avatarAbs);
        avatarPictureImg.setAttribute("srcset", avatarAbs);
      }
      const avatarPictureSources = document.querySelectorAll(".playerAvatarAutoSizeInner > picture:last-of-type source");
      avatarPictureSources.forEach((s) => {
        if (avatarAbs) s.setAttribute("srcset", avatarAbs);
      });
      // Do not touch generic avatar/background selectors; they cause visual artifacts in some templates.

      const frameAbs = resolveAbs(data.avatarFrame);
      const frameImg = document.querySelector(".playerAvatarAutoSizeInner .profile_avatar_frame img") as HTMLImageElement | null;
      if (frameImg && frameAbs) {
        frameImg.setAttribute("src", frameAbs);
        frameImg.setAttribute("srcset", frameAbs);
      }
      const frameSources = document.querySelectorAll(".playerAvatarAutoSizeInner .profile_avatar_frame source");
      frameSources.forEach((s) => {
        if (frameAbs) s.setAttribute("srcset", frameAbs);
      });

      // Fallback for templates that only have a plain avatar block (no frame container).
      const simpleAvatarWrap = document.querySelector(".friends_header_avatar") as HTMLElement | null;
      const simpleAvatarImg = simpleAvatarWrap?.querySelector("img") as HTMLImageElement | null;
      if (simpleAvatarWrap && simpleAvatarImg && frameAbs) {
        const overlayHost =
          (document.querySelector(".friends_header_ctn") as HTMLElement | null) ||
          (simpleAvatarWrap.parentElement as HTMLElement | null) ||
          simpleAvatarWrap;
        overlayHost.style.position = overlayHost.style.position || "relative";
        overlayHost.style.overflow = "visible";
        simpleAvatarImg.style.position = "relative";
        simpleAvatarImg.style.zIndex = "1";
        let overlay = overlayHost.querySelector(".codex-avatar-frame-overlay") as HTMLImageElement | null;
        if (!overlay) {
          overlay = document.createElement("img");
          overlay.className = "codex-avatar-frame-overlay";
          overlay.style.position = "absolute";
          overlay.style.transform = "none";
          overlay.style.objectFit = "contain";
          overlay.style.pointerEvents = "none";
          overlay.style.zIndex = "3";
          overlayHost.appendChild(overlay);
        }
        overlay.setAttribute("src", frameAbs);
        const imgRect = simpleAvatarImg.getBoundingClientRect();
        const hostRect = overlayHost.getBoundingClientRect();
        const left = imgRect.left - hostRect.left;
        const top = imgRect.top - hostRect.top;
        const scale = 1.22;
        const dx = (imgRect.width * (scale - 1)) / 2;
        const dy = (imgRect.height * (scale - 1)) / 2;
        overlay.style.left = `${left - dx}px`;
        overlay.style.top = `${top - dy}px`;
        overlay.style.width = `${imgRect.width * scale}px`;
        overlay.style.height = `${imgRect.height * scale}px`;
      }

      const codeEl = Array.from(document.querySelectorAll("h1, div, span"))
        .find((el) => /^\d{8,}$/.test((el.textContent || "").trim())) as HTMLElement | undefined;
      if (codeEl) codeEl.textContent = data.friendCode;

      const quickInviteEl =
        (document.querySelector("._1HjkZ3ooQw-4TV518YPtvp ._18Sc08YQfmAIVx8H1h8A1V") as HTMLElement | null) ||
        (Array.from(document.querySelectorAll("div, span, a"))
          .find((el) => /^https?:\/\/s\.team\//i.test((el.textContent || "").trim())) as HTMLElement | undefined) ||
        null;
      if (quickInviteEl) quickInviteEl.textContent = data.inviteLink;

      const inviteSearchInput = Array.from(document.querySelectorAll("input[placeholder]")).find((el) =>
        /(enter|profile|invitation|link)/i.test(((el as HTMLInputElement).placeholder || "").trim()),
      ) as HTMLInputElement | undefined;
      if (inviteSearchInput) {
        inviteSearchInput.placeholder = "Enter the profile link from the invitation";
      }
    }, {
      name: profile.name,
      avatarFull: profile.avatarFull,
      avatarMedium: profile.avatarMedium,
      avatarFrame: profile.avatarFrame,
      friendCode: "11016760945",
      inviteLink: profileUrl,
    });

    await page
      .waitForFunction(
        () => {
          const images = Array.from(document.querySelectorAll(".playerAvatarAutoSizeInner img, .friends_header_avatar img")) as HTMLImageElement[];
          if (!images.length) return true;
          return images.every((img) => img.complete && (img.naturalWidth || 0) > 0);
        },
        { timeout: 700, polling: 80 },
      )
      .catch(() => null);
    await page.screenshot({
      path: screenshotPath,
      clip: STEAM_SCREENSHOT_CLIP_DEFAULT,
    });
    return screenshotPath;
  };

  const run = steamRenderChain.then(task, task);
  steamRenderChain = run.then(() => undefined, () => undefined);
  return run;
}
async function getUsdRubRate(): Promise<number> {
  const now = Date.now();
  if (now - usdRubCache.updatedAt < 10 * 60 * 1000) return usdRubCache.rate;
  try {
    const res: any = await (globalThis as any).fetch("https://open.er-api.com/v6/latest/USD");
    const json: any = await res.json();
    const rate = Number(json?.rates?.RUB);
    if (!Number.isNaN(rate) && rate > 0) {
      usdRubCache = { rate, updatedAt: now };
      return rate;
    }
  } catch {}
  return usdRubCache.rate;
}

async function getUsdUahRate(): Promise<number> {
  const now = Date.now();
  if (now - usdUahCache.updatedAt < 10 * 60 * 1000) return usdUahCache.rate;
  try {
    const res: any = await (globalThis as any).fetch("https://open.er-api.com/v6/latest/USD");
    const json: any = await res.json();
    const rate = Number(json?.rates?.UAH);
    if (!Number.isNaN(rate) && rate > 0) {
      usdUahCache = { rate, updatedAt: now };
      return rate;
    }
  } catch {}
  return usdUahCache.rate;
}

function cleanUiText(input: any, fallback = ""): string {
  const raw = String(input ?? "").trim();
  if (!raw) return fallback;
  const fixed = String(maybeFixMojibake(raw));
  if (/\uFFFD/.test(fixed)) return fallback || "??? ????????";
  return fixed;
}

function escapeMdV2(input: string): string {
  return input.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

async function fetchTextSafe(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function buildRentMenuKeyboard(user: any) {
  const rows = db.prepare("SELECT * FROM rentals ORDER BY id DESC LIMIT 50").all() as any[];
  const kb: any[] = [];
  for (const r of rows) {
    const status = r.is_busy ? "🔴" : "🟢";
    kb.push([Markup.button.callback(`${status} | ${cleanUiText(r.title, `Аккаунт #${r.number}`)} #${r.number}`, `rent:view:${r.number}`)]);
  }
  if (hasRole(user, ["ADMIN", "LANDLORD"])) {
    kb.push([
      Markup.button.callback("➕ Добавить", "rent:add:start"),
      Markup.button.callback("✏️ Редактировать", "rent:edit:pick"),
      Markup.button.callback("🗑️ Удалить", "rent:del:pick"),
    ]);
  }
  return Markup.inlineKeyboard(kb);
}

async function renderRentMenu(ctx: Ctx, user: any) {
  const text =
    `<tg-emoji emoji-id="5242657215751426928">🖌️</tg-emoji> <b>Аренда аккаунта.</b> ` +
    `Возможность арендовать аккаунт и начать работать без вложений чтобы дойти до первого профита.`;
  const extra = { parse_mode: "HTML" as const, reply_markup: buildRentMenuKeyboard(user).reply_markup };
  if (ctx.updateType === "callback_query" && typeof ctx.editMessageText === "function") {
    await ctx.editMessageText(text, extra).catch(async () => {
      const msg = await ctx.reply(text, extra);
      if (ctx.from?.id && msg?.message_id) uiPromptMsg.set(ctx.from.id, msg.message_id);
    });
    return;
  }
  const msg = await ctx.reply(text, extra);
  if (ctx.from?.id && msg?.message_id) uiPromptMsg.set(ctx.from.id, msg.message_id);
}

async function renderRentCard(ctx: Ctx, num: number, user: any) {
  const rent = db.prepare("SELECT * FROM rentals WHERE number = ?").get(num) as any;
  if (!rent) return void (await ctx.answerCbQuery?.("Не найдено"));
  const status = rent.is_busy ? "🔴 Занят" : "🟢 Свободен";
  const title = cleanUiText(rent.title, `Аккаунт #${rent.number}`);
  const desc = cleanUiText(rent.description, "-");
  const kb: any[] = [];
  if (!rent.is_busy) kb.push([Markup.button.callback("📩 Запросить", `rent:req:${rent.number}`)]);
  kb.push([Markup.button.callback("◀️ Назад", "rent:menu")]);
  await replaceOrReply(
    ctx,
    `<b>${escapeHtml(title)} #${rent.number}</b>\n${status}\n\n<b>Описание:</b>\n${escapeHtml(desc)}`,
    { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(kb).reply_markup },
  );
}

async function fetchJsonSafe(url: string): Promise<any | null> {
  const text = await fetchTextSafe(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function resolveSteamId64FromProfileUrl(profileUrl: string): Promise<string | null> {
  const normalized = normalizeProfileInput(profileUrl)?.profileUrl || profileUrl;
  const cached = steamIdResolveCache.get(normalized);
  if (cached && Date.now() - cached.updatedAt < 30 * 60 * 1000) return cached.steamId;

  const m = normalized.match(/\/profiles\/(7\d{15,16})\/?$/i);
  if (m?.[1]) {
    steamIdResolveCache.set(normalized, { steamId: m[1], updatedAt: Date.now() });
    return m[1];
  }

  const vanity = normalized.match(/\/id\/([A-Za-z0-9_-]{2,64})\/?$/i)?.[1] || null;
  if (!vanity) return null;
  if (STEAM_WEB_API_KEY) {
    try {
      const u = new URL("https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/");
      u.searchParams.set("key", STEAM_WEB_API_KEY);
      u.searchParams.set("vanityurl", vanity);
      const json: any = await fetchJsonSafe(u.toString());
      const id = String(json?.response?.steamid || "").trim();
      if (/^7\d{15,16}$/.test(id)) {
        steamIdResolveCache.set(normalized, { steamId: id, updatedAt: Date.now() });
        return id;
      }
    } catch {}
  }

  // Fallback: lightweight XML endpoint to resolve vanity without loading profile HTML.
  try {
    const xmlUrl = `${normalized.replace(/\/+$/, "/")}?xml=1`;
    const xml = await fetchTextSafe(xmlUrl);
    if (!xml) return null;
    const id = xml.match(/<steamID64>\s*(7\d{15,16})\s*<\/steamID64>/i)?.[1];
    if (id) {
      steamIdResolveCache.set(normalized, { steamId: id, updatedAt: Date.now() });
      return id;
    }
  } catch {}

  return null;
}

async function detectSteamProfileOnline(profileUrl: string): Promise<boolean | null> {
  if (STEAMWEBAPI_KEY) {
    try {
      const normalized = normalizeProfileInput(profileUrl);
      const idParam = normalized?.steamId || normalized?.profileUrl || profileUrl;
      const u = new URL("/steam/api/profile", `${STEAMWEBAPI_BASE_URL}/`);
      u.searchParams.set("key", STEAMWEBAPI_KEY);
      u.searchParams.set("id", idParam);
      u.searchParams.set("format", "json");
      u.searchParams.set("production", "1");
      u.searchParams.set("no_cache", "1");
      const json: any = await fetchJsonSafe(u.toString());
      const onlineState = String(json?.onlinestate || "").toLowerCase().trim();
      if (onlineState) return onlineState !== "offline";
    } catch {}
  }

  const steamId = await resolveSteamId64FromProfileUrl(profileUrl);
  if (!steamId) return null;

  if (STEAM_WEB_API_KEY) {
    try {
      const u = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
      u.searchParams.set("key", STEAM_WEB_API_KEY);
      u.searchParams.set("steamids", steamId);
      const json: any = await fetchJsonSafe(u.toString());
      const player = json?.response?.players?.[0];
      const state = Number(player?.personastate);
      if (!Number.isNaN(state)) return state > 0;
    } catch {}
  }

  // Fallback when API key is missing: XML status only.
  try {
    const xmlUrl = `https://steamcommunity.com/profiles/${steamId}/?xml=1`;
    const xml = await fetchTextSafe(xmlUrl);
    if (!xml) return null;
    if (/<onlineState>\s*online\s*<\/onlineState>/i.test(xml)) return true;
    if (/<onlineState>\s*offline\s*<\/onlineState>/i.test(xml)) return false;
  } catch {}
  return null;
}

async function runOnlineWatchTick() {
  const rows = db
    .prepare(
      "SELECT ow.id, ow.profile_url, ow.comment, u.tg_id FROM online_watch ow JOIN users u ON u.id = ow.user_id ORDER BY ow.id ASC",
    )
    .all() as Array<{ id: number; profile_url: string; comment: string | null; tg_id: number }>;

  const activeIds = new Set(rows.map((x) => x.id));
  for (const [watchId] of onlineWatchRuntime.entries()) {
    if (!activeIds.has(watchId)) {
      onlineWatchRuntime.delete(watchId);
    }
  }
  for (const [watchId] of onlineWatchProbeState.entries()) {
    if (!activeIds.has(watchId)) {
      onlineWatchProbeState.delete(watchId);
    }
  }

  for (const row of rows) {
    const runtime = onlineWatchRuntime.get(row.id);
    const now = Date.now();
    let isOnline: boolean | null = null;

    if (runtime) {
      if (now - runtime.lastStatusCheckAt >= 30000) {
        isOnline = await detectSteamProfileOnline(row.profile_url);
      }
    } else {
      const probe = onlineWatchProbeState.get(row.id) || { lastStatusCheckAt: 0, onlineStreak: 0 };
      if (now - probe.lastStatusCheckAt >= 30000) {
        isOnline = await detectSteamProfileOnline(row.profile_url);
        probe.lastStatusCheckAt = now;
      }
      onlineWatchProbeState.set(row.id, probe);
    }

    if (isOnline === null && !runtime) continue;
    if (isOnline === null && runtime) {
      const elapsedSec = Math.max(0, Math.floor((now - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOnlineText(runtime.profileUrl, runtime.comment, elapsedSec),
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        )
        .catch(() => null);
      continue;
    }

    if (isOnline) {
      if (!runtime) {
        const probe = onlineWatchProbeState.get(row.id) || { lastStatusCheckAt: now, onlineStreak: 0 };
        probe.onlineStreak += 1;
        onlineWatchProbeState.set(row.id, probe);
        if (probe.onlineStreak < 2) continue;
        const msg = await bot.telegram
          .sendMessage(row.tg_id, formatOnlineWatchOnlineText(row.profile_url, row.comment, 0), {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          })
          .catch(() => null);
        if (!msg?.message_id) continue;
        onlineWatchRuntime.set(row.id, {
          onlineSince: Date.now(),
          messageChatId: row.tg_id,
          messageId: msg.message_id,
          profileUrl: row.profile_url,
          comment: row.comment || null,
          lastStatusCheckAt: now,
        });
        onlineWatchProbeState.delete(row.id);
        continue;
      }

      runtime.lastStatusCheckAt = now;
      const elapsedSec = Math.max(0, Math.floor((now - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOnlineText(runtime.profileUrl, runtime.comment, elapsedSec),
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        )
        .catch(() => null);
      continue;
    }

    if (runtime) {
      runtime.lastStatusCheckAt = now;
      const elapsedSec = Math.max(0, Math.floor((Date.now() - runtime.onlineSince) / 1000));
      await bot.telegram
        .editMessageText(
          runtime.messageChatId,
          runtime.messageId,
          undefined,
          formatOnlineWatchOfflineText(runtime.profileUrl, runtime.comment, elapsedSec),
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        )
        .catch(() => null);
      onlineWatchRuntime.delete(row.id);
      onlineWatchProbeState.set(row.id, { lastStatusCheckAt: now, onlineStreak: 0 });
      continue;
    }

    const probe = onlineWatchProbeState.get(row.id);
    if (probe) {
      probe.onlineStreak = 0;
      onlineWatchProbeState.set(row.id, probe);
    }
  }
}

function startOnlineWatchLoop() {
  if (onlineWatchLoopStarted) return;
  onlineWatchLoopStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnlineWatchTick();
    } catch {}
    running = false;
  };
  void tick();
  setInterval(() => void tick(), 1000);
}

async function sendCleanPrompt(ctx: Ctx, text: string, extra?: any) {
  const uid = ctx.from?.id;
  const mode = uid ? String(state.get(uid)?.mode || "") : "";
  const replacePrevPrompt = mode.startsWith("rental_add_") || mode === "online_watch_profile_input" || mode === "online_watch_comment_input";
  if (uid && uiPromptMsg.has(uid)) {
    const prev = uiPromptMsg.get(uid)!;
    if (replacePrevPrompt) {
      const edited = await ctx.telegram
        .editMessageText(ctx.chat.id, prev, undefined, text, extra)
        .then(() => true)
        .catch(() => false);
      if (edited) return { message_id: prev };
    }
  }
  const msg = await ctx.reply(text, extra);
  if (uid && msg?.message_id) uiPromptMsg.set(uid, msg.message_id);
  return msg;
}

async function replaceOrReply(ctx: Ctx, text: string, extra?: any) {
  if (ctx.updateType === "callback_query" && typeof ctx.editMessageText === "function") {
    const edited = await ctx
      .editMessageText(text, extra)
      .then(() => true)
      .catch(async () => {
      await sendCleanPrompt(ctx, text, extra);
      return false;
    });
    if (edited && ctx.from?.id && "message" in (ctx.callbackQuery || {}) && (ctx.callbackQuery as any).message?.message_id) {
      uiPromptMsg.set(ctx.from.id, (ctx.callbackQuery as any).message.message_id);
    }
    return;
  }
  await sendCleanPrompt(ctx, text, extra);
}

async function clearWizardPrompt(ctx: Ctx) {
  const uid = ctx.from?.id;
  if (!uid) return;
  const mid = uiPromptMsg.get(uid);
  if (!mid) return;
  await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => null);
  uiPromptMsg.delete(uid);
}

async function parseWorkInput(input: string) {
  const steamRaw = input.trim();
  if (!steamRaw) return null;
  let steamId: string | null = null;
  if (/^7\d{15,18}$/.test(steamRaw)) {
    steamId = steamRaw;
  } else {
    const normalized = normalizeProfileInput(steamRaw);
    if (!normalized) return null;
    steamId = normalized.steamId || (await resolveSteamId64FromProfileUrl(normalized.profileUrl));
  }
  if (!steamId) return null;
  return { steamId };
}

function nextProfileCurrency(curr: string): "USD" | "RUB" | "UAH" {
  if (curr === "USD") return "RUB";
  if (curr === "RUB") return "UAH";
  return "USD";
}

async function formatProfile(u: any) {
  const roleCodes = rolesByUserId(u.id);
  const visibleRoles = roleCodes.filter((r) => r !== "USER");
  const displayRoles: Role[] = visibleRoles.length ? visibleRoles : ["USER"];
  const roleList = displayRoles.map((r) => roleLabelPlain[r]).join(" / ");
  const tg = u.tg_username ? `@${u.tg_username}` : `${u.tg_id}`;
  const sessionsGiven = Number(u.sessions_given || 0);
  const sessionsTaken = Number(u.sessions_taken || 0);
  const sessionsFailed = Number(u.sessions_failed || 0);
  const dodepUsd = Number(u.total_dodep_usd || 0);
  const dodepYuan = Number(u.total_dodep_yuan || 0);
  const totalUsd = Number(u.total_given_usd || 0);
  const dodepUsdFromYuan = Number(process.env.USD_CNY_RATE || 7.2) > 0 ? dodepYuan / Number(process.env.USD_CNY_RATE || 7.2) : 0;
  const payoutUsd = totalUsd * 0.7 + (dodepUsd + dodepUsdFromYuan) * 0.25;
  const usdCnyRate = Number(process.env.USD_CNY_RATE || 7.2);
  const currency = String(u.profile_currency || "USD").toUpperCase();
  let rate = 1;
  let symbol = "$";
  if (currency === "RUB") {
    rate = await getUsdRubRate();
    symbol = "₽";
  } else if (currency === "UAH") {
    rate = await getUsdUahRate();
    symbol = "₴";
  }
  const dodepFromUsd = dodepUsd * rate;
  const dodepFromYuan = usdCnyRate > 0 ? (dodepYuan / usdCnyRate) * rate : 0;
  const dodepTotal = dodepFromUsd + dodepFromYuan;
  const totalSum = totalUsd * rate;
  const payout = payoutUsd * rate;
  const money = (v: number) => `${v.toFixed(2)}${symbol}`;
  return (
    `<tg-emoji emoji-id="5240026767325961445">🔷</tg-emoji> <b>Информация</b>\n` +
    `├ Никнейм: <b>${escapeHtml(tg)}</b>\n` +
    `├ Discord: <b>${escapeHtml(u.discord_tag || "-")}</b>\n` +
    `├ ID: <b>${escapeHtml(String(u.id))}</b>\n` +
    `╰ Роль: <b>${escapeHtml(roleList)}</b>\n\n` +
    `<tg-emoji emoji-id="5240370704012059362">📊</tg-emoji> <b>Статистика</b>\n` +
    `├ Количество отданных сессий: <b>${escapeHtml(String(sessionsGiven))}</b>\n` +
    `├ Количество снятых сессий: <b>${escapeHtml(String(sessionsTaken))}</b>\n` +
    `├ Количество слетевших сессий: <b>${escapeHtml(String(sessionsFailed))}</b>\n` +
    `├ Количество додепов: <b>${escapeHtml(money(dodepTotal))}</b>\n` +
    `├ Общая сумма: <b>${escapeHtml(money(totalSum))}</b>\n` +
    `╰ Примерная сумма выплат: <b>${escapeHtml(money(payout))}</b>`
  );
}

async function renderOwnProfile(ctx: Ctx, me: any) {
  const refreshed = getUserByTgId(me.tg_id) || me;
  const current = String(refreshed.profile_currency || "USD").toUpperCase();
  const next = nextProfileCurrency(current);
  const text = await formatProfile(refreshed);
  const extra = {
    parse_mode: "HTML" as const,
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback(`Отображение в ${next}`, "profile:currency:toggle")]]).reply_markup,
  };
  // Discord CDN avatars can intermittently fail in Telegram (wrong type of web page content),
  // which breaks profile flow for some users. Keep profile delivery stable by sending text only.
  return ctx.reply(text, extra);
}

function formatAdminListDate(iso: string | null | undefined): string {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

async function renderAdminUsersPage(ctx: Ctx, pageRaw = 0) {
  const pageSize = 10;
  const total = Number((db.prepare("SELECT COUNT(*) c FROM users WHERE is_approved = 1 AND IFNULL(discord_tag,'') <> '' AND IFNULL(discord_tag,'-') <> '-'").get() as any)?.c || 0);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const offset = page * pageSize;
  const rows = db
    .prepare("SELECT id, tg_username, discord_tag, registered_at FROM users WHERE is_approved = 1 AND IFNULL(discord_tag,'') <> '' AND IFNULL(discord_tag,'-') <> '-' ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(pageSize, offset) as any[];

  const kbRows: any[] = rows.map((r) => {
    const rawDiscord = String(r.discord_tag || "-").trim();
    const discord = rawDiscord === "-" ? "-" : rawDiscord.startsWith("#") ? rawDiscord : `#${rawDiscord}`;
    const tgUsername = String(r.tg_username || "-").trim() || "-";
    return [Markup.button.callback(`#${r.id} ${discord} | ${tgUsername}`, `admin:usercard:${r.id}:${page}`)];
  });
  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("⬅️", `admin:userlist:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, "admin:userlist:noop"),
      Markup.button.callback("➡️", `admin:userlist:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }
  kbRows.push([Markup.button.callback("🔎 Поиск", `admin:userlist:search:${page}`)]);

  const text = `<b>Пользователи</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>`;
  if (ctx.updateType === "callback_query" && typeof (ctx as any).editMessageText === "function") {
    await (ctx as any)
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(kbRows).reply_markup,
      })
      .catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(kbRows).reply_markup }).catch(() => null);
      });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(kbRows).reply_markup });
  }
}

async function renderJoinRequestsPage(ctx: Ctx, pageRaw = 0) {
  const pageSize = 10;
  const total = Number((db.prepare("SELECT COUNT(*) c FROM join_requests WHERE status = 'PENDING'").get() as any)?.c || 0);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const offset = page * pageSize;
  const rows = db
    .prepare(
      "SELECT jr.id, jr.number, jr.discord_tag, u.tg_username, u.tg_id FROM join_requests jr LEFT JOIN users u ON u.id = jr.user_id WHERE jr.status = 'PENDING' ORDER BY jr.id DESC LIMIT ? OFFSET ?",
    )
    .all(pageSize, offset) as any[];

  const kbRows: any[] = rows.map((r) => {
    const userLabel = r.tg_username ? `@${r.tg_username}` : String(r.tg_id || "-");
    const discord = String(r.discord_tag || "-").trim() || "-";
    return [Markup.button.callback(`⌛️ ${userLabel} | ${discord}`, `join:list:open:${r.id}:${page}`)];
  });
  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("⬅️", `join:list:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, "join:list:noop"),
      Markup.button.callback("➡️", `join:list:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }

  const text = `<b>Заявки на вступление</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>`;
  if (ctx.updateType === "callback_query" && typeof (ctx as any).editMessageText === "function") {
    await (ctx as any)
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(kbRows).reply_markup,
      })
      .catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(kbRows).reply_markup }).catch(() => null);
      });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(kbRows).reply_markup });
  }
}

async function runAdminBroadcastFromMessage(ctx: Ctx, sourceMessageId: number) {
  const all = db.prepare("SELECT tg_id FROM users WHERE is_approved = 1 AND is_banned = 0").all() as any[];
  for (const u of all) {
    await bot.telegram
      .copyMessage(Number(u.tg_id), ctx.chat.id, sourceMessageId)
      .catch(() => null);
  }
}

async function renderAdminLogs(ctx: Ctx, pageRaw = 0, queryRaw = "") {
  const pageSize = 10;
  const query = String(queryRaw || "").trim();
  const where = query
    ? `WHERE LOWER(IFNULL(l.actor_role,'')) LIKE LOWER(?) OR LOWER(IFNULL(l.event_type,'')) LIKE LOWER(?) OR LOWER(IFNULL(l.details,'')) LIKE LOWER(?) OR LOWER(IFNULL(u.tg_username,'')) LIKE LOWER(?) OR LOWER(IFNULL(u.discord_tag,'')) LIKE LOWER(?)`
    : "";
  const args = query ? [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`] : [];
  const total = Number((db.prepare(`SELECT COUNT(*) c FROM logs l LEFT JOIN users u ON u.id = l.actor_user_id ${where}`).get(...args) as any)?.c || 0);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const offset = page * pageSize;
  const rows = db
    .prepare(
      `SELECT l.*, u.tg_username, u.discord_tag, u.tg_id FROM logs l LEFT JOIN users u ON u.id = l.actor_user_id ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, offset) as any[];

  const eventLabel = (e: string) =>
    ({
      text: "Текст",
      callback_query: "Кнопка",
      command: "Команда",
      join_request: "Заявка на вступление",
      work_request: "Заявка на добив",
      panel_request: "Проверка на панеле",
      rent_request: "Аренда аккаунта",
    } as Record<string, string>)[e] || e;
  const lines = rows.map((x) => {
    const at = String(x.created_at || "").replace("T", " ").replace("Z", "");
    const tg = x.tg_username ? `@${x.tg_username}` : `id:${x.tg_id || x.actor_tg_id || "-"}`;
    const discord = x.discord_tag || "-";
    return (
      `<blockquote>` +
      `Время: <b>${escapeHtml(at)}</b>\n` +
      `Роль: <b>${escapeHtml(String(x.actor_role || "USER"))}</b>\n` +
      `Событие: <b>${escapeHtml(eventLabel(String(x.event_type || "-")))}</b>\n` +
      `Пользователь: <b>${escapeHtml(tg)}</b>\n` +
      `Discord: <b>${escapeHtml(discord)}</b>\n` +
      `Детали: <b>${escapeHtml(String(x.details || "-"))}</b>` +
      `</blockquote>`
    );
  });
  const title = query
    ? `<b>Логи</b>\nПоиск: <b>${escapeHtml(query)}</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>\n\n`
    : `<b>Логи</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>\n\n`;
  const body = rows.length ? lines.join("\n") : "<blockquote>Ничего не найдено</blockquote>";
  const text = `${title}${body}`;

  const kbRows: any[] = [];
  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("⬅️", `logs:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, "logs:noop"),
      Markup.button.callback("➡️", `logs:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }
  kbRows.push([Markup.button.callback("🔎 Поиск", "logs:search")]);
  kbRows.push([Markup.button.callback("🧹 Сбросить поиск", "logs:clear")]);
  const extra = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true }, reply_markup: Markup.inlineKeyboard(kbRows).reply_markup };
  if (ctx.updateType === "callback_query" && typeof (ctx as any).editMessageText === "function") {
    await (ctx as any).editMessageText(text, extra).catch(() => null);
  } else {
    await ctx.reply(text, extra);
  }
}

async function renderAdminRequestList(ctx: Ctx, kind: "work" | "panel" | "rent", pageRaw = 0, queryRaw = "") {
  const pageSize = 10;
  const query = String(queryRaw || "").trim().toLowerCase();
  const rows =
    kind === "work"
      ? (db
          .prepare(
            "SELECT wr.id, wr.number, wr.steam_id, wr.status, wr.created_at, u.tg_username, u.discord_tag FROM work_requests wr LEFT JOIN users u ON u.id = wr.owner_id WHERE wr.status = 'PENDING' ORDER BY wr.id DESC",
          )
          .all() as any[])
      : (db
          .prepare(
            kind === "panel"
              ? "SELECT pr.id, pr.number, pr.steam_id, pr.status, pr.created_at, u.tg_username, u.discord_tag FROM panel_requests pr LEFT JOIN users u ON u.id = pr.user_id WHERE pr.status = 'PENDING' ORDER BY pr.id DESC"
              : "SELECT DISTINCT rrm.rental_id AS id, rt.number, rt.title AS steam_id, 'PENDING' AS status, '' AS created_at, u.tg_username, u.discord_tag, rrm.user_id FROM rent_request_messages rrm LEFT JOIN rentals rt ON rt.id = rrm.rental_id LEFT JOIN users u ON u.id = rrm.user_id WHERE IFNULL(rt.is_busy,0)=0 ORDER BY rrm.id DESC",
          )
          .all() as any[]);
  const filtered = query
    ? rows.filter((r) => {
        const blob = `${r.number || ""} ${r.steam_id || ""} ${r.status || ""} ${r.tg_username || ""} ${r.discord_tag || ""}`.toLowerCase();
        return blob.includes(query);
      })
    : rows;
  const total = filtered.length;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const page = Math.max(0, Math.min(pageRaw, maxPage));
  const slice = filtered.slice(page * pageSize, page * pageSize + pageSize);

  const kbRows: any[] = slice.map((r) => {
    const user = `@${r.tg_username || "-"}`;
    const discord = r.discord_tag || "-";
    const prefix = kind === "work" ? "⌛️ Добив" : kind === "panel" ? "⌛️ Проверка" : "⌛️ Аренда";
    const label = `${prefix} | ${user} | ${discord}`;
    const cb =
      kind === "work" ? `work:list:open:${r.id}:${page}` : kind === "panel" ? `panel:list:open:${r.id}:${page}` : `rent:list:open:${r.id}:${page}:${r.user_id || 0}`;
    return [Markup.button.callback(label, cb)];
  });
  if (maxPage > 0) {
    kbRows.push([
      Markup.button.callback("⬅️", `${kind}:list:page:${Math.max(0, page - 1)}`),
      Markup.button.callback(`${page + 1}/${maxPage + 1}`, `${kind}:list:noop`),
      Markup.button.callback("➡️", `${kind}:list:page:${Math.min(maxPage, page + 1)}`),
    ]);
  }
  kbRows.push([Markup.button.callback("🔎 Поиск", `${kind}:list:search`)]);
  if (query) kbRows.push([Markup.button.callback("🧹 Сбросить поиск", `${kind}:list:clear`)]);

  const title = kind === "work" ? "Заявки на добив" : kind === "panel" ? "Заявки на проверку" : "Заявки на аренду";
  const text = query
    ? `<b>${title}</b>\nПоиск: <b>${escapeHtml(query)}</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>`
    : `<b>${title}</b>\nСтраница: <b>${page + 1}/${Math.max(1, maxPage + 1)}</b>`;
  const extra = { parse_mode: "HTML" as const, reply_markup: Markup.inlineKeyboard(kbRows).reply_markup };
  if (ctx.updateType === "callback_query" && typeof (ctx as any).editMessageText === "function") {
    await (ctx as any).editMessageText(text, extra).catch(() => null);
  } else {
    await ctx.reply(text, extra);
  }
}

type StatsRangeKey = "today" | "week" | "month" | "year" | "all";

function getStatsRangeStartIso(range: StatsRangeKey): string | null {
  if (range === "all") return null;
  const now = new Date();
  const d = new Date(now);
  if (range === "today") {
    d.setHours(0, 0, 0, 0);
  } else if (range === "week") {
    d.setDate(d.getDate() - 7);
  } else if (range === "month") {
    d.setMonth(d.getMonth() - 1);
  } else if (range === "year") {
    d.setFullYear(d.getFullYear() - 1);
  }
  return d.toISOString();
}

function statsRangeLabel(range: StatsRangeKey): string {
  return (
    {
      today: "За сегодня",
      week: "За неделю",
      month: "За месяц",
      year: "За год",
      all: "За все время",
    }[range] || "За все время"
  );
}

async function renderAdminStats(ctx: Ctx, range: StatsRangeKey) {
  const fromIso = getStatsRangeStartIso(range);
  const totalUsers = Number((db.prepare("SELECT COUNT(*) c FROM users").get() as any)?.c || 0);
  const usdCnyRate = Number(process.env.USD_CNY_RATE || 7.2);

  const wrWhere = fromIso ? "WHERE created_at >= ?" : "";
  const wrArg = fromIso ? [fromIso] : [];
  const wrRows = db
    .prepare(`SELECT owner_id, worker_id, status, amount_usd, dodep_usd, dodep_yuan FROM work_requests ${wrWhere}`)
    .all(...wrArg) as Array<{ owner_id: number; worker_id: number | null; status: string; amount_usd: number; dodep_usd: number; dodep_yuan: number }>;

  const sessionsGiven = wrRows.length;
  const sessionsDone = wrRows.filter((r) => r.status === "COMPLETED").length;
  const sessionsFailed = wrRows.filter((r) => r.status === "FAILED").length;
  const dodepCount = wrRows.filter((r) => Number(r.dodep_usd || 0) > 0 || Number(r.dodep_yuan || 0) > 0).length;
  const sumGivenUsd = wrRows.reduce((acc, r) => acc + Number(r.amount_usd || 0), 0);
  const sumDoneUsd = wrRows.filter((r) => r.status === "COMPLETED").reduce((acc, r) => acc + Number(r.amount_usd || 0), 0);
  const sumFailedUsd = wrRows.filter((r) => r.status === "FAILED").reduce((acc, r) => acc + Number(r.amount_usd || 0), 0);
  const sumDodepUsd = wrRows.reduce((acc, r) => {
    const usd = Number(r.dodep_usd || 0);
    const yuan = Number(r.dodep_yuan || 0);
    const fromYuan = usdCnyRate > 0 ? yuan / usdCnyRate : 0;
    return acc + usd + fromYuan;
  }, 0);

  const activeUsers = new Set<number>();
  for (const r of wrRows) {
    if (Number(r.owner_id) > 0) activeUsers.add(Number(r.owner_id));
  }
  const activeRatio = totalUsers > 0 ? (activeUsers.size / totalUsers) * 100 : 0;
  const activityLabel = activeRatio < 10 ? "ужасная" : activeRatio < 25 ? "плохая" : activeRatio < 50 ? "хорошая" : "отличная";

  const workerIds = Array.from(new Set(wrRows.map((r) => Number(r.worker_id || 0)).filter((x) => x > 0)));
  const workerRoleMap = new Map<number, Set<string>>();
  for (const wid of workerIds) {
    const rs = db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(wid) as Array<{ role: string }>;
    workerRoleMap.set(wid, new Set(rs.map((x) => String(x.role))));
  }

  const eligibleOwnerIds = new Set<number>(
    (
      db
        .prepare(
          "SELECT DISTINCT user_id FROM user_roles WHERE role IN ('USER','CHATER','LANDLORD')",
        )
        .all() as Array<{ user_id: number }>
    ).map((x) => Number(x.user_id)),
  );

  const byOwner = new Map<number, { given: number; doneByStaff: number; failed: number }>();
  for (const r of wrRows) {
    const ownerId = Number(r.owner_id || 0);
    if (!ownerId || !eligibleOwnerIds.has(ownerId)) continue;
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, { given: 0, doneByStaff: 0, failed: 0 });
    const item = byOwner.get(ownerId)!;
    item.given += 1;
    if (r.status === "COMPLETED") {
      const wid = Number(r.worker_id || 0);
      const roles = workerRoleMap.get(wid) || new Set<string>();
      if (roles.has("ADMIN") || roles.has("DOBIVER")) item.doneByStaff += 1;
    }
    if (r.status === "FAILED") item.failed += 1;
  }

  let bestOwnerId = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestStats = { given: 0, doneByStaff: 0, failed: 0 };
  for (const [ownerId, s] of byOwner.entries()) {
    const score = s.given + s.doneByStaff * 2 - s.failed;
    const better =
      score > bestScore ||
      (score === bestScore &&
        (s.doneByStaff > bestStats.doneByStaff ||
          (s.doneByStaff === bestStats.doneByStaff && s.failed < bestStats.failed)));
    if (better) {
      bestOwnerId = ownerId;
      bestScore = score;
      bestStats = s;
    }
  }
  const bestUser = bestOwnerId ? (db.prepare("SELECT tg_username, discord_tag FROM users WHERE id = ?").get(bestOwnerId) as any) : null;
  const bestName = bestUser ? `@${bestUser.tg_username || bestUser.discord_tag || bestOwnerId}` : "-";
  const money = (v: number) => `$${v.toFixed(2)}`;

  const text =
    `<b>Статистика</b>\n` +
    `Период: <b>${statsRangeLabel(range)}</b>\n\n` +
    `Пользователей в боте: <b>${totalUsers}</b>\n` +
    `Общая активность пользователей: <b>${activityLabel}</b>\n` +
    `Отдано на добив: <b>${sessionsGiven}</b> | Сумма: <b>${money(sumGivenUsd)}</b>\n` +
    `Снятий: <b>${sessionsDone}</b> | Сумма снятий: <b>${money(sumDoneUsd)}</b>\n` +
    `Слетов: <b>${sessionsFailed}</b> | Сумма слетов: <b>${money(sumFailedUsd)}</b>\n` +
    `Додепов: <b>${dodepCount}</b> | Сумма додепов: <b>${money(sumDodepUsd)}</b>\n\n` +
    `Лучший работник: <b>${escapeHtml(bestName)}</b>\n` +
    `Отдал: <b>${bestStats.given}</b> | Снятые: <b>${bestStats.doneByStaff}</b> | Слетевшие: <b>${bestStats.failed}</b>`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(range === "today" ? "✓ Сегодня" : "Сегодня", "stats:range:today"),
      Markup.button.callback(range === "week" ? "✓ Неделя" : "Неделя", "stats:range:week"),
      Markup.button.callback(range === "month" ? "✓ Месяц" : "Месяц", "stats:range:month"),
    ],
    [
      Markup.button.callback(range === "year" ? "✓ Год" : "Год", "stats:range:year"),
      Markup.button.callback(range === "all" ? "✓ Все время" : "Все время", "stats:range:all"),
    ],
  ]).reply_markup;

  if (ctx.updateType === "callback_query" && typeof (ctx as any).editMessageText === "function") {
    await (ctx as any).editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => null);
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function renderDrawMenu(ctx: Ctx) {
  await replaceOrReply(
    ctx,
    `<tg-emoji emoji-id="5242657215751426928">🖌️</tg-emoji> <b>Отрисовка.</b> Позволяет максимально быстро создать нужный шаблон под рабочие задачи.`,
    {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("➕ Добавление в друзья", "draw:add_friend")],
        [Markup.button.callback("🧾 Страница друга", "draw:friend_page")],
        [Markup.button.callback("📱 QR-Код страница друга", "draw:qr_page")],
        [Markup.button.callback("🫥 Аккаунт заблокирован", "draw:acc_blocked")],
        [Markup.button.callback("⛏️ Бан CS2", "draw:ban_cs2")],
        [Markup.button.callback("⛏️ Код CS2", "draw:code_cs2")],
        [Markup.button.callback("⛏️ Бан DOTA 2", "draw:ban_dota2")],
      ]).reply_markup,
    },
  );
}

async function notifyWorkers(text: string, kb: any) {
  const users = db
    .prepare(
      "SELECT DISTINCT u.tg_id FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN notification_prefs np ON np.user_id = u.id WHERE r.role IN ('ADMIN','DOBIVER') AND IFNULL(np.notif_work,1)=1",
    )
    .all() as any[];
  for (const u of users) await bot.telegram.sendMessage(u.tg_id, text, kb).catch(() => null);
}


async function createWorkRequest(ctx: Ctx, raw: string) {
  const me = ensureUser(ctx);
  if (!me || !me.is_approved || me.is_banned) return;
  const parsed = await parseWorkInput(raw);
  if (!parsed) {
    await ctx.reply("Пришлите SteamID или ссылку на профиль Steam.");
    return;
  }
  const last = db.prepare("SELECT number FROM work_requests ORDER BY number DESC LIMIT 1").get() as any;
  const num = (last?.number ?? -1) + 1;
  const ins = db
    .prepare(
      "INSERT INTO work_requests (number, owner_id, steam_id, amount_usd, region, status, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)",
    )
    .run(num, me.id, parsed.steamId, 0, "-", nowIso());
  const q = db
    .prepare("SELECT COUNT(*) c FROM work_requests WHERE status = 'PENDING' AND id < ?")
    .get(ins.lastInsertRowid) as any;
  const formatQueueText = (place: number) =>
    `<b>⏳ Ваша заявка №${num} на добив добавлена в очередь</b>\n\n` +
    `Вы в очереди: <b>${place}</b>\n` +
    `Примерное время ожидания: <b>~${place * 5} мин</b>`;
  const initialPlace = q.c + 1;
  const queueMsg = await ctx.reply(formatQueueText(initialPlace), { parse_mode: "HTML" });
  const chatId = ctx.chat?.id;
  const messageId = queueMsg?.message_id;
  const reqId = Number(ins.lastInsertRowid);
  if (chatId && messageId && Number.isFinite(reqId)) {
    const runAutoUpdate = async () => {
      let lastPlace = initialPlace;
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 8000));
        const req = db.prepare("SELECT id, status FROM work_requests WHERE id = ?").get(reqId) as any;
        if (!req || req.status !== "PENDING") {
          await bot.telegram
            .editMessageText(chatId, messageId, undefined, `<b>✅ Заявка №${num} больше не в очереди.</b>`, { parse_mode: "HTML" })
            .catch(() => null);
          break;
        }
        const queueRow = db.prepare("SELECT COUNT(*) c FROM work_requests WHERE status = 'PENDING' AND id < ?").get(reqId) as any;
        const place = Number(queueRow?.c || 0) + 1;
        if (place !== lastPlace) {
          lastPlace = place;
          await bot.telegram
            .editMessageText(chatId, messageId, undefined, formatQueueText(place), { parse_mode: "HTML" })
            .catch(() => null);
        }
      }
    };
    void runAutoUpdate();
  }
  const workCardText =
    `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${num} на добив</b>\n` +
    `├ Пользователь: <b>@${me.tg_username || me.tg_id}</b>\n` +
    `├ Discord: <b>${me.discord_tag || "-"}</b>\n` +
    `╰ SteamID: <code>${parsed.steamId}</code>`;
  const adminRows = db
    .prepare(
      "SELECT DISTINCT u.tg_id FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN notification_prefs np ON np.user_id = u.id WHERE r.role IN ('ADMIN','DOBIVER') AND IFNULL(u.is_banned,0)=0 AND IFNULL(np.notif_work,1)=1",
    )
    .all() as any[];
  db.prepare("DELETE FROM work_request_messages WHERE work_request_id = ?").run(ins.lastInsertRowid);
  for (const row of adminRows) {
    const adminTgId = Number(row?.tg_id || 0);
    if (!adminTgId) continue;
    const sent = await bot.telegram
      .sendMessage(adminTgId, workCardText, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Взять", `work:take:${ins.lastInsertRowid}`), Markup.button.callback("❌ Отказаться", `work:reject:${ins.lastInsertRowid}`)],
        ]).reply_markup,
      })
      .catch(() => null as any);
    if (sent?.message_id) {
      db.prepare("INSERT INTO work_request_messages (work_request_id, admin_tg_id, message_id) VALUES (?, ?, ?)")
        .run(ins.lastInsertRowid, adminTgId, sent.message_id);
    }
  }
}

registerBasicHandlers(bot, {
  db,
  state,
  dialogs,
  onlineWatchRuntime,
  ensureUser,
  hasRole,
  buildDiscordAuthUrl,
  escapeHtml,
  mainKb,
  langInlineKb,
  adminKb,
  syncChatCommandsForUser,
  formatProfile,
  getUserByQuery,
  incrementProfileViews,
  normalizeProfileInput,
  findOnlineWatch,
  deleteOnlineWatchById,
  createOnlineWatch,
  createWorkRequest,
  notifyWorkers,
  nowIso,
  joinRequestText,
  getRentalGuardCode,
});

bot.on("message", async (ctx: any, next) => {
  const me = ensureUser(ctx);
  if (!me) return next();
  const st = state.get(ctx.from.id);
  if (st?.mode !== "admin_broadcast") return next();
  const isText = typeof (ctx.message as any)?.text === "string";
  if (isText) return next();
  const mid = Number((ctx.message as any)?.message_id || 0);
  if (!mid) return next();
  await runAdminBroadcastFromMessage(ctx, mid);
  await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => null);
  const promptMid = Number(st.payload?.promptMessageId || 0);
  if (promptMid > 0) {
    await ctx.telegram.deleteMessage(ctx.chat.id, promptMid).catch(() => null);
  }
  state.delete(ctx.from.id);
  await ctx.reply("ㅤ", adminKb);
  return;
});

bot.on("text", async (ctx) => {
  const me = ensureUser(ctx);
  if (!me || me.is_banned) return;

  const text = ctx.message.text;
  const allowAdminUnlinkedJoinFlow =
    hasRole(me, ["ADMIN"]) && (text === "Заявки на вступление" || text === "/admin");
  if ((!me.is_approved || !hasLinkedDiscord(me)) && !allowAdminUnlinkedJoinFlow) {
    await syncChatCommandsForUser(bot, me, (u) => hasRole(u, ["ADMIN"]));
    if (text !== "/start") await ctx.reply("❗️Сначала привяжите Discord через /start.");
    return;
  }

  const wizardModes = new Set<string>([
    "rental_add_title",
    "rental_add_login",
    "rental_add_pass",
    "rental_add_guard",
    "await_work_amount",
    "await_work_link",
    "await_dodep",
  ]);
  const stForDelete = state.get(ctx.from.id);
  if (stForDelete?.mode && wizardModes.has(stForDelete.mode)) {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
  }

  const normalizedText = String(text || "").normalize("NFKC").replace(/\uFE0F/g, "").trim();
  const plainText = normalizedText.replace(/^[^\p{L}\p{N}]+/u, "").trim();

  const LABEL_PROFILE = "\u041c\u043e\u0439 \u043f\u0440\u043e\u0444\u0438\u043b\u044c";
  const LABEL_WORK = "\u041e\u0442\u0434\u0430\u0442\u044c \u043d\u0430 \u0434\u043e\u0431\u0438\u0432";
  const LABEL_PANEL = "\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u043d\u0430 \u043f\u0430\u043d\u0435\u043b\u0435";
  const LABEL_DRAW = "\u041e\u0442\u0440\u0438\u0441\u043e\u0432\u043a\u0430";
  const LABEL_ONLINE = "\u0427\u0435\u043a\u0435\u0440 \u043e\u043d\u043b\u0430\u0439\u043d\u0430";
  const LABEL_RENT = "\u0410\u0440\u0435\u043d\u0434\u0430 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u043e\u0432";

  const isProfileBtn = plainText.startsWith(LABEL_PROFILE);
  const isWorkBtn = plainText.startsWith(LABEL_WORK);
  const isPanelBtn = plainText.startsWith(LABEL_PANEL);
  const isDrawBtn = plainText.startsWith(LABEL_DRAW);
  const isOnlineBtn = plainText.startsWith(LABEL_ONLINE);
  const isRentBtn = plainText.startsWith(LABEL_RENT);

  if (isProfileBtn || isWorkBtn || isPanelBtn || isDrawBtn || isOnlineBtn || isRentBtn) {
    state.delete(ctx.from.id);
  }

  if (isDrawBtn) {
    await renderDrawMenu(ctx);
    return;
  }
  if (isPanelBtn) {
    state.set(ctx.from.id, { mode: "panel_id_input" });
    await ctx.reply(
      `<tg-emoji emoji-id="5242657215751426928">🖌️</tg-emoji> <b>Проверка на панеле.</b> Позволяет максимально быстро узнавать, залетел ли мамонт на панель. После ввода необходимых данных ваша заявка будет отправлена на рассмотрение.\n\n` +
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (isOnlineBtn) {
    state.set(ctx.from.id, { mode: "online_watch_profile_input" });
    const onlinePrompt = await ctx.reply(
      `<tg-emoji emoji-id="5242657215751426928">🖌️</tg-emoji> <b>Чекер онлайна.</b> Отправляет уведомление, когда нужный профиль появляется в сети\n\n` +
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    if (ctx.from?.id && onlinePrompt?.message_id) uiPromptMsg.set(ctx.from.id, onlinePrompt.message_id);
    return;
  }
  const st = state.get(ctx.from.id);
  const dialogBlockedModes = new Set<string>([
    "await_work_input",
    "await_work_amount",
    "await_work_link",
    "await_dodep",
    "await_work_fail",
    "await_work_reject",
    "await_join_reject",
    "rent_reject_reason",
    "await_discord",
    "panel_id_input",
    "online_watch_profile_input",
    "online_watch_comment_input",
    "rental_add_title",
    "rental_add_login",
    "rental_add_pass",
    "rental_add_guard",
  ]);
  const isMainMenuButton = isProfileBtn || isWorkBtn || isPanelBtn || isDrawBtn || isOnlineBtn || isRentBtn;
  const hasActiveFlow = Boolean(st?.mode);
  const isBlockedByMode = st?.mode
    ? dialogBlockedModes.has(st.mode) || st.mode.startsWith("draw_input:")
    : false;
  const shouldRelayToDialog =
    !text.startsWith("/") &&
    !isMainMenuButton &&
    !hasActiveFlow &&
    !isBlockedByMode;

  if (shouldRelayToDialog) {
    for (const [num, d] of dialogs.entries()) {
      if (!d.active) continue;
      const fromId = Number(ctx.from.id);
      const userTgId = Number(d.userTgId);
      const workerTgId = Number(d.workerTgId);
      if (fromId === userTgId) await bot.telegram.sendMessage(workerTgId, `💬 [Диалог #${num}] ${text}`).catch(() => null);
      if (fromId === workerTgId) await bot.telegram.sendMessage(userTgId, `💬 [Диалог #${num}] ${text}`).catch(() => null);
    }
  }

  if (st?.mode === "rent_reject_reason") {
    const u = db.prepare("SELECT tg_id FROM users WHERE id = ?").get(st.payload.userId) as any;
    const reasonRaw = String(ctx.message.text || "").trim();
    const hasReason = reasonRaw !== "-";
    const reasonText = hasReason ? reasonRaw : "";
    await bot.telegram
      .sendMessage(
        u.tg_id,
        hasReason ? `❌ Ваша заявка на аренду отклонена.\nПричина: ${reasonText}` : "❌ Ваша заявка на аренду отклонена.",
      )
      .catch(() => null);

    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(st.payload.reviewerId) as any;
    const reviewerLabel =
      String(reviewer?.discord_tag || "").trim() || (String(reviewer?.tg_username || "").trim() ? `@${reviewer.tg_username}` : String(reviewer?.tg_id || ""));
    const reasonLabel = hasReason ? `Причина: ${reasonText}` : "Без причины";
    const safeReasonLabel = reasonLabel.length > 60 ? `${reasonLabel.slice(0, 57)}...` : reasonLabel;
    const restoredText = String(st.payload.originalText || "").trim() || "Заявка на аренду";
    const notifRows = db
      .prepare("SELECT admin_tg_id, message_id FROM rent_request_messages WHERE rental_id = ? AND user_id = ?")
      .all(st.payload.rentalId, st.payload.userId) as any[];
    for (const n of notifRows) {
      await bot.telegram
        .editMessageText(n.admin_tg_id, n.message_id, undefined, restoredText, {
          parse_mode: "HTML",
        })
        .catch(() => null);
      await bot.telegram
        .editMessageReplyMarkup(n.admin_tg_id, n.message_id, undefined, {
          inline_keyboard: [
            [{ text: `❌ Отклонено | ${reviewerLabel}`, callback_data: `rent:reviewer:${st.payload.reviewerId}` }],
            [{ text: safeReasonLabel, callback_data: "rent:reason:info" }],
          ],
        })
        .catch(() => null);
    }
    state.delete(ctx.from.id);
    return;
  }
  if (st?.mode === "await_discord") {
    db.prepare("UPDATE users SET discord_tag = ? WHERE id = ?").run(text.trim(), me.id);
    const last = db.prepare("SELECT number FROM join_requests ORDER BY number DESC LIMIT 1").get() as any;
    const num = (last?.number ?? -1) + 1;
    const ins = db
      .prepare("INSERT INTO join_requests (number, user_id, discord_tag, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
      .run(num, me.id, text.trim(), nowIso());
    state.delete(ctx.from.id);
    await ctx.reply(`✅ Аккаунт №${num} добавлен`);
    const joinCardText =
      `<tg-emoji emoji-id="5240106271465582633">🆕</tg-emoji> <b>Новая заявка №${num} на вступление</b>\n` +
      `├ Пользователь: <b>@${me.tg_username || me.tg_id}</b>\n` +
      `╰ Discord: <b>${text.trim() || "-"}</b>`;
    const admins = db
      .prepare(
        "SELECT DISTINCT u.id, u.tg_id FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN notification_prefs np ON np.user_id = u.id WHERE r.role = 'ADMIN' AND IFNULL(u.is_banned,0)=0 AND IFNULL(np.notif_join,1)=1",
      )
      .all() as any[];
    for (const a of admins) {
      const adminTgId = Number(a?.tg_id || 0);
      if (!adminTgId) continue;
      const sent = await bot.telegram
        .sendMessage(
          adminTgId,
          joinCardText,
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback("✅ Принять", `join:approve:${ins.lastInsertRowid}`), Markup.button.callback("❌ Отклонить", `join:reject:${ins.lastInsertRowid}`)],
            ]).reply_markup,
          },
        )
        .catch(() => null as any);
      if (sent?.message_id) {
        db.prepare("INSERT INTO join_request_messages (join_request_id, admin_tg_id, message_id) VALUES (?, ?, ?)")
          .run(ins.lastInsertRowid, adminTgId, sent.message_id);
      }
    }
    return;
  }

  if (st?.mode === "panel_id_input") {
    const rawInput = text.trim();
    let steamId = "";
    if (/^7\d{15,18}$/.test(rawInput)) {
      steamId = rawInput;
    } else {
      const normalized = normalizeProfileInput(rawInput);
      if (normalized) {
        steamId = normalized.steamId || (await resolveSteamId64FromProfileUrl(normalized.profileUrl)) || "";
      }
    }
    if (!steamId) {
      await ctx.reply("Укажите SteamID или ссылку на профиль Steam.");
      return;
    }
    const last = db.prepare("SELECT number FROM panel_requests ORDER BY number DESC LIMIT 1").get() as any;
    const number = (last?.number ?? -1) + 1;
    const ins = db
      .prepare("INSERT INTO panel_requests (number, user_id, steam_id, status, created_at) VALUES (?, ?, ?, 'PENDING', ?)")
      .run(number, me.id, steamId, nowIso());
    await ctx.reply(`<b>✅ Ваша заявка на проверку панели №${number} отправлена.</b>`, { parse_mode: "HTML" });
    const reqRow = { id: ins.lastInsertRowid, number, user_id: me.id, steam_id: steamId };
    const notifText = panelRequestText(reqRow, me);
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Есть", `panelreq:yes:${ins.lastInsertRowid}`),
        Markup.button.callback("❌ Нету", `panelreq:no:${ins.lastInsertRowid}`),
      ],
    ]);
    const admins = db
      .prepare(
        "SELECT DISTINCT u.tg_id FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN notification_prefs np ON np.user_id = u.id WHERE r.role IN ('ADMIN','DOBIVER') AND IFNULL(np.notif_panel,1)=1",
      )
      .all() as any[];
    for (const a of admins) {
      const sent = await bot.telegram.sendMessage(a.tg_id, notifText, { parse_mode: "HTML", reply_markup: kb.reply_markup }).catch(() => null as any);
      if (sent?.message_id) {
        db.prepare("INSERT INTO panel_request_messages (panel_request_id, admin_tg_id, message_id) VALUES (?, ?, ?)")
          .run(ins.lastInsertRowid, a.tg_id, sent.message_id);
      }
    }
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode?.startsWith("draw_input:")) {
    const promptMessageId = Number(st.payload?.promptMessageId || 0);
    if (promptMessageId > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, promptMessageId).catch(() => null);
    }
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    const mode = st.mode.replace("draw_input:", "");
    const normalized = normalizeProfileInput(text.trim());
    if (!normalized) {
      await ctx.reply(
        "Неверный формат ссылки.\nУкажите Steam ID (16 цифр, начинается с 7) или ссылку:\nhttps://steamcommunity.com/profiles/76561199077889738/\nhttps://steamcommunity.com/id/ktese/\nhttps://my.steamchina.com/profiles/76561199881567552/\nhttps://my.steamchina.com/id/ktese/",
      );
      return;
    }
    state.delete(ctx.from.id);
    let drawTicker: NodeJS.Timeout | null = null;
    let drawMsgId = 0;
    let screenshotPath = "";
    try {
      const frames = ["Рисую.", "Рисую..", "Рисую..."] as const;
      let frameIndex = 0;
      const drawStatus = () =>
        `<tg-emoji emoji-id="5240307658187119619">🎨</tg-emoji> <b>${frames[frameIndex]}</b>`;
      const drawMsg = await ctx.reply(drawStatus(), { parse_mode: "HTML" });
      drawMsgId = drawMsg.message_id;
      drawTicker = setInterval(async () => {
        frameIndex = (frameIndex + 1) % frames.length;
        await ctx.telegram
          .editMessageText(ctx.chat.id, drawMsgId, undefined, drawStatus(), { parse_mode: "HTML" })
          .catch(() => null);
      }, 800);
      if (mode === "friend_page") {
        try {
          screenshotPath = await makeSteamFriendPageFromTemplateScreenshot(normalized.profileUrl);
        } catch {
          // Fallback: if external HTML template is missing/unavailable, render a regular profile screenshot.
          screenshotPath = await makeSteamProfileScreenshot(normalized.profileUrl);
        }
      } else {
        const showAddFriendErrorModal = mode === "add_friend";
        const showAddFriendInviteBanner =
          (mode === "add_friend" || mode === "acc_blocked") && st.payload?.variant === "link";
        const showAccountBlockedModal = mode === "acc_blocked";
        screenshotPath = await makeSteamProfileScreenshot(normalized.profileUrl, {
          showAddFriendErrorModal,
          showAddFriendInviteBanner,
          showAccountBlockedModal,
        });
      }
      const fileName = `steam_profile_${Date.now()}.png`;
      if (drawTicker) {
        clearInterval(drawTicker);
        drawTicker = null;
      }
      frameIndex = frames.length - 1;
      await ctx.telegram
        .editMessageText(ctx.chat.id, drawMsgId, undefined, drawStatus(), { parse_mode: "HTML" })
        .catch(() => null);
      const sendDocPromise = ctx.replyWithDocument(Input.fromLocalFile(screenshotPath, fileName));
      const deleteDrawPromise = drawMsgId > 0 ? ctx.deleteMessage(drawMsgId).catch(() => null) : Promise.resolve(null);
      await Promise.all([sendDocPromise, deleteDrawPromise]);
    } catch (e) {
      if (drawTicker) clearInterval(drawTicker);
      if (drawMsgId > 0) {
        await ctx.deleteMessage(drawMsgId).catch(() => null);
      }
      await ctx.reply("Не удалось создать скриншот. Убедитесь, что установлен playwright и доступен HTML-шаблон.");
    } finally {
      if (screenshotPath) {
        const dir = path.dirname(screenshotPath);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
      }
    }
    return;
  }

  if (st?.mode === "online_watch_profile_input") {
    const normalized = normalizeProfileInput(text.trim());
    if (!normalized) {
      await ctx.reply(
        "Неверный формат ссылки.\nУкажите Steam ID (начинается с 7) или ссылку:\nhttps://steamcommunity.com/profiles/76561199077889738/\nhttps://steamcommunity.com/id/ktese/\nhttps://my.steamchina.com/profiles/76561199881567552/\nhttps://my.steamchina.com/id/ktese/",
      );
      return;
    }
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    const ex = db.prepare("SELECT id FROM online_watch WHERE user_id = ? AND profile_url = ?").get(me.id, normalized.profileUrl) as any;
    if (ex) {
      db.prepare("DELETE FROM online_watch WHERE id = ?").run(ex.id);
      onlineWatchRuntime.delete(ex.id);
      await sendCleanPrompt(
        ctx,
        `<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Чекер отключен для этого <a href="${escapeHtml(normalized.profileUrl)}">профиля</a>.</b>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      state.delete(ctx.from.id);
      return;
    }
    state.set(ctx.from.id, { mode: "online_watch_comment_input", payload: { profileUrl: normalized.profileUrl } });
    await sendCleanPrompt(
      ctx,
      `<tg-emoji emoji-id="5240026767325961445">🔗</tg-emoji> Профиль: <b>${escapeHtml(normalized.profileUrl)}</b>\n\n<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите комментарий для этого профиля.</b>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }

  if (st?.mode === "online_watch_comment_input") {
    const profileUrl = String(st.payload?.profileUrl || "").trim();
    if (!profileUrl) {
      state.delete(ctx.from.id);
      await ctx.reply("Не найден профиль для отслеживания. Нажмите кнопку чекера и укажите профиль заново.");
      return;
    }
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    const comment = text.trim() === "-" ? null : text.trim();
    db.prepare("INSERT INTO online_watch (user_id, profile_url, comment) VALUES (?, ?, ?)").run(me.id, profileUrl, comment);
    await sendCleanPrompt(
      ctx,
      `<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Отслеживание <a href="${escapeHtml(profileUrl)}">профиля</a> успешно включено.</b>\n\n` +
        `<i>Как только профиль появится онлайн, бот отправит уведомление.</i>`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    startOnlineWatchLoop();
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode === "await_work_reject") {
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(st.payload.id) as any;
    const upd = db.prepare("UPDATE work_requests SET status = 'REJECTED', rejection_reason = ?, closed_at = ? WHERE id = ? AND status = 'PENDING'").run(
      text === "-" ? null : text,
      nowIso(),
      req.id,
    );
    if (!upd.changes) {
      state.delete(ctx.from.id);
      await ctx.reply("Решение уже было принято.");
      return;
    }
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const rejectText =
      text === "-"
        ? `<b>❌ Ваша заявка №${req.number} отклонена.</b>\n\nПричина: <b>Без причины</b>`
        : `<b>❌ Ваша заявка №${req.number} отклонена.</b>\n\nПричина: <b>${escapeHtml(String(text))}</b>`;
    await bot.telegram.sendMessage(owner.tg_id, rejectText, { parse_mode: "HTML" }).catch(() => null);
    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id) as any;
    const reviewerLabel =
      String(reviewer?.discord_tag || "").trim() || (String(reviewer?.tg_username || "").trim() ? `@${reviewer.tg_username}` : String(reviewer?.tg_id || ""));
    const reasonBtn = text === "-" ? "Без причины" : `Причина: ${text}`.slice(0, 60);
    const restoredText = String(st.payload?.originalText || "").trim() || `Заявка №${req.number} на добив`;
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, restoredText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `❌ Отказано | ${reviewerLabel}`, callback_data: `workreq:reviewer:${actor.id}` }],
              [{ text: reasonBtn, callback_data: "workreq:reason:info" }],
            ],
          },
        })
        .catch(() => null);
    }
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode === "await_work_amount") {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(st.payload.id) as any;
    const amountUsd = Number(String(text || "").replace("$", "").replace(",", ".").trim());
    if (Number.isNaN(amountUsd) || amountUsd < 0) {
      await ctx.reply("Введите корректную сумму в USD, например: 2100");
      return;
    }
    state.set(ctx.from.id, {
      mode: "await_work_link",
      payload: {
        id: req.id,
        amountUsd,
        promptChatId: st.payload?.promptChatId ?? null,
        promptMessageId: st.payload?.promptMessageId ?? null,
      },
    });
    const promptChatId = Number(st.payload?.promptChatId || 0);
    const promptMessageId = Number(st.payload?.promptMessageId || 0);
    if (promptChatId > 0 && promptMessageId > 0) {
      await bot.telegram
        .editMessageText(
          promptChatId,
          promptMessageId,
          undefined,
          `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ссылку на бота с предметами.</b>`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:link:back:${req.id}` }]] },
          },
        )
        .catch(async () => {
          await ctx.reply(
            `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ссылку на бота с предметами.</b>`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:link:back:${req.id}` }]] },
            },
          );
        });
    } else {
      await ctx.reply(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ссылку на бота с предметами.</b>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:link:back:${req.id}` }]] },
      });
    }
    return;
  }

  if (st?.mode === "await_work_link") {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(st.payload.id) as any;
    const amountUsd = Number(st.payload?.amountUsd ?? req.amount_usd ?? 0);
    db.prepare("UPDATE work_requests SET status = 'COMPLETED', bot_link = ?, amount_usd = ?, closed_at = ? WHERE id = ?").run(text.trim(), amountUsd, nowIso(), req.id);
    db.prepare("UPDATE users SET sessions_given = sessions_given + 1, total_given_usd = total_given_usd + ? WHERE id = ?").run(amountUsd, req.owner_id);
    db.prepare("UPDATE users SET sessions_taken = sessions_taken + 1, total_taken_usd = total_taken_usd + ? WHERE id = ?").run(amountUsd, req.owner_id);
    db.prepare("UPDATE users SET worker_taken = worker_taken + 1, worker_taken_usd = worker_taken_usd + ? WHERE id = ?").run(amountUsd, me.id);
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    await bot.telegram
      .sendMessage(
        owner.tg_id,
        `<b>🎉 Ваша сессия по заявка №${req.number} была снята.</b>\n\nСумма: <b>$${amountUsd}</b>\nСсылка на бота: <b>${escapeHtml(text.trim())}</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => null);
    const promptChatId = Number(st.payload?.promptChatId || 0);
    const promptMessageId = Number(st.payload?.promptMessageId || 0);
    const dodepText = `<tg-emoji emoji-id="5240187442052510372">🔑</tg-emoji> <b>Выберите валюту додепа.</b>`;
    const dodepKb = {
      inline_keyboard: [[
        { text: "¥", callback_data: `dodep:yuan:${req.id}` },
        { text: "$", callback_data: `dodep:usd:${req.id}` },
        { text: "Закончить", callback_data: `dodep:finish:${req.id}` },
      ]],
    };
    if (promptChatId > 0 && promptMessageId > 0) {
      await bot.telegram
        .editMessageText(promptChatId, promptMessageId, undefined, dodepText, {
          parse_mode: "HTML",
          reply_markup: dodepKb,
        })
        .catch(() => null);
    } else {
      await ctx.reply(dodepText, { parse_mode: "HTML", reply_markup: dodepKb });
    }
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode === "await_work_fail") {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(st.payload.id) as any;
    db.prepare("UPDATE work_requests SET status = 'FAILED', fail_reason = ?, closed_at = ? WHERE id = ?").run(text.trim(), nowIso(), req.id);
    db.prepare("UPDATE users SET sessions_failed = sessions_failed + 1, total_failed_usd = total_failed_usd + ? WHERE id = ?").run(req.amount_usd, req.owner_id);
    db.prepare("UPDATE users SET worker_failed = worker_failed + 1, worker_failed_usd = worker_failed_usd + ? WHERE id = ?").run(req.amount_usd, me.id);
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    await bot.telegram
      .sendMessage(
        owner.tg_id,
        `<b>😢 Ваша сессия по заявке на добив №${req.number} слетела.</b>\n\nПричина: <b>${escapeHtml(text.trim())}</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => null);
    const worker = db.prepare("SELECT * FROM users WHERE id = ?").get(req.worker_id) as any;
    const applicant = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const workerLabel =
      String(worker?.discord_tag || "").trim() || (String(worker?.tg_username || "").trim() ? `@${worker.tg_username}` : String(worker?.tg_id || ""));
    const reasonLabel = `Причина: ${text.trim()}`.slice(0, 60);
    const restoredText =
      `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>@${applicant?.tg_username || applicant?.tg_id || req.owner_id}</b>\n` +
      `├ Discord: <b>${applicant?.discord_tag || "-"}</b>\n` +
      `╰ SteamID: <code>${req.steam_id}</code>`;
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, restoredText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ Взято | ${workerLabel}`, callback_data: `workreq:reviewer:${req.worker_id}` }],
              [{ text: `❌ Слет`, callback_data: "workreq:fail:info" }],
              [{ text: reasonLabel, callback_data: "workreq:reason:info" }],
            ],
          },
        })
        .catch(() => null);
    }
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode === "await_dodep") {
    const v = Number(text.replace(",", "."));
    if (Number.isNaN(v)) return void (await ctx.reply("Укажите корректное число"));
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(st.payload.id) as any;
    if (st.payload.curr === "usd") {
      db.prepare("UPDATE work_requests SET dodep_usd = dodep_usd + ? WHERE id = ?").run(v, req.id);
      db.prepare("UPDATE users SET total_dodep_usd = total_dodep_usd + ? WHERE id = ?").run(v, req.owner_id);
    } else {
      db.prepare("UPDATE work_requests SET dodep_yuan = dodep_yuan + ? WHERE id = ?").run(v, req.id);
      db.prepare("UPDATE users SET total_dodep_yuan = total_dodep_yuan + ? WHERE id = ?").run(v, req.owner_id);
    }
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    await bot.telegram
      .sendMessage(
        owner.tg_id,
        `🎊 Ваша сессия по заявке №${req.number} была додепнута на: <b>${st.payload.curr === "usd" ? "$" : "¥"}${v}</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => null);
    const promptChatId = Number(st.payload?.promptChatId || 0);
    const promptMessageId = Number(st.payload?.promptMessageId || 0);
    if (promptChatId > 0 && promptMessageId > 0) {
      await bot.telegram
        .editMessageText(
          promptChatId,
          promptMessageId,
          undefined,
          `<tg-emoji emoji-id="5240187442052510372">🔑</tg-emoji> <b>Выберите валюту додепа.</b>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "¥", callback_data: `dodep:yuan:${req.id}` },
                { text: "$", callback_data: `dodep:usd:${req.id}` },
                { text: "Закончить", callback_data: `dodep:finish:${req.id}` },
              ]],
            },
          },
        )
        .catch(() => null);
    }
    state.delete(ctx.from.id);
    return;
  }

  if (st?.mode === "await_join_reject") {
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = db.prepare("SELECT * FROM join_requests WHERE id = ?").get(st.payload.id) as any;
    if (!req) {
      state.delete(ctx.from.id);
      return;
    }
    const upd = db
      .prepare("UPDATE join_requests SET status = 'REJECTED', reason = ?, reviewed_by_user_id = ? WHERE id = ? AND status = 'PENDING'")
      .run(text === "-" ? null : text, actor.id, req.id);
    if (!upd.changes) {
      state.delete(ctx.from.id);
      await ctx.reply("Решение уже было принято.");
      return;
    }
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
    await bot.telegram
      .sendMessage(
        u.tg_id,
        text === "-"
          ? "<b>❌ Ваша заявка на вступление отклонена.</b>"
          : `<b>❌ Ваша заявка на вступление отклонена.</b>\n\nПричина: <b>${escapeHtml(String(text))}</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => null);
    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id) as any;
    const reviewerLabel =
      String(reviewer?.discord_tag || "").trim() || (String(reviewer?.tg_username || "").trim() ? `@${reviewer.tg_username}` : String(reviewer?.tg_id || ""));
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(`❌ Отклонено | ${reviewerLabel}`, `joinreq:reviewer:${actor.id}`)],
      [Markup.button.callback(text === "-" ? "Без причины" : `Причина: ${text}`.slice(0, 60), "joinreq:reason:info")],
    ]).reply_markup;
    const applicant = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
    const restoredText =
      String(st.payload?.originalText || "").trim() ||
      (`<tg-emoji emoji-id="5240106271465582633">🆕</tg-emoji> <b>Новая заявка №${req.number} на вступление</b>\n` +
        `├ Пользователь: <b>@${applicant?.tg_username || applicant?.tg_id || req.user_id}</b>\n` +
        `╰ Discord: <b>${req.discord_tag || "-"}</b>`);
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM join_request_messages WHERE join_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, restoredText, {
          parse_mode: "HTML",
          reply_markup: kb,
        })
        .catch(() => null);
    }
    await ctx.reply("❌ Заявка отклонена.").catch(() => null);
    state.delete(ctx.from.id);
    return;
  }
  if (isWorkBtn) {
    state.set(ctx.from.id, { mode: "await_work_input" });
    await ctx.reply(
      `<tg-emoji emoji-id="5242657215751426928">🖌️</tg-emoji> <b>Отдать на добив.</b> Позволяет быстро передавать сессии на добив для дальнейшего снятия.\n\n` +
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (st?.mode === "await_work_input") {
    state.delete(ctx.from.id);
    await createWorkRequest(ctx, text);
    return;
  }

  if (isProfileBtn) return void (await renderOwnProfile(ctx, me));
  if ((text === "Список пользователей" || text === "Пользователи") && hasRole(me, ["ADMIN"])) {
    await renderAdminUsersPage(ctx, 0);
    return;
  }
  if (text === "Управление пользователями" && hasRole(me, ["ADMIN"])) {
    state.set(ctx.from.id, { mode: "admin_find_user", payload: { returnPage: 0 } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите Discord/Username/ID чтобы найти пользователя.</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку", "admin:userlist:page:0")]]).reply_markup,
      },
    );
    return;
  }
  if (st?.mode === "admin_find_user") {
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    const returnPage = Math.max(0, Number(st.payload?.returnPage || 0));
    const promptMid = uiPromptMsg.get(ctx.from.id);
    const replaceSearchPrompt = async (textOut: string, extra?: any) => {
      if (promptMid) {
        const edited = await ctx.telegram
          .editMessageText(ctx.chat.id, promptMid, undefined, textOut, extra)
          .then(() => true)
          .catch(() => false);
        if (edited) return;
      }
      const sent = await ctx.reply(textOut, extra).catch(() => null as any);
      if (sent?.message_id) uiPromptMsg.set(ctx.from.id, sent.message_id);
    };
    const t = db
      .prepare("SELECT * FROM users WHERE id = ? OR LOWER(IFNULL(discord_tag,'')) = LOWER(?) OR LOWER(IFNULL(tg_username,'')) = LOWER(?) LIMIT 1")
      .get(Number(text) || -1, text, text.replace("@", "")) as any;
    if (!t) {
      await replaceSearchPrompt(
        "Не найден",
        {
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку", `admin:userlist:page:${returnPage}`)]]).reply_markup,
        },
      );
      return;
    }
    await replaceSearchPrompt(
      `Найден #${t.id} @${t.tg_username || "-"}`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("Забанить/Разбанить", `admin:ban:${t.id}`), Markup.button.callback("Написать сообщение", `admin:msg:${t.id}:${returnPage}`)],
          [Markup.button.callback("Выдать права", `admin:roles:${t.id}:${returnPage}`)],
          [Markup.button.callback("⬅️ К списку", `admin:userlist:page:${returnPage}`)],
        ]).reply_markup,
      },
    );
    state.delete(ctx.from.id);
    return;
  }
  if (st?.mode === "admin_send_msg") {
    const userId = Number(st.payload?.userId || 0);
    const returnPage = Math.max(0, Number(st.payload?.returnPage || 0));
    const promptMessageId = Number(st.payload?.promptMessageId || 0);
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    const target = db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(userId) as any;
    if (!target) {
      state.delete(ctx.from.id);
      await ctx.reply("Пользователь не найден");
      return;
    }
    const msgText = String(text || "").trim();
    if (!msgText) {
      await ctx.reply("Сообщение пустое");
      return;
    }
    const sent = await bot.telegram.sendMessage(Number(target.tg_id), msgText).then(() => true).catch(() => false);
    const profileText = `Найден #${target.id} @${target.tg_username || "-"}`;
    const profileKb = Markup.inlineKeyboard([
      [
        Markup.button.callback("Забанить/Разбанить", `admin:ban:${target.id}`),
        Markup.button.callback("Написать сообщение", `admin:msg:${target.id}:${returnPage}`),
      ],
      [Markup.button.callback("Выдать права", `admin:roles:${target.id}:${returnPage}`)],
      [Markup.button.callback("⬅️ К списку", `admin:userlist:page:${returnPage}`)],
    ]).reply_markup;
    if (promptMessageId > 0) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, promptMessageId, undefined, profileText, { reply_markup: profileKb })
        .catch(() => null);
    } else {
      await ctx.reply(profileText, { reply_markup: profileKb }).catch(() => null);
    }
    if (!sent) {
      await ctx.reply("Не удалось отправить сообщение пользователю. Возможно, он не запускал бота или заблокировал его.");
    }
    state.delete(ctx.from.id);
    return;
  }
  if (text === "Рассылка" && hasRole(me, ["ADMIN"])) {
    const prompt = await ctx.reply(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Отправьте сообщение для рассылки.</b>`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("❌ Отменить", "admin:broadcast:back")]]).reply_markup,
    });
    state.set(ctx.from.id, { mode: "admin_broadcast", payload: { promptMessageId: prompt?.message_id || null } });
    return;
  }
  if (st?.mode === "admin_broadcast") {
    const mid = Number((ctx.message as any)?.message_id || 0);
    await runAdminBroadcastFromMessage(ctx, mid);
    if (mid > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => null);
    }
    const promptMid = Number(st.payload?.promptMessageId || 0);
    if (promptMid > 0) {
      await ctx.telegram.deleteMessage(ctx.chat.id, promptMid).catch(() => null);
    }
    state.delete(ctx.from.id);
    await ctx.reply("ㅤ", adminKb);
    return;
  }
  if (st?.mode === "admin_logs_search" && hasRole(me, ["ADMIN"])) {
    const q = String(text || "").trim();
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    adminLogsViewState.set(ctx.from.id, { query: q });
    state.delete(ctx.from.id);
    await renderAdminLogs(ctx, 0, q);
    return;
  }
  if (st?.mode === "admin_req_search" && hasRole(me, ["ADMIN"])) {
    const kind = (st.payload?.kind === "panel" ? "panel" : st.payload?.kind === "rent" ? "rent" : "work") as "work" | "panel" | "rent";
    const q = String(text || "").trim();
    if (ctx.message?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    }
    adminReqListState.set(ctx.from.id, { kind, query: q });
    state.delete(ctx.from.id);
    await renderAdminRequestList(ctx, kind, 0, q);
    return;
  }
  if (text === "Уведомления" && hasRole(me, ["ADMIN", "DOBIVER"])) {
    ensureNotificationPrefs(me.id);
    const p = db.prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(me.id) as any;
    await ctx.reply(renderNotifyText(p), { parse_mode: "HTML", reply_markup: renderNotifyKb(p).reply_markup });
    return;
  }
  if (text === "Логи" && hasRole(me, ["ADMIN"])) {
    adminLogsViewState.set(ctx.from.id, { query: "" });
    await renderAdminLogs(ctx, 0, "");
    return;
  }
  if (text === "Статистика" && hasRole(me, ["ADMIN"])) {
    await renderAdminStats(ctx, "all");
    return;
  }
  if (text === "Заявки на вступление" && hasRole(me, ["ADMIN"])) {
    await renderJoinRequestsPage(ctx, 0);
    return;
  }
  if (text === "Заявки на работу" && hasRole(me, ["ADMIN"])) {
    adminReqListState.set(ctx.from.id, { kind: "work", query: "" });
    await renderAdminRequestList(ctx, "work", 0, "");
    return;
  }
  if (text === "Заявки на добив" && hasRole(me, ["ADMIN"])) {
    adminReqListState.set(ctx.from.id, { kind: "work", query: "" });
    await renderAdminRequestList(ctx, "work", 0, "");
    return;
  }
  if (text === "Заявки на проверку" && hasRole(me, ["ADMIN"])) {
    adminReqListState.set(ctx.from.id, { kind: "panel", query: "" });
    await renderAdminRequestList(ctx, "panel", 0, "");
    return;
  }
  if (text === "Заявки на аренду" && hasRole(me, ["ADMIN", "LANDLORD"])) {
    adminReqListState.set(ctx.from.id, { kind: "rent", query: "" });
    await renderAdminRequestList(ctx, "rent", 0, "");
    return;
  }
  if (isRentBtn) {
    await renderRentMenu(ctx, me);
    return;
  }
  if (st?.mode === "rental_add_title") {
    state.set(ctx.from.id, { mode: "rental_add_login", payload: { title: text.trim() } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите логин Steam аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:add:back:title")]]).reply_markup },
    );
    return;
  }
  if (st?.mode === "rental_add_login") {
    const login = text.trim();
    if (!isValidSteamLogin(login)) {
      await ctx.reply("Невалидный логин Steam. Допустимо: 3-64 символа, латиница/цифры/._-");
      return;
    }
    state.set(ctx.from.id, { mode: "rental_add_pass", payload: { ...st.payload, login } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите пароль от Steam аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:add:back:login")]]).reply_markup },
    );
    return;
  }
  if (st?.mode === "rental_add_pass") {
    const pass = text.trim();
    if (!isValidRentalPassword(pass)) {
      await ctx.reply("Невалидный пароль. Минимум 6 символов.");
      return;
    }
    state.set(ctx.from.id, { mode: "rental_add_guard", payload: { ...st.payload, pass } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Скиньте файлом MaFile от аккаунта чьи данные были введены раньше.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:add:back:pass")]]).reply_markup },
    );
    return;
  }
  if (st?.mode === "rental_add_guard") {
    await ctx.reply("На этом шаге нужен maFile. Отправьте файл .maFile/.json документом.");
    return;
  }
  if (st?.mode === "rental_add_desc") return;
  if (st?.mode === "rental_edit_title") {
    db.prepare("UPDATE rentals SET title = ? WHERE number = ?").run(text.trim(), st.payload.num);
    state.delete(ctx.from.id);
    await ctx.reply("✅ Описание обновлено");
    await renderRentMenu(ctx, me);
    return;
  }
  if (st?.mode === "rental_edit_desc") {
    db.prepare("UPDATE rentals SET description = ? WHERE number = ?").run(text.trim(), st.payload.num);
    state.delete(ctx.from.id);
    await ctx.reply("✅ Название обновлено");
    await renderRentMenu(ctx, me);
    return;
  }

  if (/^rent:approve:(\d+):(\d+)$/.test(text)) return;

  if (text.startsWith("/")) {
    await ctx.reply(
      `<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Неизвестная команда.</b> Используйте <b>/start</b>, чтобы перезапустить бота.`,
      { parse_mode: "HTML" },
    );
    return;
  }

logEvent(me, "text", text.slice(0, 160));
});

bot.on("document", async (ctx: any, next) => {
  const me = ensureUser(ctx);
  if (!me) return;
  if (!me.is_approved) return;

  const st = state.get(ctx.from.id);
  if (st?.mode !== "rental_add_guard") return next();

  const doc = ctx.message?.document;
  if (!doc?.file_id) {
    await ctx.reply("Не удалось прочитать файл. Отправьте maFile ещё раз.");
    return;
  }

  const fileName = String(doc.file_name || "").toLowerCase();
  if (!fileName.endsWith(".mafile") && !fileName.endsWith(".json")) {
    await ctx.reply("Нужен файл maFile (.maFile или .json) с полем shared_secret.");
    return;
  }

  let rawText = "";
  try {
    const fileUrl = await bot.telegram.getFileLink(doc.file_id);
    rawText = await fetch(String(fileUrl)).then((r) => r.text());
  } catch {
    await ctx.reply("Не получилось скачать файл из Telegram. Попробуйте отправить его ещё раз.");
    return;
  }

  const maFileData = parseMaFileData(rawText);
  if (!maFileData) {
    await ctx.reply("В maFile не найден валидный shared_secret.");
    return;
  }

  const maLogin = String(maFileData.accountName || "").trim().toLowerCase();
  const inputLogin = String(st.payload?.login || "").trim().toLowerCase();
  if (maLogin && inputLogin && maLogin !== inputLogin) {
    await ctx.reply(
      `Логин не совпадает с maFile.\nВвели: ${st.payload.login}\nВ maFile: ${maFileData.accountName}\nОтправьте правильный maFile.`,
    );
    return;
  }

  try {
    const payload = {
      ...st.payload,
      guard: `shared:${maFileData.sharedSecret}`,
      steamIdFromMaFile: maFileData.steamId,
      maAccountName: maFileData.accountName,
    };
    const last = db.prepare("SELECT number FROM rentals ORDER BY number DESC LIMIT 1").get() as any;
    const num = (last?.number ?? -1) + 1;
    db.prepare(
      `INSERT INTO rentals
        (number, owner_user_id, title, login, pass, guard_code, steam_id, steam_refresh_token, steam_login_secure, steam_login_secure_exp, steam_session_id, steam_browser_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      num,
      me.id,
      payload.title,
      payload.login,
      payload.pass,
      payload.guard,
      payload.steamIdFromMaFile || null,
      null,
      null,
      null,
      null,
      null,
      payload.title,
    );
    const promptMid = uiPromptMsg.get(ctx.from.id);
    if (promptMid) {
      await ctx.telegram.deleteMessage(ctx.chat.id, promptMid).catch(() => null);
      uiPromptMsg.delete(ctx.from.id);
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => null);
    state.delete(ctx.from.id);
    await renderRentMenu(ctx, me);
  } catch (e: any) {
    await ctx.reply(`Не удалось добавить аккаунт: ${String(e?.message || e)}`);
  }
});

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery!)) return next();
  const data = ctx.callbackQuery.data;
  const me = ensureUser(ctx);
  if (!me) return;
  const allowAdminJoinReviewWhileUnapprovedOrUnlinked =
    hasRole(me, ["ADMIN"]) && (data.startsWith("join:") || data.startsWith("joinreq:"));
  if ((!me.is_approved || !hasLinkedDiscord(me)) && data !== "register:discord:unavailable" && !allowAdminJoinReviewWhileUnapprovedOrUnlinked) {
    await ctx.answerCbQuery("Сначала привяжите Discord через /start", { show_alert: true }).catch(() => null);
    return;
  }

  if (data === "admin:userlist:noop") {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "join:list:noop" && hasRole(me, ["ADMIN"])) {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data.startsWith("join:list:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    await renderJoinRequestsPage(ctx, Number.isFinite(page) ? page : 0);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data.startsWith("join:list:open:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const joinRequestId = Number(parts[3] || 0);
    const page = Number(parts[4] || 0);
    const req = db.prepare("SELECT jr.*, u.tg_username, u.tg_id FROM join_requests jr LEFT JOIN users u ON u.id = jr.user_id WHERE jr.id = ?").get(joinRequestId) as any;
    if (!req) {
      await ctx.answerCbQuery("Заявка не найдена", { show_alert: true }).catch(() => null);
      return;
    }
    const userLabel = req.tg_username ? `@${req.tg_username}` : String(req.tg_id || "-");
    const text =
      `<tg-emoji emoji-id="5239948611806081116">❗️</tg-emoji> <b>Новая заявка №${req.number} на вступление</b>\n` +
      `├ Пользователь: <b>${escapeHtml(userLabel)}</b>\n` +
      `╰ Discord: <b>${escapeHtml(req.discord_tag || "-")}</b>`;
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Принять", `join:approve:${joinRequestId}`), Markup.button.callback("❌ Отклонить", `join:reject:${joinRequestId}`)],
        [Markup.button.callback("⬅️ Назад", `join:list:page:${Math.max(0, page)}`)],
      ]).reply_markup,
    }).catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("notify:toggle:") && hasRole(me, ["ADMIN", "DOBIVER"])) {
    ensureNotificationPrefs(me.id);
    const key = String(data.split(":").pop() || "");
    const col =
      key === "work" ? "notif_work" :
      key === "join" ? "notif_join" :
      key === "panel" ? "notif_panel" :
      key === "rent" ? "notif_rent" : "";
    if (!col) {
      await ctx.answerCbQuery("Неизвестный тип", { show_alert: true }).catch(() => null);
      return;
    }
    const cur = db.prepare(`SELECT ${col} AS v FROM notification_prefs WHERE user_id = ?`).get(me.id) as any;
    const nextVal = Number(cur?.v || 0) ? 0 : 1;
    db.prepare(`UPDATE notification_prefs SET ${col} = ? WHERE user_id = ?`).run(nextVal, me.id);
    const p = db.prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(me.id) as any;
    await ctx.editMessageText(renderNotifyText(p), { parse_mode: "HTML", reply_markup: renderNotifyKb(p).reply_markup }).catch(() => null);
    await ctx.answerCbQuery(nextVal ? "Включено" : "Выключено").catch(() => null);
    return;
  }

  if (data === "admin:broadcast:back" && hasRole(me, ["ADMIN"])) {
    state.delete(ctx.from.id);
    await ctx.deleteMessage().catch(() => null);
    await ctx.reply("ㅤ", adminKb);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "logs:noop" && hasRole(me, ["ADMIN"])) {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if ((data === "work:list:noop" || data === "panel:list:noop") && hasRole(me, ["ADMIN"])) {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:list:noop" && hasRole(me, ["ADMIN", "LANDLORD"])) {
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if ((data === "work:list:search" || data === "panel:list:search") && hasRole(me, ["ADMIN"])) {
    const kind = data.startsWith("panel:") ? "panel" : "work";
    state.set(ctx.from.id, { mode: "admin_req_search", payload: { kind } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ключевое слово для поиска заявки.</b>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:list:search" && hasRole(me, ["ADMIN", "LANDLORD"])) {
    state.set(ctx.from.id, { mode: "admin_req_search", payload: { kind: "rent" } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ключевое слово для поиска заявки.</b>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if ((data === "work:list:clear" || data === "panel:list:clear") && hasRole(me, ["ADMIN"])) {
    const kind = data.startsWith("panel:") ? "panel" : "work";
    adminReqListState.set(ctx.from.id, { kind: kind as any, query: "" });
    await renderAdminRequestList(ctx, kind as any, 0, "");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:list:clear" && hasRole(me, ["ADMIN", "LANDLORD"])) {
    adminReqListState.set(ctx.from.id, { kind: "rent", query: "" });
    await renderAdminRequestList(ctx, "rent", 0, "");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("work:list:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    const q = adminReqListState.get(ctx.from.id)?.query || "";
    await renderAdminRequestList(ctx, "work", Number.isFinite(page) ? page : 0, q);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("panel:list:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    const q = adminReqListState.get(ctx.from.id)?.query || "";
    await renderAdminRequestList(ctx, "panel", Number.isFinite(page) ? page : 0, q);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data.startsWith("rent:list:page:") && hasRole(me, ["ADMIN", "LANDLORD"])) {
    const page = Number(data.split(":").pop() || 0);
    const q = adminReqListState.get(ctx.from.id)?.query || "";
    await renderAdminRequestList(ctx, "rent", Number.isFinite(page) ? page : 0, q);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("work:list:open:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const id = Number(parts[3] || 0);
    const page = Number(parts[4] || 0);
    const req = db.prepare("SELECT wr.*, u.tg_username, u.discord_tag FROM work_requests wr LEFT JOIN users u ON u.id = wr.owner_id WHERE wr.id = ?").get(id) as any;
    if (!req) {
      await ctx.answerCbQuery("Заявка не найдена", { show_alert: true }).catch(() => null);
      return;
    }
    const userLabel = req.tg_username ? `@${req.tg_username}` : String(req.owner_tg_id || "-");
    const text =
      `<tg-emoji emoji-id="5239948611806081116">❗️</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>${escapeHtml(userLabel)}</b>\n` +
      `├ Discord: <b>${escapeHtml(req.discord_tag || "-")}</b>\n` +
      `╰ SteamID: <code>${escapeHtml(req.steam_id || "-")}</code>`;
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Взять", `work:take:${id}`), Markup.button.callback("❌ Отказаться", `work:reject:${id}`)],
          [Markup.button.callback("⬅️ Назад", `work:list:page:${Math.max(0, page)}`)],
        ]).reply_markup,
      })
      .catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("panel:list:open:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const id = Number(parts[3] || 0);
    const page = Number(parts[4] || 0);
    const req = db.prepare("SELECT pr.*, u.tg_username, u.discord_tag FROM panel_requests pr LEFT JOIN users u ON u.id = pr.user_id WHERE pr.id = ?").get(id) as any;
    if (!req) {
      await ctx.answerCbQuery("Заявка не найдена", { show_alert: true }).catch(() => null);
      return;
    }
    const userLabel = req.tg_username ? `@${req.tg_username}` : String(req.user_tg_id || "-");
    const text =
      `<tg-emoji emoji-id="5239948611806081116">❗️</tg-emoji> <b>Новая заявка №${req.number} на проверку</b>\n` +
      `├ Пользователь: <b>${escapeHtml(userLabel)}</b>\n` +
      `├ Discord: <b>${escapeHtml(req.discord_tag || "-")}</b>\n` +
      `╰ SteamID: <code>${escapeHtml(req.steam_id || "-")}</code>`;
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Есть", `panelreq:yes:${id}`), Markup.button.callback("❌ Нету", `panelreq:no:${id}`)],
          [Markup.button.callback("⬅️ Назад", `panel:list:page:${Math.max(0, page)}`)],
        ]).reply_markup,
      })
      .catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data.startsWith("rent:list:open:") && hasRole(me, ["ADMIN", "LANDLORD"])) {
    const parts = data.split(":");
    const rentalId = Number(parts[3] || 0);
    const page = Number(parts[4] || 0);
    const userId = Number(parts[5] || 0);
    const rent = db.prepare("SELECT * FROM rentals WHERE id = ?").get(rentalId) as any;
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    if (!rent || !u) {
      await ctx.answerCbQuery("Заявка не найдена", { show_alert: true }).catch(() => null);
      return;
    }
    const text =
      `<tg-emoji emoji-id="5239948611806081116">❗️</tg-emoji> <b>Новая заявка №${rent.number} на аренду</b>\n` +
      `├ Пользователь: <b>@${escapeHtml(u.tg_username || "-")}</b>\n` +
      `├ Discord: <b>${escapeHtml(u.discord_tag || "-")}</b>\n` +
      `╰ Аккаунт: <b>${escapeHtml(cleanUiText(rent.title, `Аккаунт #${rent.number}`))}</b>`;
    await ctx
      .editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Принять", `rent:approve:${rentalId}:${userId}`), Markup.button.callback("❌ Отклонить", `rent:reject:${rentalId}:${userId}`)],
          [Markup.button.callback("💬 Начать диалог", `rent:dialog:start:${rentalId}:${userId}`)],
          [Markup.button.callback("⬅️ Назад", `rent:list:page:${Math.max(0, page)}`)],
        ]).reply_markup,
      })
      .catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "logs:search" && hasRole(me, ["ADMIN"])) {
    state.set(ctx.from.id, { mode: "admin_logs_search" });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите ключевое слово для поиска логов.</b>`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "logs:clear" && hasRole(me, ["ADMIN"])) {
    adminLogsViewState.set(ctx.from.id, { query: "" });
    await renderAdminLogs(ctx, 0, "");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("logs:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    const q = adminLogsViewState.get(ctx.from.id)?.query || "";
    await renderAdminLogs(ctx, Number.isFinite(page) ? page : 0, q);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("stats:range:") && hasRole(me, ["ADMIN"])) {
    const range = String(data.split(":").pop() || "all") as StatsRangeKey;
    const allowed = new Set<StatsRangeKey>(["today", "week", "month", "year", "all"]);
    await renderAdminStats(ctx, allowed.has(range) ? range : "all");
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:userlist:search:") && hasRole(me, ["ADMIN"])) {
    const page = Math.max(0, Number(data.split(":").pop() || 0));
    state.set(ctx.from.id, { mode: "admin_find_user", payload: { returnPage: page } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите Discord/Username/ID чтобы найти пользователя.</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку", `admin:userlist:page:${page}`)]]).reply_markup,
      },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:userlist:page:") && hasRole(me, ["ADMIN"])) {
    const page = Number(data.split(":").pop() || 0);
    await renderAdminUsersPage(ctx, Number.isFinite(page) ? page : 0);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data.startsWith("admin:usercard:") && hasRole(me, ["ADMIN"])) {
    const parts = data.split(":");
    const userId = Number(parts[2] || 0);
    const page = Number(parts[3] || 0);
    const t = db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").get(userId) as any;
    if (!t) {
      await ctx.answerCbQuery("Пользователь не найден", { show_alert: true }).catch(() => null);
      return;
    }
    const profileText = `Найден #${t.id} @${t.tg_username || "-"}`;
    const profileKb = Markup.inlineKeyboard([
      [
        Markup.button.callback("Забанить/Разбанить", `admin:ban:${t.id}`),
        Markup.button.callback("Написать сообщение", `admin:msg:${t.id}:${Math.max(0, page)}`),
      ],
      [Markup.button.callback("Выдать права", `admin:roles:${t.id}:${Math.max(0, page)}`)],
      [Markup.button.callback("⬅️ К списку", `admin:userlist:page:${Math.max(0, page)}`)],
    ]);
    await ctx.editMessageText(profileText, { reply_markup: profileKb.reply_markup }).catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }

  if (data === "draw:menu") {
    await renderDrawMenu(ctx);
    return;
  }

  if (data === "draw:add_friend") {
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240187442052510372">📝</tg-emoji> <b>Что предоставил вам мамонт?</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Ссылка", "draw:add_friend:link"), Markup.button.callback("🆔 Код друга", "draw:add_friend:id")],
          [Markup.button.callback("◀️ Назад", "draw:menu")],
        ]).reply_markup,
      },
    );
    return;
  }
  if (data === "draw:acc_blocked") {
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240187442052510372">📝</tg-emoji> <b>Что предоставил вам мамонт?</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("🔗 Ссылка", "draw:acc_blocked:link"), Markup.button.callback("🆔 Код друга", "draw:acc_blocked:id")],
          [Markup.button.callback("◀️ Назад", "draw:menu")],
        ]).reply_markup,
      },
    );
    return;
  }
  if (data.startsWith("draw:add_friend:")) {
    const variant = data.endsWith(":id") ? "id" : "link";
    const promptMessageId = (ctx.callbackQuery as any)?.message?.message_id || null;
    state.set(ctx.from!.id, { mode: "draw_input:add_friend", payload: { variant, promptMessageId } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "draw:add_friend")]]).reply_markup,
      },
    );
    return;
  }
  if (data.startsWith("draw:acc_blocked:")) {
    const variant = data.endsWith(":id") ? "id" : "link";
    const promptMessageId = (ctx.callbackQuery as any)?.message?.message_id || null;
    state.set(ctx.from!.id, { mode: "draw_input:acc_blocked", payload: { variant, promptMessageId } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "draw:acc_blocked")]]).reply_markup,
      },
    );
    return;
  }
  if (["draw:friend_page", "draw:qr_page", "draw:ban_cs2", "draw:code_cs2", "draw:ban_dota2"].includes(data)) {
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5239948611806081116">⚠️</tg-emoji> <b>Технические работы.</b>\nЭтот раздел временно недоступен.`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "draw:menu")]]).reply_markup,
      },
    );
    return;
  }
  if (data.startsWith("draw:")) {
    const drawTypeMap: Record<string, string> = {
      "draw:friend_page": "friend_page",
      "draw:qr_page": "qr_page",
      "draw:acc_blocked": "acc_blocked",
      "draw:ban_cs2": "ban_cs2",
      "draw:code_cs2": "code_cs2",
      "draw:ban_dota2": "ban_dota2",
    };
    const mapped = drawTypeMap[data];
    if (mapped) {
      const promptMessageId = (ctx.callbackQuery as any)?.message?.message_id || null;
      state.set(ctx.from!.id, { mode: `draw_input:${mapped}`, payload: { promptMessageId } });
      await replaceOrReply(
        ctx,
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Пришлите ссылку на профиль/SteamID</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "draw:menu")]]).reply_markup,
        },
      );
      return;
    }
  }

  if (data === "profile:currency:toggle") {
    const me = ensureUser(ctx);
    if (!me) return;
    const current = String(me.profile_currency || "USD").toUpperCase();
    const next = nextProfileCurrency(current);
    updateProfileCurrency(db as any, me.id, next);
    const refreshed = getUserByTgId(me.tg_id) as any;
    const after = String(refreshed?.profile_currency || "USD").toUpperCase();
    const nextAfter = nextProfileCurrency(after);
    const profileText = await formatProfile(refreshed || me);
    const replyMarkup = Markup.inlineKeyboard([[Markup.button.callback(`Отображение в ${nextAfter}`, "profile:currency:toggle")]]).reply_markup;
    const editedCaption = await ctx
      .editMessageCaption(profileText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      })
      .then(() => true)
      .catch(() => false);
    if (!editedCaption) {
      await ctx
        .editMessageText(profileText, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery();
    return;
  }

  if (data === "flow:cancel") {
    state.delete(ctx.from!.id);
    await ctx.answerCbQuery();
    return;
  }
  if (data === "rent:menu") {
    await renderRentMenu(ctx, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:add:start") {
    state.set(ctx.from!.id, { mode: "rental_add_title" });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите отображаемое имя аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:menu")]]).reply_markup },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:add:back:title") {
    state.set(ctx.from!.id, { mode: "rental_add_title", payload: state.get(ctx.from!.id)?.payload || {} });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите отображаемое имя аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:menu")]]).reply_markup },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:add:back:login") {
    const st = state.get(ctx.from!.id);
    state.set(ctx.from!.id, { mode: "rental_add_login", payload: { ...(st?.payload || {}) } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите логин Steam аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:add:back:title")]]).reply_markup },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:add:back:pass") {
    const st = state.get(ctx.from!.id);
    state.set(ctx.from!.id, { mode: "rental_add_pass", payload: { ...(st?.payload || {}) } });
    await replaceOrReply(
      ctx,
      `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите пароль от Steam аккаунта.</b>`,
      { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", "rent:add:back:login")]]).reply_markup },
    );
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (/^rent:view:\d+$/.test(data)) {
    const num = Number(data.split(":")[2]);
    await renderRentCard(ctx, num, me);
    await ctx.answerCbQuery().catch(() => null);
    return;
  }
  if (data === "rent:edit:pick") {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const rows = db.prepare("SELECT number, title FROM rentals ORDER BY id DESC LIMIT 50").all() as any[];
    const kb: any[] = rows.map((r) => [Markup.button.callback(`${cleanUiText(r.title, `Аккаунт #${r.number}`)} #${r.number}`, `rent:edit:item:${r.number}`)]);
    kb.push([Markup.button.callback("◀️ Назад", "rent:menu")]);
    await replaceOrReply(ctx, "Выберите аккаунт для редактирования:", Markup.inlineKeyboard(kb));
    return;
  }
  if (/^rent:edit:item:\d+$/.test(data)) {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const num = Number(data.split(":")[3]);
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("Название", `rent:edit:title:${num}`)],
      [Markup.button.callback("Описание", `rent:edit:desc:${num}`)],
      [Markup.button.callback("◀️ Назад", "rent:edit:pick")],
    ]);
    await replaceOrReply(ctx, `Что изменить у аккаунта #${num}?`, kb);
    return;
  }
  if (/^rent:edit:title:\d+$/.test(data)) {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const num = Number(data.split(":")[3]);
    state.set(ctx.from!.id, { mode: "rental_edit_title", payload: { num } });
    await replaceOrReply(ctx, `Введите новое название для #${num}:`, Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `rent:edit:item:${num}`)]]));
    return;
  }
  if (/^rent:edit:desc:\d+$/.test(data)) {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const num = Number(data.split(":")[3]);
    state.set(ctx.from!.id, { mode: "rental_edit_desc", payload: { num } });
    await replaceOrReply(ctx, `Введите новое описание для #${num}:`, Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `rent:edit:item:${num}`)]]));
    return;
  }
  if (data === "rent:del:pick") {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const rows = db.prepare("SELECT number, title FROM rentals ORDER BY id DESC LIMIT 50").all() as any[];
    const kb: any[] = rows.map((r) => [Markup.button.callback(`🗑️ ${cleanUiText(r.title, `Аккаунт #${r.number}`)} #${r.number}`, `rent:del:item:${r.number}`)]);
    kb.push([Markup.button.callback("◀️ Назад", "rent:menu")]);
    await replaceOrReply(ctx, "Выберите аккаунт для удаления:", Markup.inlineKeyboard(kb));
    return;
  }
  if (/^rent:del:item:\d+$/.test(data)) {
    if (!hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const num = Number(data.split(":")[3]);
    db.prepare("DELETE FROM rentals WHERE number = ?").run(num);
    db.prepare("DELETE FROM guard_attempts WHERE rental_id NOT IN (SELECT id FROM rentals)").run();
    await ctx.answerCbQuery("Удалено").catch(() => null);
    await renderRentMenu(ctx, me);
    return;
  }

  if (/^rent:req:\d+$/.test(data)) {
    const me = ensureUser(ctx);
    if (!me) return;
    const num = Number(data.split(":")[2]);
    const rent = db.prepare("SELECT * FROM rentals WHERE number = ?").get(num) as any;
    if (!rent) return void (await ctx.answerCbQuery("Не найдено"));
    if (rent.is_busy) return void (await ctx.answerCbQuery("Уже занят"));
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(rent.owner_user_id) as any;
    const requestText =
      `<tg-emoji emoji-id="5240013139394731866">🔔</tg-emoji> <b>Новая заявка №${num} на аренду аккаунта</b>\n` +
      `├ Пользователь: <b>@${me.tg_username || me.tg_id}</b>\n` +
      `╰ Discord: <b>${me.discord_tag || "-"}</b>`;
    const requestMarkup = {
      parse_mode: "HTML" as const,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Принять", `rent:approve:${rent.id}:${me.id}`), Markup.button.callback("❌ Отклонить", `rent:reject:${rent.id}:${me.id}`)],
        [Markup.button.callback("💬 Начать диалог", `rent:dialog:start:${rent.id}:${me.id}`)],
      ]).reply_markup,
    };
    const targetAdmins = Array.from(new Set<number>([Number(owner?.tg_id || 0), ...ADMIN_IDS.map((x) => Number(x))])).filter((x) => x > 0);
    const filteredTargetAdmins: number[] = [];
    for (const tgId of targetAdmins) {
      const u = db.prepare("SELECT id FROM users WHERE tg_id = ?").get(tgId) as any;
      if (!u) {
        filteredTargetAdmins.push(tgId);
        continue;
      }
      ensureNotificationPrefs(Number(u.id));
      const pref = db.prepare("SELECT notif_rent FROM notification_prefs WHERE user_id = ?").get(u.id) as any;
      if (Number(pref?.notif_rent ?? 1) === 1) filteredTargetAdmins.push(tgId);
    }
    db.prepare("DELETE FROM rent_request_messages WHERE rental_id = ? AND user_id = ?").run(rent.id, me.id);
    for (const adminTgId of filteredTargetAdmins) {
      const sent = await bot.telegram.sendMessage(adminTgId, requestText, requestMarkup).catch(() => null as any);
      if (sent?.message_id) {
        db.prepare("INSERT INTO rent_request_messages (rental_id, user_id, admin_tg_id, message_id) VALUES (?, ?, ?, ?)")
          .run(rent.id, me.id, adminTgId, sent.message_id);
      }
    }
    await ctx.answerCbQuery("Запрос отправлен");
    return;
  }

  if (/^panelreq:(yes|no):\d+$/.test(data)) {
    const [, verdict, idRaw] = data.match(/^panelreq:(yes|no):(\d+)$/)!;
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = getPendingPanelRequest(db as any, Number(idRaw));
    if (req && req.status === "PENDING") {
      const upd = resolvePanelRequest(db as any, req.id, verdict === "yes" ? "YES" : "NO", actor.id);
      if (!upd.changes) {
        await ctx.answerCbQuery("Решение уже принято");
        return;
      }
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
      if (u) {
        await bot.telegram
          .sendMessage(
            u.tg_id,
            verdict === "yes"
              ? `<b>✅ Заявка №${req.number}: ваш Steam ID найден на панели.</b>`
              : `<b>❌ Заявка №${req.number}: ваш Steam ID не найден на панели.</b>`,
            { parse_mode: "HTML" },
          )
          .catch(() => null);
      }
      const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id) as any;
      const resolvedText = panelRequestText(req, u);
      const verdictLabel = verdict === "yes" ? "✅ Есть" : "❌ Нету";
      const resolvedKb = Markup.inlineKeyboard([
        [Markup.button.callback(`${verdictLabel} | ${reviewer?.discord_tag || "модератор"}`, `panelreq:reviewer:${actor.id}`)],
      ]).reply_markup;
      const notifs = db.prepare("SELECT admin_tg_id, message_id FROM panel_request_messages WHERE panel_request_id = ?").all(req.id) as any[];
      for (const n of notifs) {
        await bot.telegram
          .editMessageText(n.admin_tg_id, n.message_id, undefined, resolvedText, {
            parse_mode: "HTML",
            reply_markup: resolvedKb,
          })
          .catch(() => null);
      }
      await ctx.answerCbQuery().catch(() => null);
    } else {
      await ctx.answerCbQuery("Решение уже принято");
    }
    return;
  }

  if (/^panelreq:reviewer:\d+$/.test(data)) {
    await ctx.answerCbQuery("Решение уже зафиксировано").catch(() => null);
    return;
  }

  const mA = data.match(/^rent:approve:(\d+):(\d+)$/);
  if (mA) {
    const rentalId = Number(mA[1]);
    const userId = Number(mA[2]);
    db.prepare("UPDATE rentals SET is_busy = 1, rented_by_user_id = ? WHERE id = ?").run(userId, rentalId);
    db.prepare("INSERT INTO guard_attempts (rental_id, user_id, attempts_left) VALUES (?, ?, 1) ON CONFLICT(rental_id, user_id) DO UPDATE SET attempts_left = 1").run(rentalId, userId);
    const u = db.prepare("SELECT tg_id FROM users WHERE id = ?").get(userId) as any;
    const approvedRent = db.prepare("SELECT * FROM rentals WHERE id = ?").get(rentalId) as any;
    const approverLabel = me.tg_username ? `@${me.tg_username}` : String(me.tg_id);
    const approvedText =
      `<tg-emoji emoji-id="5242456018008445356">✅</tg-emoji> <b>Заявка №${approvedRent?.number ?? "?"} на аренду аккаунта</b>\n` +
      `├ Была принята: <b>${approverLabel}</b>\n` +
      `├ Логин: <b>${String(approvedRent?.login || "-")}</b>\n` +
      `├ Пароль: <b>${String(approvedRent?.pass || "-")}</b>\n` +
      `╰ Steam Guard: <b>/guard ${approvedRent?.number ?? ""}</b>\n\n` +
      `<i>Обратите внимание, получить код Steam Guard можно только 1 раз, срок аренды действует до первого профита. В случае инактива в течении 7 дней, аккаунт автоматически восстанавливается.</i>`;
    await bot.telegram.sendMessage(u.tg_id, approvedText, { parse_mode: "HTML" }).catch(() => null);
    const reviewerLabel = me.discord_tag || (me.tg_username ? `@${me.tg_username}` : String(me.tg_id));
    const notifRows = db
      .prepare("SELECT admin_tg_id, message_id FROM rent_request_messages WHERE rental_id = ? AND user_id = ?")
      .all(rentalId, userId) as any[];
    for (const n of notifRows) {
      await bot.telegram
        .editMessageReplyMarkup(n.admin_tg_id, n.message_id, undefined, {
          inline_keyboard: [[{ text: `✅ Принято | ${reviewerLabel}`, callback_data: `rent:reviewer:${me.id}` }]],
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Принято").catch(() => null);
    return;
  }
  const mR = data.match(/^rent:reject:(\d+):(\d+)$/);
  if (mR) {
    const rentalId = Number(mR[1]);
    const userId = Number(mR[2]);
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    const rent = db.prepare("SELECT * FROM rentals WHERE id = ?").get(rentalId) as any;
    const renter = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const originalText =
      `<tg-emoji emoji-id="5240013139394731866">🔔</tg-emoji> <b>Новая заявка №${rent?.number ?? "?"} на аренду аккаунта</b>\n` +
      `├ Пользователь: <b>@${renter?.tg_username || renter?.tg_id || userId}</b>\n` +
      `╰ Discord: <b>${renter?.discord_tag || "-"}</b>`;
    state.set(ctx.from!.id, {
      mode: "rent_reject_reason",
      payload: {
        rentalId,
        userId,
        reviewerId: me.id,
        reviewChatId: cbMsg?.chat?.id ? Number(cbMsg.chat.id) : null,
        reviewMessageId: cbMsg?.message_id ? Number(cbMsg.message_id) : null,
        originalText,
      },
    });
    const clickedChatId = cbMsg?.chat?.id ? Number(cbMsg.chat.id) : -1;
    const clickedMessageId = cbMsg?.message_id ? Number(cbMsg.message_id) : -1;
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите причину отказа или отправьте -, чтобы отклонить без причины.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "◀️ Назад", callback_data: `rent:reject:back:${rentalId}:${userId}` }]],
          },
        },
      )
      .catch(() => null);
    const reviewerLabel = me.discord_tag || (me.tg_username ? `@${me.tg_username}` : String(me.tg_id));
    const notifRows = db
      .prepare("SELECT admin_tg_id, message_id FROM rent_request_messages WHERE rental_id = ? AND user_id = ?")
      .all(rentalId, userId) as any[];
    for (const n of notifRows) {
      if (Number(n.admin_tg_id) === clickedChatId && Number(n.message_id) === clickedMessageId) {
        continue;
      }
      await bot.telegram
        .editMessageReplyMarkup(n.admin_tg_id, n.message_id, undefined, {
          inline_keyboard: [[{ text: `❌ Отклонено | ${reviewerLabel}`, callback_data: `rent:reviewer:${me.id}` }]],
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Введите причину").catch(() => null);
    return;
  }
  const mRB = data.match(/^rent:reject:back:(\d+):(\d+)$/);
  if (mRB) {
    const rentalId = Number(mRB[1]);
    const userId = Number(mRB[2]);
    const rent = db.prepare("SELECT * FROM rentals WHERE id = ?").get(rentalId) as any;
    const renter = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const originalText =
      `<tg-emoji emoji-id="5240013139394731866">🔔</tg-emoji> <b>Новая заявка №${rent?.number ?? "?"} на аренду аккаунта</b>\n` +
      `├ Пользователь: <b>@${renter?.tg_username || renter?.tg_id || userId}</b>\n` +
      `╰ Discord: <b>${renter?.discord_tag || "-"}</b>`;
    state.delete(ctx.from!.id);
    const notifRows = db
      .prepare("SELECT admin_tg_id, message_id FROM rent_request_messages WHERE rental_id = ? AND user_id = ?")
      .all(rentalId, userId) as any[];
    for (const n of notifRows) {
      await bot.telegram
        .editMessageText(n.admin_tg_id, n.message_id, undefined, originalText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Принять", callback_data: `rent:approve:${rentalId}:${userId}` },
                { text: "❌ Отклонить", callback_data: `rent:reject:${rentalId}:${userId}` },
              ],
              [{ text: "💬 Начать диалог", callback_data: `rent:dialog:start:${rentalId}:${userId}` }],
            ],
          },
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Возврат").catch(() => null);
    return;
  }
  const mReviewer = data.match(/^rent:reviewer:(\d+)$/);
  if (mReviewer) {
    await ctx.answerCbQuery("Решение уже зафиксировано").catch(() => null);
    return;
  }
  if (data === "rent:reason:info") {
    await ctx.answerCbQuery("Причина указана в кнопке").catch(() => null);
    return;
  }
  if (data === "workreq:reason:info") {
    await ctx.answerCbQuery("Причина указана в кнопке").catch(() => null);
    return;
  }
  if (data === "workreq:fail:info") {
    await ctx.answerCbQuery("Статус слета зафиксирован").catch(() => null);
    return;
  }
  if (data === "workreq:done:info") {
    await ctx.answerCbQuery("Статус снятия зафиксирован").catch(() => null);
    return;
  }
  if (data === "workreq:amount:info") {
    await ctx.answerCbQuery("Сумма указана в кнопке").catch(() => null);
    return;
  }
  if (data === "workreq:afk:info") {
    await ctx.answerCbQuery("Статус AFK зафиксирован").catch(() => null);
    return;
  }
  const mD = data.match(/^rent:dialog:start:(\d+):(\d+)$/);
  if (mD) {
    const rentalId = Number(mD[1]);
    const userId = Number(mD[2]);
    const rent = db.prepare("SELECT * FROM rentals WHERE id = ?").get(rentalId) as any;
    if (!rent) {
      await ctx.answerCbQuery("Аренда не найдена").catch(() => null);
      return;
    }
    const renter = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(rent.owner_user_id) as any;
    if (!renter || !owner) {
      await ctx.answerCbQuery("Пользователь не найден").catch(() => null);
      return;
    }
    dialogs.set(rent.number, { workerTgId: Number(owner.tg_id), userTgId: Number(renter.tg_id), active: true });
    await bot.telegram.sendMessage(owner.tg_id, `💬 Диалог по аренде #${rent.number} начат. Пишите сюда, сообщения уйдут арендатору.`).catch(() => null);
    await bot.telegram.sendMessage(renter.tg_id, `💬 Диалог по аренде #${rent.number} начат. Пишите сюда, сообщения уйдут владельцу.`).catch(() => null);
    await ctx.answerCbQuery("Диалог начат").catch(() => null);
  }
  return next();
});

initDb();
cleanupSteamTempDirs().catch(() => null);
steamReadyPromise = ensureSteamRendererReady();
steamWarmupPromise = warmupSteamRenderer();
console.log("[DISCORD OAUTH] init requested (pre-launch)");
startDiscordOAuthServer();
let botStarted = false;
let launchRetryTimer: NodeJS.Timeout | null = null;
const scheduleLaunchRetry = () => {
  if (launchRetryTimer) return;
  launchRetryTimer = setTimeout(() => {
    launchRetryTimer = null;
    void startBot();
  }, 15000);
};
const startBot = async () => {
  try {
    await bot.launch();
    if (!botStarted) {
      botStarted = true;
      console.log("Bot started with SQLite", DB_PATH);
      await configureBotCommands(bot, ADMIN_IDS).catch(() => null);
      startOnlineWatchLoop();
      steamWarmupPromise?.catch(() => null);
    }
  } catch (e: any) {
    const code = String(e?.code || e?.errno || "");
    if (code === "ETIMEDOUT" || String(e?.message || "").includes("ETIMEDOUT")) {
      console.error("[BOT LAUNCH] Telegram timeout, retry in 15s");
    } else {
      console.error("[BOT LAUNCH] Failed, retry in 15s:", e?.message || e);
    }
    scheduleLaunchRetry();
  }
};
void startBot();
process.once("SIGINT", async () => {
  bot.stop("SIGINT");
  await steamBrowser?.close().catch(() => null);
});
process.once("SIGTERM", async () => {
  bot.stop("SIGTERM");
  await steamBrowser?.close().catch(() => null);
});

























