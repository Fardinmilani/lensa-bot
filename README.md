# lensa-signal-bot

لایه‌ی عملیاتی تلگرام برای Lensa روی Cloudflare Workers + D1 + Workflows؛ شامل تحلیل، فیت و انتخاب استراتژی، سیگنال، مدیریت ریسک و پیگیری خودکار.

## چیکار می‌کنه

1. تمام جریان‌های اصلی از منوی دکمه‌ای اجرا می‌شوند؛ پیام ویزارد در هر مرحله ویرایش می‌شود تا چت شلوغ نشود.
2. کاربر Spot/Futures، جهت، لورج اختیاری، تایم‌فریم، تعداد روز، کارمزد، زمان Fill، روش حدها و تنظیمات حجم را مشخص می‌کند.
3. Workflow همه‌ی ۲۰ استراتژی را پارامتری فیت می‌کند، Walk-Forward می‌گیرد و آمار کامل هرکدام را در چند پیام خوانا نشان می‌دهد.
4. کاربر معیار رتبه‌بندی (بازده، Sharpe، نرخ برد، افت یا Profit Factor) و سپس خود استراتژی را انتخاب می‌کند؛ انتخاب خودکار و پنهانی وجود ندارد.
5. وضعیت زنده‌ی همان استراتژی بررسی می‌شود و فقط در Long/Short بودن، سیگنال با جزئیات کامل صادر می‌شود؛ Flat شفاف اعلام می‌شود.
6. SL/TP در Futures بر اساس ROI پوزیشن به حرکت قیمت تبدیل می‌شوند؛ مثلاً SL ده درصد با 10x یعنی تقریباً یک درصد حرکت قیمت. حجم هم به سقف واقعی حساب × لورج محدود می‌شود.
7. کنترل کیفیت کندل، بازار، Decision Center، Forecast، Backtest، ابزارهای ریسک، Watchlist، اسکن، هشدار قیمت، ژورنال و تاریخچه در ربات در دسترس‌اند.
8. هر ۱۰ دقیقه Cron هم سیگنال‌های باز و هم هشدارهای عبور قیمت را بررسی و نتیجه را به کاربر اعلام می‌کند.
9. پنل ادمین کاملاً دکمه‌ای است؛ فقط `OWNER_TELEGRAM_ID` می‌تواند ادمین اضافه/حذف کند و افزودن دستی آیدی حتی وقتی هنوز کاربر شناخته‌شده‌ای وجود ندارد کار می‌کند.

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

فیت پارامتری همه‌ی استراتژی‌ها، به‌خصوص استراتژی Monte Carlo، از سقف CPU ده میلی‌ثانیه‌ای Workers Free بیشتر است. برای اجرای قابل‌اعتماد این نسخه از Workers Paid استفاده کن (پیش‌فرض هر invocation برابر ۳۰ ثانیه است).

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
| `/market`، `/decision` | همه | بازار و مرکز تصمیم |
| `/forecast`، `/backtest`، `/risk` | همه | ابزارهای تحلیلی کامل |
| `/automation` | همه | Watchlist، هشدار، ژورنال و تاریخچه |
| `/news` | همه | منابع زنده‌ی خبر بازار |
| `/cancel` | همه | لغو ویزارد در حال انجام |
| `/myplan` | همه | پلن فعلی + مصرف امروز |
| `/plans` | همه | لیست پلن‌ها |
| `/addadmin ID [username]` | فقط مالک اصلی | افزودن ادمین |
| `/removeadmin ID` | فقط مالک اصلی | حذف ادمین؛ مالک اصلی قابل حذف نیست |
| `/listadmins` | ادمین | لیست ادمین‌ها |
| `/setplan ID PLAN_NAME` | ادمین | تغییر پلن کاربر |
| `/stats` | ادمین | آمار کلی سیگنال‌ها + نرخ برد |

## تست

```bash
npm test
```
تست‌ها schema، D1، امنیت دسترسی، پلن و ادمین، زنجیره‌ی داده، کیفیت کندل، منو و ویزارد، محاسبه‌ی لورج و حجم، هشدارها، تشخیص TP/SL و Workflow فیت‌و‌تصمیم را پوشش می‌دهند.

## منبع داده‌ی بازار

مسیر اصلی API عمومی KuCoin است. درخواست‌های کندل صفحه‌بندی می‌شوند تا بازه‌های طولانی کامل دریافت شوند. در 403/429/451، خطای سرور یا پاسخ HTML، مسیر دوم Bitget با OHLCV واقعی و صفحه‌بندی فعال می‌شود؛ CoinGecko fallback سوم است. قبل از هر تحلیل، ترتیب زمانی، OHLC، شکاف‌ها و تازگی داده امتیازدهی می‌شوند.

## ساختار

```
src/
  index.js                  webhook + مسیریابی پیام/دکمه‌ها + اسکلت اجرای cron
  telegram.js                 sendMessage / answerCallbackQuery / verifyWebhookSecret
  db.js                       همه‌ی کوئری‌های D1
  marketData.js                کندل و قیمت لحظه‌ای با KuCoin → Bitget → CoinGecko
  dataQuality.js               اعتبارسنجی و امتیاز کیفیت کندل‌ها
  signalFormat.js               فرمت پیام‌های سیگنال/جزئیات/نتیجه
  commands/                    ویزارد سیگنال، تحلیل، اتوماسیون، خبر و ادمین
  cron/                         چک TP/SL و هشدارهای قیمت هر ۱۰ دقیقه
  workflows/signalFitWorkflow.js  فیت هر استراتژی در step جدا + تصمیم + ذخیره + اطلاع‌رسانی
  lib/                          وندور شده از lensa-crypto-dashboard (backtest.js, strategies.js, forecast.js, risk.js) -- دست نزن، از داشبورد sync کن
  lib/singleStrategyFit.js      نسخه‌ی تک‌استراتژی runAllStrategies (برای هر step)، تست‌شده که دقیقاً با نسخه‌ی همه‌باهم یکی باشه
test/
  d1-shim.mjs, cloudflare-workers-shim.mjs, register-loader.mjs   شبیه‌سازی D1 و Workflows روی Node ساده برای تست بدون نیاز به دیپلوی
```
