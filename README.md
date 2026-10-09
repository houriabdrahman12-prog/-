# متجر ملابس جزائري — Full-Stack جاهز للنشر

متجر حقيقي (ليس Demo): واجهة زبون Mobile-First بثلاث لغات (العربية افتراضيًا، الفرنسية، الإنجليزية) + لوحة إدارة + API + قاعدة SQLite.
**بلا أي اعتماديات خارجية** (Node.js فقط، لا `npm install`)، الدفع **عند الاستلام فقط** (لا بوابة دفع ولا تطبيق موبايل).

> **حالة الجودة:** `npm run build` ينجح، `npm test` = 72 اختبارًا ناجحًا، واختبار المتصفح الشامل `npm run e2e` ينجح. لكن «جاهز للنشر العلني» يتطلب أيضًا خطوات **الإعداد** أدناه (دومين + HTTPS + أسعار توصيل + مراجعة قانونية). راجع قسم **عوائق ما قبل الإطلاق**.

---
## 1) التشغيل المحلي (للتجربة)
```bash
node -v                                 # يجب أن يكون >= 22.13
cp .env.example .env                    # للتطوير ضع: NODE_ENV=development و BASE_URL=http://localhost:3000
npm run migrate                         # ينشئ قاعدة البيانات + الأدوار + 58 ولاية (آمن ومتكرر)
npm run create-admin                    # يسألك عن البريد وكلمة المرور (12+ حرفًا، حروف وأرقام)
npm run seed:demo                       # (اختياري، تطوير فقط) 4 منتجات [DEMO] + سعر توصيل تجريبي للجزائر العاصمة
npm run dev                             # http://localhost:3000   |  لوحة الإدارة: http://localhost:3000/admin
```
الأوامر: `npm run build` (فحص ثابت + هجرات) • `npm test` • `npm run e2e` (Playwright + Chromium، يحتاج خادمًا يعمل وبيانات seed) • `npm run backup` • `npm run restore -- <مجلد النسخة>`.

## 2) الإعداد الأول بعد أول دخول إلى /admin (إلزامي قبل استقبال الطلبات)
1. **Wilayas & Delivery**: لكل ولاية تخدمها أدخل **سعر التوصيل** و**المدة** و**شركة التوصيل** وفعّلها. لا توجد أسعار افتراضية، والولاية بلا سعر مفعّل **لا تظهر للزبون ولا يمكن الطلب إليها**. يمكنك تطبيق سعر على عدة ولايات دفعة واحدة، وإضافة سعر خاص ببلدية/منطقة.
2. **Settings**: اسم المتجر، الشعار، الهاتف، البريد، Instagram/Facebook/TikTok، **WhatsApp Business Number** (`213XXXXXXXXX`)، حد التوصيل المجاني، الحد الأدنى للطلب، شريط الإعلان، عنوان الصفحة الرئيسية، البانرات الترويجية، وSEO.
3. **Settings > Legal & content pages**: عدّل صفحات الخصوصية والشروط والشحن والإرجاع والاتصال. **النصوص الافتراضية Placeholder وتحتاج مراجعة قانونية قبل النشر.**
4. **Categories / Collections / Products**: أنشئ التصنيفات ثم المنتجات (صور، مقاسات، ألوان، مخزون). **Admin users**: أنشئ بقية الموظفين بدور مناسب.

