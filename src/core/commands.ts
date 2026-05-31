import type { Telegraf } from "telegraf";

export async function configureBotCommands(bot: Telegraf<any>, adminIds: number[]) {
  await bot.telegram.deleteMyCommands().catch(() => null);
  await bot.telegram.deleteMyCommands({ scope: { type: "all_private_chats" } as any }).catch(() => null);
  await bot.telegram.deleteMyCommands({ scope: { type: "all_group_chats" } as any }).catch(() => null);
  await bot.telegram.deleteMyCommands({ scope: { type: "all_chat_administrators" } as any }).catch(() => null);

  const userCmds = [
    { command: "start", description: "Открыть главное меню" },
    { command: "help", description: "Помощь" },
    { command: "user", description: "Посмотреть профиль" },
    { command: "d", description: "Отдать на добив" },
    { command: "c", description: "Проверка на панели" },
    { command: "o", description: "Чекер онлайна (быстро)" },
    { command: "guard", description: "Посмотреть Guard-код" },
  ];
  await bot.telegram.setMyCommands(userCmds);
  await bot.telegram.setMyCommands(userCmds, { scope: { type: "all_private_chats" } as any });

  for (const adminTgId of adminIds) {
    await bot.telegram.setMyCommands(
      [
        ...userCmds,
        { command: "admin", description: "Админ-панель" },
        { command: "stop", description: "Остановить диалог" },
      ],
      { scope: { type: "chat", chat_id: adminTgId } as any },
    );
  }
}

export async function syncChatCommandsForUser(
  bot: Telegraf<any>,
  user: any,
  isAdmin: (u: any) => boolean,
) {
  const chatScope = { scope: { type: "chat", chat_id: user.tg_id } as any };
  if (!user.is_approved) {
    await bot.telegram.setMyCommands([{ command: "start", description: "Открыть главное меню" }], chatScope).catch(() => null);
    return;
  }
  const userCmds = [
    { command: "start", description: "Открыть главное меню" },
    { command: "help", description: "Помощь" },
    { command: "user", description: "Посмотреть профиль" },
    { command: "d", description: "Отдать на добив" },
    { command: "c", description: "Проверка на панели" },
    { command: "o", description: "Чекер онлайна (быстро)" },
    { command: "guard", description: "Посмотреть Guard-код" },
  ];
  if (isAdmin(user)) {
    await bot.telegram
      .setMyCommands(
        [
          ...userCmds,
          { command: "admin", description: "Админ-панель" },
          { command: "stop", description: "Остановить диалог" },
        ],
        chatScope,
      )
      .catch(() => null);
    return;
  }
  await bot.telegram.setMyCommands(userCmds, chatScope).catch(() => null);
}
