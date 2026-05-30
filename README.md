# CC Team Bot (SQLite build)

## Quick start
1. Fill `.env`:
   - `BOT_TOKEN`
   - `ADMIN_TG_IDS`
   - `SQLITE_PATH=./bot.db`
2. Run:
   - `npm install`
   - `npm run build`
   - `npm run dev`

## Implemented
- Registration + join requests moderation.
- Roles (multi-role) with admin bootstrap from env.
- Full work request flow:
  - create queue request,
  - worker/admin take,
  - reject with reason,
  - complete with bot link,
  - fail with reason,
  - AFK close,
  - dodep in $/?,
  - queue refresh,
  - stats updates.
- User-worker bridge dialog + `/stop` by admin.
- Admin panel actions:
  - users list,
  - user search,
  - ban/unban,
  - direct message,
  - role assignment,
  - broadcast,
  - logs view,
  - stats summary,
  - join/work requests list.
- Marketplace base:
  - list items,
  - add item by seller/admin.
- Rental base:
  - add rental account by landlord/admin,
  - request rental,
  - approve/reject,
  - `/guard`, `/guardset` attempts.
- `/c` panel check requests.
- `/o` online checker storage toggle.
- Language setting in `?? ?????????`.

## Notes
- Payment providers (CryptoBot / Telegram Stars) need production credentials and webhook layer; current build contains market data-flow and admin/seller control, ready for provider binding.
