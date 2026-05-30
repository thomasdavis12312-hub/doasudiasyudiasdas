export function panelRequestText(req: any, owner: any) {
  return (
    `<tg-emoji emoji-id="5239948611806081116">🕒</tg-emoji> <b>Новая заявка №${req.number} на проверку на панеле</b>\n` +
    `├ Пользователь: <b>@${owner?.tg_username || owner?.tg_id || req.user_id}</b>\n` +
    `├ Discord: <b>${owner?.discord_tag || "-"}</b>\n` +
    `╰ SteamID: <code>${req.steam_id}</code>`
  );
}

export function joinRequestText(req: any, owner: any) {
  return `🔔 Новая заявка №${req.number} на вступление\n\nПользователь: @${owner?.tg_username || owner?.tg_id || req.user_id}\nDiscord: ${owner?.discord_tag || req.discord_tag || "-"}`;
}