## 3) النشر على سيرفر (VPS) — الطريقة الموصى بها: Docker + Caddy (HTTPS تلقائي)
المتطلبات: سيرفر Linux (Ubuntu 22.04+)، دومين، Docker + Docker Compose، المنفذان 80 و443 مفتوحان.
```bash
# 1) DNS: اجعل سجلات A/AAAA للدومين (و www) تشير إلى IP السيرفر. انتظر الانتشار.
# 2) انسخ المشروع إلى السيرفر
sudo mkdir -p /opt/shop && sudo chown $USER /opt/shop && cd /opt/shop     # ثم ارفع الملفات هنا (scp/rsync/git)
# 3) الإعداد
cp .env.example .env && chmod 600 .env
nano .env        # عدّل: BASE_URL=https://your-domain.com   TRUST_PROXY=true   (وأنشئ NOTIFY_WEBHOOK_SECRET إن أردت Webhooks)
# 4) تشغيل التطبيق (يُطبّق الهجرات تلقائيًا ويحتفظ بالبيانات في Volume اسمه shop-data)
docker compose up -d --build
docker compose ps && docker compose logs --tail=20 shop       # الحالة: healthy
# 5) أول مدير (تُسأل عن كلمة المرور بشكل تفاعلي)
docker compose exec shop node scripts/create-admin.js
# 6) HTTPS + الدومين عبر Caddy
sudo apt install -y caddy
sudo cp Caddyfile.example /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile     # استبدل your-domain.com
sudo systemctl reload caddy
# 7) تحقق
curl -s https://your-domain.com/health            # {"ok":true}
curl -sI https://your-domain.com | grep -i -E "strict-transport|content-security"
```
افتح `https://your-domain.com/admin` وأكمل **الإعداد الأول** (القسم 2).

### بديل بدون Docker (systemd)
```bash
cd /opt/shop && cp .env.example .env && nano .env      # HOST=127.0.0.1 ، BASE_URL=https://... ، TRUST_PROXY=true
npm run build && npm run migrate && node scripts/create-admin.js
sudo cp deploy/shop.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now shop
```
ثم Caddy كما في الخطوة 6. الخادم **يرفض الإقلاع** في Production إذا لم يكن `BASE_URL` بصيغة `https://` أو كانت الكوكيز غير Secure.

## 4) التخزين الدائم للصور وقاعدة البيانات
قاعدة البيانات (`DATABASE_PATH`) والصور (`UPLOAD_DIR`) والنسخ الاحتياطية (`BACKUP_DIR`) كلها داخل مجلد `data/` — في Docker هو Volume `shop-data` (لا يضيع عند إعادة البناء/التشغيل). **لا تنشر على منصة ذات قرص مؤقت (Heroku/Render المجاني…)** إلا مع قرص دائم؛ هذا المتجر يخزّن الصور محليًا (بدون S3).

## 5) النسخ الاحتياطي والاستعادة
```bash
npm run backup                                  # Docker: docker compose exec shop node scripts/backup.js
# ينتج data/backups/<وقت>/{store.db, uploads/, manifest.json(sha256 + integrity_check)} — نسخة متسقة حتى والمتجر يعمل
crontab deploy/backup.cron                      # نسخ يومي 03:30. انسخ المجلد خارج السيرفر دائمًا (rclone/rsync/scp)
# الاستعادة (أوقف التطبيق أولًا):
docker compose stop shop
docker compose run --rm shop node scripts/restore.js data/backups/<وقت>     # يتحقق من الـchecksum ويحفظ DB الحالية باسم store.db.before-restore-*
docker compose start shop
```
لا تُحذف النسخ القديمة تلقائيًا إلا إذا ضبطت `BACKUP_KEEP=N`.

## 6) تحديث التطبيق بأمان
```bash
npm run backup                                  # 1) نسخة قبل أي تحديث
# 2) ارفع الكود الجديد (احتفظ بـ .env و data/)
docker compose up -d --build                    # 3) الهجرات تُطبّق تلقائيًا (للأمام فقط، غير مدمّرة)
curl -s https://your-domain.com/health && npm test   # 4) تحقق (npm test على جهازك/CI قبل الرفع)
# للتراجع: docker compose down && استعادة النسخة (القسم 5) والكود السابق
```

## 7) المتغيرات (`.env.example` يشرح كل متغير)
`NODE_ENV` `PORT` `HOST` `BASE_URL`★ `TRUST_PROXY` `DATABASE_PATH` `UPLOAD_DIR` `BACKUP_DIR` `BACKUP_KEEP` `ADMIN_SESSION_HOURS` `CUSTOMER_SESSION_DAYS` `MAX_UPLOAD_MB` `ALLOWED_ORIGINS` `RATE_LIMITS` `NOTIFY_WEBHOOK_SECRET` `LOG_LEVEL` (+ `ADMIN_EMAIL/ADMIN_PASSWORD` لأمر create-admin غير التفاعلي فقط). ★ إلزامي في Production. لا توجد أسرار في الكود أو Git.

