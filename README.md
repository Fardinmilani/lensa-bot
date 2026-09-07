# lensa-signal-bot

ربات تلگرامی رایگان روی Cloudflare Workers + D1 + Workflows، بخش سیگنال‌دهی و مدیریتی lensa-crypto-dashboard. کامل — طبق مشخصاتی که دادی، هیچ بخشی جا نمونده.

## چیکار می‌کنه

1. از منوی دکمه‌ای «سیگنال جدید» → رمزارز، تایم‌فریم، لورج، حد ضرر، حد سود و تعداد روزهای بک‌تست انتخاب می‌شن
2. یه Cloudflare Workflow همه‌ی ~۲۰ استراتژی رو (هرکدوم توی step جدای خودش، به‌خاطر سقف ۱۰ms CPU پلن رایگان) روی کندل‌های واقعی KuCoin فیت می‌کنه؛ CoinGecko هم fallback قطعی مسیرهای مسدود/خراب است
3. استراتژی‌ای که هم بازدهیش مثبته هم بیشترین رو انتخاب می‌کنه (اگه هیچ‌کدوم مثبت نبود، سیگنالی صادر نمی‌شه)
4. با همون استراتژی، وضعیت الان (long/short/flat) رو تصمیم می‌گیره و به کاربر می‌گه، با دکمه‌ی «جزئیات بیشتر» برای آمار کامل (Sharpe، Sortino، Max Drawdown، Profit Factor، ...)
5. سیگنال با entry/SL/TP توی D1 ذخیره می‌شه
6. هر ۱۰ دقیقه یه Cron چک می‌کنه سیگنال‌های باز به تارگت خوردن یا استاپ، نتیجه رو ذخیره و به کاربر اطلاع می‌ده
7. `/stats` (ادمین) — تعداد کل، باز/تارگت‌خورده/استاپ‌خورده، نرخ برد کلی و به‌تفکیک استراتژی. جای داشبورد جدا، همونطور که گفتی لازم نبود حتماً باشه.

سیستم ادمین و پلن هم از فاز ۱ سرجاشه (پلن‌ها فقط *مصرف* رو محدود می‌کنن، نه کیفیت تحلیل رو).

## فرض طراحی

بات برای چت خصوصی (هر کاربر با بات، یک‌به‌یک) طراحی شده، نه گروه — rate limit و ردیابی سیگنال‌ها بر اساس user id هستن.

## راه‌اندازی (دیپلوی از صفر)

```bash
npm install
```

**۱. دیتابیس D1:**
```bash
npx wrangler d1 create lensa-signal-bot-db
```
`database_id` برگشتی رو توی `wrangler.toml` جای `REPLACE_WITH_D1_DATABASE_ID` بذار.

**۲. اجرای schema:**
```bash
npm run db:migrate:remote
```
> اگه از قبل schema فاز ۱ رو روی یه D1 واقعی اجرا کرده بودی، یه بار دستی هم این رو بزن (چون CREATE TABLE IF NOT EXISTS به جدول موجود ستون اضافه نمی‌کنه):
> `npx wrangler d1 execute lensa-signal-bot-db --remote --command "ALTER TABLE signals ADD COLUMN backtest_detail_json TEXT;"`

**۳. بات تلگرام:** با [@BotFather](https://t.me/BotFather) بسازش و توکن رو بگیر.

**۴. آیدی عددیت:** از [@userinfobot](https://t.me/userinfobot) — جای `REPLACE_WITH_YOUR_TELEGRAM_USER_ID` (`OWNER_TELEGRAM_ID`) توی `wrangler.toml` بذار. اولین پیامت به بات، خودکار ادمینت می‌کنه.

**۵. secretها:**
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # یه رشته‌ی رندوم، مثلاً: openssl rand -hex 24
```

**۶. دیپلوی:**
```bash
npm run deploy
```

**۷. ثبت webhook** (یه بار):
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://lensa-signal-bot.<subdomain>.workers.dev", "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"}'
```

**۸. تست:** `/start` بزن (ادمین می‌شی) و از منوی دکمه‌ای «سیگنال جدید» رو انتخاب کن.

## دستورها

| دستور | دسترسی | کار |
|---|---|---|
| `/start` | همه | ثبت‌نام |
| `/signal` | همه (با rate limit پلن) | ویزارد سیگنال جدید |
| `/cancel` | همه | لغو ویزارد در حال انجام |
| `/myplan` | همه | پلن فعلی + مصرف امروز |
| `/plans` | همه | لیست پلن‌ها |
| `/addadmin ID [username]` | ادمین | افزودن ادمین |
| `/removeadmin ID` | ادمین | حذف ادمین |
| `/listadmins` | ادمین | لیست ادمین‌ها |
| `/setplan ID PLAN_NAME` | ادمین | تغییر پلن کاربر |
| `/stats` | ادمین | آمار کلی سیگنال‌ها + نرخ برد |

## تست

```bash
npm test
```
تست‌ها schema، منطق D1 (rate limit، پلن، ادمین)، parsing و fallback داده‌ی KuCoin/CoinGecko، منو و ویزارد دکمه‌ای، تشخیص TP/SL برای long و short، و کل Workflow فیت‌و‌تصمیم را end-to-end پوشش می‌دهند.

## منبع داده‌ی بازار

مسیر اصلی API عمومی KuCoin است. درخواست‌های کندل به‌صورت صفحه‌بندی‌شده انجام می‌شوند تا بازه‌های طولانی مثل ۳۶۵ روز هم کامل دریافت شوند. اگر مسیر اصلی با 403/429/451، خطای سرور یا پاسخ غیر JSON روبه‌رو شود، ربات خودکار سراغ CoinGecko می‌رود و پیام HTML را به‌عنوان JSON parse نمی‌کند.

## ساختار

```
src/
  index.js                  webhook + مسیریابی پیام/دکمه‌ها + اسکلت اجرای cron
  telegram.js                 sendMessage / answerCallbackQuery / verifyWebhookSecret
  db.js                       همه‌ی کوئری‌های D1
  marketData.js                کندل و قیمت لحظه‌ای از KuCoin با fallback خودکار CoinGecko
  signalFormat.js               فرمت پیام‌های سیگنال/جزئیات/نتیجه
  commands/                    هندلر هر دستور (شامل ویزارد /signal)
  cron/checkOpenSignals.js      چک TP/SL هر ۱۰ دقیقه، batched
  workflows/signalFitWorkflow.js  فیت هر استراتژی در step جدا + تصمیم + ذخیره + اطلاع‌رسانی
  lib/                          وندور شده از lensa-crypto-dashboard (backtest.js, strategies.js, forecast.js, risk.js) -- دست نزن، از داشبورد sync کن
  lib/singleStrategyFit.js      نسخه‌ی تک‌استراتژی runAllStrategies (برای هر step)، تست‌شده که دقیقاً با نسخه‌ی همه‌باهم یکی باشه
test/
  d1-shim.mjs, cloudflare-workers-shim.mjs, register-loader.mjs   شبیه‌سازی D1 و Workflows روی Node ساده برای تست بدون نیاز به دیپلوی
```
