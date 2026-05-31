import { Markup } from "telegraf";

export const mainKb = Markup.keyboard([
  ["🙎 Мой профиль"],
  ["👊 Отдать на добив", "🔎 Проверка на панеле"],
  ["🖌️ Отрисовка", "🟢 Чекер онлайна"],
  ["🧬 Аренда аккаунтов"],
]).resize();

export const adminKb = Markup.keyboard([
  ["Пользователи"],
  ["Рассылка", "Статистика"],
  ["Логи", "Уведомления"],
  ["Заявки на вступление", "Заявки на добив"],
  ["Заявки на проверку", "Заявки на аренду"],
]).resize();

export function langInlineKb(currentLangRaw: string) {
  const currentLang = currentLangRaw === "en" ? "en" : "ru";
  const ruLabel = currentLang === "ru" ? "✓ Русский (RU)" : "Русский (RU)";
  const enLabel = currentLang === "en" ? "✓ English (EN)" : "English (EN)";
  return Markup.inlineKeyboard([[Markup.button.callback(ruLabel, "lang:set:ru"), Markup.button.callback(enLabel, "lang:set:en")]]);
}