## 8) البنية
```
server/   index, config(+guard), db(schema+migrations), http(router, headers, CSRF, rate-limit), security, validate, seo
  routes/ public, account, admin        services/ orders, catalog, stats, uploads, common
scripts/  migrate, create-admin, seed-demo, backup, restore, lint (build)
public/   index.html + js/{app,i18n}.js + css/   |   admin/ (لوحة الإدارة)      deploy/ systemd + cron
test/ (72 اختبارًا)   e2e/ui-smoke.py   Dockerfile  docker-compose.yml  Caddyfile.example  .env.example
```

## 9) الأمان المطبّق (ومُختبَر)
scrypt (N=32768) • جلسات 256-bit تُخزَّن مجزّأة SHA-256 • كوكيز `HttpOnly; SameSite=Strict; Secure` • CSRF token + فحص Origin • قفل الحساب بعد 5 محاولات + Rate limiting قابل للضبط (دخول، تسجيل، طلبات، مراجعات، رفع، تصدير، استعادة كلمة المرور) • RBAC على السيرفر لكل endpoint (6 أدوار) • منع IDOR/BOLA • Parameterized SQL فقط (`npm run build` يفحص ذلك) • Escaping لكل مخرجات الواجهة + CSP `script-src 'self'` بلا inline JS • لا CORS (same-origin فقط) • رفع الصور بفحص magic bytes والحجم وأسماء عشوائية وتقديمها بـ nosniff + CSP sandbox (لا SVG) • حماية CSV Formula injection • منع Path traversal • Mass-assignment محجوب • الأخطاء بلا Stack traces • Audit logs • الخادم يرفض الإقلاع بإعداد Production غير آمن • لا Admin افتراضي ولا رقم WhatsApp ولا أسعار توصيل افتراضية.

## 10) عوائق ما قبل الإطلاق العلني (يجب عليك)
1. **دومين + HTTPS** (القسم 3) و`BASE_URL` الصحيح — بدونهما لن يعمل الخادم في Production.
2. **أسعار التوصيل**: بدونها لا يستطيع أي زبون إتمام طلب.
3. **مراجعة قانونية** للصفحات القانونية (Placeholder) — لا يمكنني تقديم استشارة قانونية.
4. **نسخ احتياطي خارج السيرفر** (cron + نسخ off-site) — ملف SQLite واحد على قرص واحد.
5. أضف صور المنتجات الحقيقية (لا توجد صور افتراضية)، وأدخل رقم WhatsApp.

## 11) حدود معروفة
SQLite لخادم واحد (للتوسع الأفقي انتقل إلى PostgreSQL) • Rate limiter في الذاكرة (ضع Cloudflare/nginx أمامه لحماية أقوى من DDoS) • لا بوابة دفع (COD فقط) • لا Email/SMS مباشر (استخدم الـWebhook الموقّع مع n8n/Zapier/بوابة SMS) • حسابات الزبائن بلا OTP: لذلك استعادة كلمة المرور تتم عبر رابط يرسله Webhook أو يُصدره الأدمن من لوحة الإدارة، ولا تُربط طلبات الضيف القديمة بالحساب الجديد • محتوى المنتجات بلغة واحدة (واجهة المتجر ثلاثية اللغات) • لوحة الإدارة بالإنجليزية فقط • البلديات: حقل نصي مع أسعار خاصة بالبلدية/المنطقة (لا قائمة 1541 بلدية) • ترتيب المنتجات يدوي غير مدعوم (الترتيب: الأحدث/السعر/الأكثر مبيعًا) • `style-src 'unsafe-inline'` (السكربتات صارمة) • لم يُجرَّب تحت حمل ضخم ولا على Windows/macOS.
