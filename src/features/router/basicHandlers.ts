import { Markup } from "telegraf";


export function registerBasicHandlers(bot: any, deps: any) {
  const {
    db,
    state,
    dialogs,
    onlineWatchRuntime,
    ensureUser,
    hasRole,
    buildDiscordAuthUrl,
    escapeHtml,
    mainKb,
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
  } = deps;
  const usageText = (cmd: string, args = "") =>
    `<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Использование: ${cmd}</b>${args ? ` ${args}` : ""}`;
  const hasLinkedDiscord = (u: any) => {
    const v = String(u?.discord_tag || "").trim();
    return v.length > 0 && v !== "-";
  };

  bot.start(async (ctx: any) => {
    const me = ensureUser(ctx);
    if (!me) return;
    await syncChatCommandsForUser(bot, me, (u: any) => hasRole(u, ["ADMIN"]));
    if (me.is_banned) return void (await ctx.reply("You are banned."));
    if (!me.is_approved || !hasLinkedDiscord(me)) {
      const oauthUrl = buildDiscordAuthUrl(me.tg_id);
      await ctx.reply("<b>❗️Перед использованием бота необходимо привязать Discord.</b>", {
        parse_mode: "HTML",
        reply_markup: oauthUrl
          ? Markup.inlineKeyboard([[Markup.button.url("Привязать Discord", oauthUrl)]]).reply_markup
          : Markup.inlineKeyboard([[Markup.button.callback("Привязать Discord", "register:discord:unavailable")]]).reply_markup,
      });
      return;
    }
    const count = db.prepare("SELECT COUNT(*) c FROM users WHERE is_approved = 1").get() as any;
    await ctx.reply("👋", mainKb);
    await ctx.reply(
      `<b>🙏 Добро пожаловать в <a href="https://discord.gg/criminalchina">CC TEAM BOT</a>.</b>\n` +
        `╰ Пользователей в боте: <b>${escapeHtml(String(count.c))}</b>`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    );
  });
  bot.action("register:discord:unavailable", async (ctx: any) => {
    await ctx.answerCbQuery("OAuth is not configured on server", { show_alert: true }).catch(() => null);
    await ctx.reply("Discord OAuth is not configured. Fill DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI in .env").catch(() => null);
  });

  bot.use(async (ctx: any, next: any) => {
    const me = ensureUser(ctx);
    const txt = (ctx.message as any)?.text as string | undefined;
    if (!me || !txt || !txt.startsWith("/")) return next();
    const cmd = txt.split(/\s+/)[0].toLowerCase();
    const allowAdminSelfJoinFlow = hasRole(me, ["ADMIN"]) && cmd === "/admin";
    if ((!me.is_approved || !hasLinkedDiscord(me)) && cmd !== "/start" && !allowAdminSelfJoinFlow) {
      await syncChatCommandsForUser(bot, me, (u: any) => hasRole(u, ["ADMIN"]));
      await ctx.reply("Сначала привяжите Discord через /start.");
      return;
    }
    return next();
  });

  bot.command("admin", async (ctx: any) => {
    const me = ensureUser(ctx);
    if (!me || !hasRole(me, ["ADMIN", "LANDLORD"])) return;
    if (hasRole(me, ["LANDLORD"]) && !hasRole(me, ["ADMIN"])) {
      await ctx.reply("ㅤ", Markup.keyboard([["Заявки на аренду"]]).resize());
      return;
    }
    await ctx.reply("ㅤ", adminKb);
  });

  bot.command("help", async (ctx: any) => {
    await ctx.reply(
      `<tg-emoji emoji-id="5242655665268232103">📘</tg-emoji> <b>Справка</b>\n` +
        `├ <b>/start —</b> главное меню\n` +
        `├ <b>/help —</b> эта справка\n` +
        `├ <b>/user —</b> профиль пользователя\n` +
        `├ <b>/d —</b> создать заявку на добив\n` +
        `├ <b>/c —</b> проверка на панели\n` +
        `├ <b>/o —</b> чекер онлайна\n` +
        `╰ <b>/guard —</b> получить Steam-Guard код`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("user", async (ctx: any) => {
    const q = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!q) {
      return void (await ctx.reply(usageText("/user", "Discord/@Username/ID"), { parse_mode: "HTML" }));
    }
    const row = getUserByQuery(db as any, q);
    if (!row) return void (await ctx.reply("Пользователь не найден."));
    incrementProfileViews(db as any, row.id);
    const text = await formatProfile(row);
    const avatarUrl = String(row.discord_avatar_url || "").trim();
    if (avatarUrl) {
      const sent = await ctx.replyWithPhoto(avatarUrl, { caption: text, parse_mode: "HTML" }).catch(() => null);
      if (!sent) {
        await ctx.reply(text, { parse_mode: "HTML" }).catch(() => null);
      }
    } else {
      await ctx.reply(text, { parse_mode: "HTML" });
    }
  });

  bot.command("d", async (ctx: any) => {
    const rawText = ctx.message.text.replace("/d", "").trim();
    if (!rawText) {
      await ctx.reply(usageText("/d", "SteamID"), { parse_mode: "HTML" });
      return;
    }
    await createWorkRequest(ctx, rawText);
  });

  bot.command("c", async (ctx: any) => {
    const id = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!/^7\d{15,18}$/.test(id)) {
      return void (await ctx.reply(usageText("/c", "SteamID"), { parse_mode: "HTML" }));
    }
    await ctx.reply("Заявка отправлена в очередь на проверку.");
    await notifyWorkers(
      `Новая заявка на проверку панели\nПользователь: @${ctx.from.username || ctx.from.id}\nID: ${id}`,
      Markup.inlineKeyboard([[Markup.button.callback("✅ Есть", `panel:yes:${ctx.from.id}`), Markup.button.callback("❌ Нету", `panel:no:${ctx.from.id}`)]]),
    );
  });

  bot.command("o", async (ctx: any) => {
    const me = ensureUser(ctx);
    const args = ctx.message.text.split(" ").slice(1);
    if (!args.length) {
      return void (await ctx.reply(usageText("/o", "ссылка_на_профиль/SteamID [комментарий]"), { parse_mode: "HTML" }));
    }
    const normalized = normalizeProfileInput(args[0]);
    const url = normalized?.profileUrl || args[0].trim();
    const comment = args.slice(1).join(" ") || null;
    const ex = findOnlineWatch(db as any, me.id, url);
    if (ex) {
      deleteOnlineWatchById(db as any, ex.id);
      onlineWatchRuntime.delete(ex.id);
      await ctx.reply("Отслеживание отключено.");
    } else {
      createOnlineWatch(db as any, me.id, url, comment);
      await ctx.reply("Отслеживание включено.");
    }
  });

  bot.command("stop", async (ctx: any) => {
    const me = ensureUser(ctx);
    if (!me) return;
    const numRaw = ctx.message.text.split(" ")[1];
    const num = Number(numRaw);
    if (numRaw && Number.isFinite(num) && num > 0) {
      const d = dialogs.get(num);
      const myId = Number(me.tg_id);
      if (!d || (Number(d.userTgId) !== myId && Number(d.workerTgId) !== myId && !hasRole(me, ["ADMIN"]))) {
        await ctx.reply("Диалог не найден.");
        return;
      }
      dialogs.delete(num);
      await ctx.reply(`Диалог #${num} остановлен.`);
      return;
    }
    const myId = Number(me.tg_id);
    let stopped = 0;
    for (const [dialogNum, d] of dialogs.entries()) {
      if (Number(d.userTgId) === myId || Number(d.workerTgId) === myId) {
        dialogs.delete(dialogNum);
        stopped += 1;
      }
    }
    if (!stopped) {
      await ctx.reply("Активный диалог не найден.");
      return;
    }
    await ctx.reply(stopped === 1 ? "Текущий диалог остановлен." : `Остановлено диалогов: ${stopped}.`);
  });

  bot.command("guard", async (ctx: any) => {
    const me = ensureUser(ctx);
    const rawNum = ctx.message.text.split(" ")[1];
    const num = Number(rawNum);
    if (!rawNum || !Number.isInteger(num) || num < 0) {
      await ctx.reply(`<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Использование: /guard</b> номер_аккаунта`, {
        parse_mode: "HTML",
      });
      return;
    }
    const rent = db.prepare("SELECT * FROM rentals WHERE number = ?").get(num) as any;
    if (!rent || rent.rented_by_user_id !== me.id)
      return void (
        await ctx.reply(`<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Аккаунт не найден или не выдан вам.</b>`, {
          parse_mode: "HTML",
        })
      );
    const ga = db.prepare("SELECT * FROM guard_attempts WHERE rental_id = ? AND user_id = ?").get(rent.id, me.id) as any;
    if (!ga || ga.attempts_left <= 0) return void (await ctx.reply("Попытки получения Guard-кода закончились."));
    let guardCode: string;
    try {
      guardCode = String(await getRentalGuardCode(rent));
    } catch {
      return void (await ctx.reply("Не удалось получить Guard-код. Проверьте данные аккаунта и maFile."));
    }
    db.prepare("UPDATE guard_attempts SET attempts_left = attempts_left - 1 WHERE id = ?").run(ga.id);
    await ctx.reply(`<tg-emoji emoji-id="5240187442052510372">🔑</tg-emoji> <b>Steam-Guard код:</b> <code>${guardCode}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("guardset", async (ctx: any) => {
    const me = ensureUser(ctx);
    if (!me || !hasRole(me, ["ADMIN", "LANDLORD"])) return;
    const p = ctx.message.text.split(" ").slice(1);
    const num = Number(p[0]);
    const who = p.slice(1).join(" ");
    const rent = db.prepare("SELECT * FROM rentals WHERE number = ?").get(num) as any;
    if (!rent || !who) {
      return void (
        await ctx.reply(
          `<tg-emoji emoji-id="5239948611806081116">ℹ️</tg-emoji> <b>Использование: /guardset</b> номер_аккаунта ID/@Username/Discord`,
          { parse_mode: "HTML" },
        )
      );
    }
    const target = db
      .prepare(
        "SELECT * FROM users WHERE id = ? OR LOWER(IFNULL(discord_tag,'')) = LOWER(?) OR LOWER(IFNULL(tg_username,'')) = LOWER(?) LIMIT 1",
      )
      .get(Number(who) || -1, who, who.replace("@", "")) as any;
    if (!target) return void (await ctx.reply("Пользователь не найден."));
    db.prepare(
      "INSERT INTO guard_attempts (rental_id, user_id, attempts_left) VALUES (?, ?, 1) ON CONFLICT(rental_id, user_id) DO UPDATE SET attempts_left = attempts_left + 1",
    ).run(rent.id, target.id);
    await ctx.reply(
      `<tg-emoji emoji-id="5240187442052510372">🔑</tg-emoji> <b>Доступ к получению Steam-Guard коду успешно выдан на 1 использование.</b>`,
      { parse_mode: "HTML" },
    );
  });

  bot.action(/queue:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "PENDING") return void (await ctx.answerCbQuery("Заявка уже обработана"));
    const q = db.prepare("SELECT COUNT(*) c FROM work_requests WHERE status = 'PENDING' AND id < ?").get(req.id) as any;
    await ctx.answerCbQuery(`Позиция в очереди: ${q.c + 1}`);
  });

  bot.action(/work:take:(\d+)/, async (ctx: any) => {
    const me = ensureUser(ctx);
    if (!me || !hasRole(me, ["ADMIN", "DOBIVER"])) return;
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "PENDING") return;
    db.prepare("UPDATE work_requests SET status = 'TAKEN', worker_id = ? WHERE id = ?").run(me.id, req.id);
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const actorLabel = me.tg_username ? `@${me.tg_username}` : String(me.tg_id);
    await bot.telegram
      .sendMessage(
        owner.tg_id,
        `<b>✅ Заявка №${req.number} на добив взята: ${actorLabel}.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("💬 Начать диалог", `dialog:start:${req.number}`)]]).reply_markup,
        },
      )
      .catch(() => null);
    const reviewerLabel = me.discord_tag || (me.tg_username ? `@${me.tg_username}` : String(me.tg_id));
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageReplyMarkup(m.admin_tg_id, m.message_id, undefined, {
          inline_keyboard: [[{ text: `✅ Взято | ${reviewerLabel}`, callback_data: `workreq:reviewer:${me.id}` }]],
        })
        .catch(() => null);
    }
    await ctx
      .editMessageText(`<b>Заявка №${req.number} взята.</b>`, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Снят", `work:done:${req.id}`),
            Markup.button.callback("❌ Слет", `work:fail:${req.id}`),
            Markup.button.callback("⏸ AFK", `work:afk:${req.id}`),
          ],
        ]).reply_markup,
      })
      .catch(async () => {
        await ctx.reply(
          `<b>Заявка №${req.number} взята.</b>`,
          {
            parse_mode: "HTML",
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback("✅ Снят", `work:done:${req.id}`),
                Markup.button.callback("❌ Слет", `work:fail:${req.id}`),
                Markup.button.callback("⏸ AFK", `work:afk:${req.id}`),
              ],
            ]).reply_markup,
          },
        );
      });
  });

  bot.action(/dialog:start:(\d+)/, async (ctx: any) => {
    const me = ensureUser(ctx);
    const req = db.prepare("SELECT * FROM work_requests WHERE number = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.owner_id !== me.id || !req.worker_id) return;
    const DOBIVER = db.prepare("SELECT * FROM users WHERE id = ?").get(req.worker_id) as any;
    dialogs.set(req.number, { workerTgId: DOBIVER.tg_id, userTgId: me.tg_id, active: true });
    await ctx.reply("Диалог запущен. Для остановки используйте /stop.");
  });

  bot.action(/work:reject:(\d+)/, async (ctx: any) => {
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "PENDING") return void (await ctx.answerCbQuery("Решение уже принято"));
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const originalText =
      `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>@${owner?.tg_username || owner?.tg_id || req.owner_id}</b>\n` +
      `├ Discord: <b>${owner?.discord_tag || "-"}</b>\n` +
      `╰ SteamID: <code>${req.steam_id}</code>`;
    state.set(ctx.from.id, { mode: "await_work_reject", payload: { id: req.id, reviewerId: actor.id, originalText } });
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    const clickedChatId = cbMsg?.chat?.id ? Number(cbMsg.chat.id) : -1;
    const clickedMessageId = cbMsg?.message_id ? Number(cbMsg.message_id) : -1;
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите причину отказа или отправьте -, чтобы отклонить без причины.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:reject:back:${req.id}` }]] },
        },
      )
      .catch(() => null);
    const reviewerLabel = actor.discord_tag || (actor.tg_username ? `@${actor.tg_username}` : String(actor.tg_id));
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      if (Number(m.admin_tg_id) === clickedChatId && Number(m.message_id) === clickedMessageId) continue;
      await bot.telegram
        .editMessageReplyMarkup(m.admin_tg_id, m.message_id, undefined, {
          inline_keyboard: [[{ text: `❌ Отказано | ${reviewerLabel}`, callback_data: `workreq:reviewer:${actor.id}` }]],
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Введите причину").catch(() => null);
  });

  bot.action(/work:reject:back:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "PENDING") return void (await ctx.answerCbQuery("Решение уже принято"));
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const originalText =
      `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>@${owner?.tg_username || owner?.tg_id || req.owner_id}</b>\n` +
      `├ Discord: <b>${owner?.discord_tag || "-"}</b>\n` +
      `╰ SteamID: <code>${req.steam_id}</code>`;
    state.delete(ctx.from.id);
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, originalText, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("✅ Взять", `work:take:${req.id}`), Markup.button.callback("❌ Отказаться", `work:reject:${req.id}`)],
          ]).reply_markup,
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Возврат").catch(() => null);
  });

  bot.action(/workreq:reviewer:(\d+)/, async (ctx: any) => {
    await ctx.answerCbQuery("Решение уже зафиксировано").catch(() => null);
  });

  bot.action(/work:done:(\d+)/, async (ctx: any) => {
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    state.set(ctx.from.id, {
      mode: "await_work_amount",
      payload: {
        id: Number(ctx.match[1]),
        promptChatId: cbMsg?.chat?.id ? Number(cbMsg.chat.id) : null,
        promptMessageId: cbMsg?.message_id ? Number(cbMsg.message_id) : null,
      },
    });
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сумму снятой сессии в USD.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `work:done:back:${ctx.match[1]}`)]]).reply_markup,
        },
      )
      .catch(async () => {
        await ctx.reply(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сумму снятой сессии в USD.</b>`, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `work:done:back:${ctx.match[1]}`)]]).reply_markup,
        });
      });
  });

  bot.action(/work:done:back:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "TAKEN") return void (await ctx.answerCbQuery("Заявка недоступна"));
    state.delete(ctx.from.id);
    await ctx
      .editMessageText(`<b>Заявка №${req.number} взята.</b>`, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Снят", `work:done:${req.id}`),
            Markup.button.callback("❌ Слет", `work:fail:${req.id}`),
            Markup.button.callback("⏸ AFK", `work:afk:${req.id}`),
          ],
        ]).reply_markup,
      })
      .catch(() => null);
    await ctx.answerCbQuery("Возврат").catch(() => null);
  });

  bot.action(/work:fail:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "TAKEN") return void (await ctx.answerCbQuery("Заявка недоступна"));
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    state.set(ctx.from.id, {
      mode: "await_work_fail",
      payload: {
        id: req.id,
        promptChatId: cbMsg?.chat?.id ? Number(cbMsg.chat.id) : null,
        promptMessageId: cbMsg?.message_id ? Number(cbMsg.message_id) : null,
      },
    });
    await ctx
      .editMessageText(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите причину слета.</b>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:fail:back:${req.id}` }]] },
      })
      .catch(async () => {
        await ctx.reply(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите причину слета.</b>`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `work:fail:back:${req.id}` }]] },
        });
      });
  });

  bot.action(/work:fail:back:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "TAKEN") return void (await ctx.answerCbQuery("Заявка недоступна"));
    state.delete(ctx.from.id);
    await ctx
      .editMessageText(`<b>Заявка №${req.number} взята.</b>`, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Снят", `work:done:${req.id}`),
            Markup.button.callback("❌ Слет", `work:fail:${req.id}`),
            Markup.button.callback("⏸ AFK", `work:afk:${req.id}`),
          ],
        ]).reply_markup,
      })
      .catch(() => null);
    await ctx.answerCbQuery("Возврат").catch(() => null);
  });

  bot.action(/work:link:back:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req || req.status !== "TAKEN") return void (await ctx.answerCbQuery("Заявка недоступна"));
    state.set(ctx.from.id, {
      mode: "await_work_amount",
      payload: {
        id: req.id,
        promptChatId: (ctx.callbackQuery as any)?.message?.chat?.id || null,
        promptMessageId: (ctx.callbackQuery as any)?.message?.message_id || null,
      },
    });
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сумму снятой сессии в USD.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback("◀️ Назад", `work:done:back:${req.id}`)]]).reply_markup,
        },
      )
      .catch(() => null);
    await ctx.answerCbQuery("Возврат").catch(() => null);
  });

  bot.action(/work:afk:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req) return;
    db.prepare("UPDATE work_requests SET status = 'AFK', closed_at = ? WHERE id = ?").run(nowIso(), req.id);
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const worker = db.prepare("SELECT * FROM users WHERE id = ?").get(req.worker_id) as any;
    const workerLabel =
      String(worker?.discord_tag || "").trim() || (String(worker?.tg_username || "").trim() ? `@${worker.tg_username}` : String(worker?.tg_id || ""));
    const restoredText =
      `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>@${owner?.tg_username || owner?.tg_id || req.owner_id}</b>\n` +
      `├ Discord: <b>${owner?.discord_tag || "-"}</b>\n` +
      `╰ SteamID: <code>${req.steam_id}</code>`;
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, restoredText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ Взято | ${workerLabel}`, callback_data: `workreq:reviewer:${req.worker_id}` }],
              [{ text: "⏸ AFK", callback_data: "workreq:afk:info" }],
            ],
          },
        })
        .catch(() => null);
    }
    await bot.telegram
      .sendMessage(
        owner.tg_id,
        `<b>😴 Ваша сессия по заявке на добив №${req.number} находится не у компьютера (спит).</b>\n\nДобив был отменен, просим пересоздать заявку как только сессия будет у компьютера`,
        { parse_mode: "HTML" },
      )
      .catch(() => null);
    await ctx.answerCbQuery("AFK").catch(() => null);
  });

  bot.action(/dodep:(usd|yuan):(\d+)/, async (ctx: any) => {
    const curr = String(ctx.match[1]);
    const reqId = Number(ctx.match[2]);
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    state.set(ctx.from.id, {
      mode: "await_dodep",
      payload: {
        curr,
        id: reqId,
        promptChatId: cbMsg?.chat?.id ? Number(cbMsg.chat.id) : null,
        promptMessageId: cbMsg?.message_id ? Number(cbMsg.message_id) : null,
      },
    });
    const sign = curr === "usd" ? "$" : "¥";
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сумму додепа в ${sign}.</b>`,
        { parse_mode: "HTML" },
      )
      .catch(async () => {
        await ctx.reply(`<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сумму додепа в ${sign}.</b>`, {
          parse_mode: "HTML",
        });
      });
  });

  bot.action(/dodep:finish:(\d+)/, async (ctx: any) => {
    const req = db.prepare("SELECT * FROM work_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req) return void (await ctx.answerCbQuery("Заявка не найдена"));
    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.owner_id) as any;
    const worker = db.prepare("SELECT * FROM users WHERE id = ?").get(req.worker_id) as any;
    const workerLabel =
      String(worker?.discord_tag || "").trim() || (String(worker?.tg_username || "").trim() ? `@${worker.tg_username}` : String(worker?.tg_id || ""));
    const restoredText =
      `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на добив</b>\n` +
      `├ Пользователь: <b>@${owner?.tg_username || owner?.tg_id || req.owner_id}</b>\n` +
      `├ Discord: <b>${owner?.discord_tag || "-"}</b>\n` +
      `╰ SteamID: <code>${req.steam_id}</code>`;
    const amountLabel = `Сумма: $${Number(req.amount_usd || 0)}`.slice(0, 60);
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM work_request_messages WHERE work_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, restoredText, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ Взято | ${workerLabel}`, callback_data: `workreq:reviewer:${req.worker_id}` }],
              [{ text: "✅ Снят", callback_data: "workreq:done:info" }],
              [{ text: amountLabel, callback_data: "workreq:amount:info" }],
            ],
          },
        })
        .catch(() => null);
    }
    state.delete(ctx.from.id);
    await ctx.answerCbQuery("Завершено").catch(() => null);
  });

  bot.action(/dodep:skip:(\d+)/, async (ctx: any) => {
    state.delete(ctx.from.id);
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.answerCbQuery("Пропущено").catch(() => null);
  });

  bot.action(/join:approve:(\d+)/, async (ctx: any) => {
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = db.prepare("SELECT * FROM join_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req) return;
    const upd = db.prepare("UPDATE join_requests SET status = 'APPROVED', reviewed_by_user_id = ? WHERE id = ? AND status = 'PENDING'").run(actor.id, req.id);
    if (!upd.changes) return void (await ctx.answerCbQuery("Решение уже принято"));
    db.prepare("UPDATE users SET is_approved = 1 WHERE id = ?").run(req.user_id);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
    await bot.telegram
      .sendMessage(u.tg_id, "<b>✅ Ваша заявка на вступление принята. Напишите /start чтобы открыть главное меню.</b>", {
        parse_mode: "HTML",
      })
      .catch(() => null);
    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id) as any;
    const reviewerLabel =
      String(reviewer?.discord_tag || "").trim() || (String(reviewer?.tg_username || "").trim() ? `@${reviewer.tg_username}` : String(reviewer?.tg_id || ""));
    const kb = Markup.inlineKeyboard([[Markup.button.callback(`✅ Принято | ${reviewerLabel}`, `joinreq:reviewer:${actor.id}`)]]).reply_markup;
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM join_request_messages WHERE join_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram.editMessageReplyMarkup(m.admin_tg_id, m.message_id, undefined, kb).catch(() => null);
    }
    await ctx.answerCbQuery().catch(() => null);
  });

  bot.action(/join:reject:(\d+)/, async (ctx: any) => {
    const actor = ensureUser(ctx);
    if (!actor) return;
    const req = db.prepare("SELECT * FROM join_requests WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!req) return;
    if (req.status !== "PENDING") return void (await ctx.answerCbQuery("Решение уже принято"));
    const cbMsg: any = (ctx.callbackQuery as any)?.message;
    const applicant = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
    const originalText =
      `<tg-emoji emoji-id="5240106271465582633">🆕</tg-emoji> <b>Новая заявка №${req.number} на вступление</b>\n` +
      `├ Пользователь: <b>@${applicant?.tg_username || applicant?.tg_id || req.user_id}</b>\n` +
      `╰ Discord: <b>${req.discord_tag || "-"}</b>`;
    state.set(ctx.from.id, {
      mode: "await_join_reject",
      payload: {
        id: Number(ctx.match[1]),
        reviewerId: actor.id,
        originalText,
      },
    });
    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(actor.id) as any;
    const reviewerLabel =
      String(reviewer?.discord_tag || "").trim() || (String(reviewer?.tg_username || "").trim() ? `@${reviewer.tg_username}` : String(reviewer?.tg_id || ""));
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM join_request_messages WHERE join_request_id = ?").all(req.id) as any[];
    const clickedChatId = cbMsg?.chat?.id ? Number(cbMsg.chat.id) : -1;
    const clickedMessageId = cbMsg?.message_id ? Number(cbMsg.message_id) : -1;
    await ctx
      .editMessageText(
        `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите причину отказа или отправьте -, чтобы отклонить без причины.</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "◀️ Назад", callback_data: `join:reject:back:${req.id}` }]],
          },
        },
      )
      .catch(() => null);
    for (const m of msgs) {
      if (Number(m.admin_tg_id) === clickedChatId && Number(m.message_id) === clickedMessageId) continue;
      await bot.telegram
        .editMessageReplyMarkup(m.admin_tg_id, m.message_id, undefined, {
          inline_keyboard: [[{ text: `❌ Отклонено | ${reviewerLabel}`, callback_data: `joinreq:reviewer:${actor.id}` }]],
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Введите причину").catch(() => null);
  });

  bot.action(/join:reject:back:(\d+)/, async (ctx: any) => {
    const joinRequestId = Number(ctx.match[1]);
    const req = db.prepare("SELECT * FROM join_requests WHERE id = ?").get(joinRequestId) as any;
    if (!req || req.status !== "PENDING") return void (await ctx.answerCbQuery("Решение уже принято"));
    const applicant = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user_id) as any;
    const originalText =
      `<tg-emoji emoji-id="5240106271465582633">🆕</tg-emoji> <b>Новая заявка №${req.number} на вступление</b>\n` +
      `├ Пользователь: <b>@${applicant?.tg_username || applicant?.tg_id || req.user_id}</b>\n` +
      `╰ Discord: <b>${req.discord_tag || "-"}</b>`;
    state.delete(ctx.from.id);
    const msgs = db.prepare("SELECT admin_tg_id, message_id FROM join_request_messages WHERE join_request_id = ?").all(req.id) as any[];
    for (const m of msgs) {
      await bot.telegram
        .editMessageText(m.admin_tg_id, m.message_id, undefined, originalText, {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("✅ Принять", `join:approve:${req.id}`), Markup.button.callback("❌ Отклонить", `join:reject:${req.id}`)],
          ]).reply_markup,
        })
        .catch(() => null);
    }
    await ctx.answerCbQuery("Возврат").catch(() => null);
  });

  bot.action(/joinreq:reviewer:(\d+)/, async (ctx: any) => {
    const reviewer = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(ctx.match[1])) as any;
    if (!reviewer) return void (await ctx.answerCbQuery("Пользователь не найден"));
    const profile = await formatProfile(reviewer);
    const avatarUrl = String(reviewer.discord_avatar_url || "").trim();
    if (avatarUrl) {
      await ctx.replyWithPhoto(avatarUrl, { caption: profile, parse_mode: "HTML" }).catch(() => null);
    } else {
      await ctx.reply(profile, { parse_mode: "HTML" }).catch(() => null);
    }
    await ctx.answerCbQuery().catch(() => null);
  });

  bot.action(/admin:ban:(\d+)/, async (ctx: any) => {
    const u = db.prepare("SELECT is_banned FROM users WHERE id = ?").get(Number(ctx.match[1])) as any;
    db.prepare("UPDATE users SET is_banned = ? WHERE id = ?").run(u.is_banned ? 0 : 1, Number(ctx.match[1]));
    await ctx.answerCbQuery(u.is_banned ? "Пользователь разблокирован" : "Пользователь заблокирован");
  });

  bot.action(/admin:msg:(\d+)(?::(\d+))?/, async (ctx: any) => {
    const userId = Number(ctx.match[1]);
    const returnPage = Number(ctx.match[2] || 0) || 0;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const promptMessageId = (ctx.callbackQuery as any)?.message?.message_id || null;
    state.set(ctx.from.id, { mode: "admin_send_msg", payload: { userId, returnPage, promptMessageId } });
    const label = `@${target?.tg_username || target?.tg_id || userId}`;
    const text = `<tg-emoji emoji-id="5240446651918753852">📝</tg-emoji> <b>Введите сообщение для пользователя ${label}.</b>`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML" })
      .catch(async () => {
        await ctx.reply(text, { parse_mode: "HTML" }).catch(() => null);
      });
    await ctx.answerCbQuery().catch(() => null);
  });

  bot.action(/admin:roles:(\d+)(?::(\d+))?/, async (ctx: any) => {
    const userId = Number(ctx.match[1]);
    const returnPage = Number((ctx.match as any)?.[2] || 0) || 0;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    if (!target || !target.is_approved || !String(target.discord_tag || "").trim() || String(target.discord_tag || "").trim() === "-") {
      await ctx.answerCbQuery("Права можно выдавать только зарегистрированным пользователям", { show_alert: true }).catch(() => null);
      return;
    }
    if (!target) return void (await ctx.answerCbQuery("Пользователь не найден", { show_alert: true }).catch(() => null));
    const roleTitles: Record<string, string> = {
      ADMIN: "Администратор",
      DOBIVER: "Добивер",
      LANDLORD: "Арендодатель",
      CHATER: "Чатер",
    };
    const roles = ["ADMIN", "DOBIVER", "LANDLORD", "CHATER"];
    const assigned = new Set(
      (db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(userId) as Array<{ role: string }>).map((x) => x.role),
    );
    const kb = Markup.inlineKeyboard([
      ...roles.map((r) => [Markup.button.callback(`${assigned.has(r) ? "✓ " : ""}${roleTitles[r]}`, `admin:roles:toggle:${userId}:${r}:${returnPage}`)]),
      [Markup.button.callback("◀️ Назад", `admin:usercard:${userId}:${returnPage}`)],
    ]);
    const text =
      `<b>Выдача ролей.</b>\n\n` +
      `Пользователь: <b>@${target.tg_username || target.tg_id}</b>\n` +
      `Discord: <b>${target.discord_tag || "-"}</b>\n` +
      `ID: <b>${target.id}</b>\n\n` +
      `Нажмите на роль, чтобы выдать или снять.`;
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }).catch(() => null);
    await ctx.answerCbQuery().catch(() => null);
  });

  bot.action(/admin:roles:toggle:(\d+):([A-Z_]+):(\d+)/, async (ctx: any) => {
    const userId = Number(ctx.match[1]);
    const role = String(ctx.match[2]);
    const returnPage = Number(ctx.match[3] || 0) || 0;
    const allowed = new Set(["ADMIN", "DOBIVER", "LANDLORD", "CHATER"]);
    if (!allowed.has(role)) return void (await ctx.answerCbQuery("Неизвестная роль", { show_alert: true }).catch(() => null));
    const exists = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = ?").get(userId, role) as any;
    if (exists) db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role = ?").run(userId, role);
    else db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)").run(userId, role);
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'USER')").run(userId);
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    if (!target || !target.is_approved || !String(target.discord_tag || "").trim() || String(target.discord_tag || "").trim() === "-") {
      await ctx.answerCbQuery("Права можно выдавать только зарегистрированным пользователям", { show_alert: true }).catch(() => null);
      return;
    }
    const roleTitles: Record<string, string> = {
      ADMIN: "Администратор",
      DOBIVER: "Добивер",
      LANDLORD: "Арендодатель",
      CHATER: "Чатер",
    };
    const roles = ["ADMIN", "DOBIVER", "LANDLORD", "CHATER"];
    const assigned = new Set(
      (db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(userId) as Array<{ role: string }>).map((x) => x.role),
    );
    const kb = Markup.inlineKeyboard([
      ...roles.map((r) => [Markup.button.callback(`${assigned.has(r) ? "✓ " : ""}${roleTitles[r]}`, `admin:roles:toggle:${userId}:${r}:${returnPage}`)]),
      [Markup.button.callback("◀️ Назад", `admin:usercard:${userId}:${returnPage}`)],
    ]);
    const text =
      `<b>Выдача ролей.</b>\n\n` +
      `Пользователь: <b>@${target?.tg_username || target?.tg_id || userId}</b>\n` +
      `Discord: <b>${target?.discord_tag || "-"}</b>\n` +
      `ID: <b>${target?.id || userId}</b>\n\n` +
      `Нажмите на роль, чтобы выдать или снять.`;
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb.reply_markup }).catch(() => null);
    await ctx.answerCbQuery(exists ? "Роль снята" : "Роль выдана").catch(() => null);
  });

  bot.action(/panel:yes:(\d+)/, async (ctx: any) => {
    await bot.telegram.sendMessage(Number(ctx.match[1]), "✅ Ваш Steam ID найден на панели.").catch(() => null);
  });

  bot.action(/panel:no:(\d+)/, async (ctx: any) => {
    await bot.telegram.sendMessage(Number(ctx.match[1]), "❌ Ваш Steam ID не найден на панели.").catch(() => null);
  });

}
























