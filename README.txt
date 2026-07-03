ENGLISH Mock PLATFORM v10.5

POSTGRESQL TO‘LIQ ULANGAN VERSIYA
- Backend endi real ma’lumotlarni PostgreSQL jadvallarida saqlaydi.
- db.json faqat birinchi import/seed uchun ishlatiladi, ish jarayonida fallback sifatida ishlatilmaydi.
- Jadval strukturalari: app_users, app_progress, app_certificates, app_enrollments, app_meta.
- Parollar bcrypt bilan hash qilinadi.
- Login JWT + single-device session control bilan ishlaydi.
- Ishga tushirishdan oldin backend/.env ichida DATABASE_URL yozilishi shart.

POSTGRESQLNI ISHGA TAYYORLASH:
1) PostgreSQLda al_aziz_language database yarating.
2) backend/.env ichida yozing:
   DATABASE_URL=postgresql://postgres:SIZNING_PAROL@localhost:5432/al_aziz_language
3) backend papkasida:
   npm install
   npm run db:migrate
   npm run dev
4) http://localhost:5000/api/health oching. postgresConnected true bo‘lsa ulanish to‘g‘ri.


Bu versiya butunlay yangi mantiqqa o‘zgartirildi:
- Kirishda 2 ta asosiy tugma bor: Login va Kursga yozilish.
- Kursga yozilish bosilganda foydalanuvchi ism familya, tug‘ilgan yil/oy/kun, fan, telefon raqam va Telegram username kiritadi.
- Yuborilgan arizalar admin panelga tushadi.
- Admin paneldan admin yaratish va foydalanuvchi yaratish mumkin.
- Foydalanuvchiga login, parol, fan, active/non-active holat va account tugash sanasi beriladi.
- Yaratilgan vaqt avtomatik qo‘yiladi.
- Tugash vaqti o‘tsa account avtomatik non-active bo‘ladi.
- Admin keyin accountni yana active/non-active qila oladi va muddatini o‘zgartira oladi.
- Login qilinganda faqat foydalanuvchiga biriktirilgan fan chiqadi.
- Fanlar: Ingliz tili, Rus tili, Koreys tili, Ona tili, Tarix.
- Darajalar: A1, A2, B1, B2.
- A1 ochiq turadi, A2/B1/B2 yopiq turadi.
- Yuqori darajani ochish uchun ruxsat testidan 80%+ olish kerak.
- Har bir darajada 15 ta mavzu bor.
- Har bir mavzu ichiga kirilganda mavzu tushuntirish sahifasi yangi dizaynda ochiladi.
- Mavzu sahifasida ketma-ket cardlar chiqariladi. Vocabulary va mikrofon/AI speaking tekshiruvi faqat til fanlarida qoldirildi; Ona tili va Tarixda olib tashlandi.
- Har bir mavzuda chuqur tushuntirish, grammatik tuzilma, ishlatilishi, nozik farqlari, ko‘p uchraydigan xatolar, eslab qolish formulasi va ko‘proq misollar bor.
- Tushuntirishdan keyin foydalanuvchi “Mashq bajarish” tugmasini bosadi.
- Til fanlarida mashq 2 bosqichdan iborat: 5 ta tanlash mashqi + 5 ta yozma javob/tarjima mashqi. Ona tili va Tarixda faqat 5 ta tanlash mashqi bor.
- Umumiy natija 80%+ bo‘lsa keyingi mavzu ochiladi; past bo‘lsa qayta tayyorlanish kerak.
- Dizayn telefonga moslashtirilgan va Duolingo uslubida qilingan.

DEMO LOGINLAR:
Super admin: admin / admin123
English foydalanuvchi: student / student123
Rus foydalanuvchi: russtudent / student123
Koreys foydalanuvchi: korstudent / student123
Ona tili foydalanuvchi: onastudent / student123
Tarix foydalanuvchi: tarixstudent / student123

1) BACKENDNI ISHGA TUSHIRISH
PowerShell:
cd C:\Users\User\Desktop\english-mock-platform-v10-topic-tests\backend
npm install
npm run dev

Backend:
http://localhost:5000

2) FRONTENDNI ISHGA TUSHIRISH
Yangi PowerShell oynasi:
cd C:\Users\User\Desktop\english-mock-platform-v10-topic-tests\frontend
npm install
npm run dev

Frontend:
http://127.0.0.1:5173

OSON YO‘L:
1) START_BACKEND.bat ni bosing.
2) START_FRONTEND.bat ni bosing.
3) Brauzerda http://127.0.0.1:5173 ni oching.

NETLIFY/RAILWAY UCHUN:
Frontend .env faylida backend URL qo‘yiladi:
VITE_API_URL=https://sizning-backend-url.up.railway.app

Backend .env faylida frontend URL qo‘yiladi:
PORT=5000
CLIENT_URL=http://127.0.0.1:5173,https://sizning-netlify-saytingiz.netlify.app

MUHIM:
- npm install backend papkasida alohida qilinadi.
- npm install frontend papkasida alohida qilinadi.
- Frontend va backend ikkita alohida terminalda ishlaydi.


TALAFFUZ TEKSHIRISH HAQIDA:
- Bu funksiya brauzerning Web Speech API imkoniyatidan foydalanadi.
- Eng yaxshi ishlashi uchun Google Chrome yoki Microsoft Edge ishlating.
- Mikrofon so‘raganda Allow/Ruxsat berish tugmasini bosing.
- Telefon va kompyuterda mikrofon ruxsati yopiq bo‘lsa, tekshiruv ishlamaydi.
- Internet talab qilinishi mumkin, chunki ayrim brauzerlarda speech recognition server orqali ishlaydi.


YANGI O‘ZGARISHLAR:
- Landing page va umumiy UI presentatsiya dizayniga yaqinlashtirildi.
- Vocabulary / speaking bo‘limi til fanlari uchun ixtiyoriy qilindi.
- Hohlagan so‘zni yozib, platformaga talaffuz qildirish va mikrofon bilan tekshirish qo‘shildi.
- Speaking qilmasa ham foydalanuvchi keyingi test bo‘limiga o‘ta oladi.


2026-05-08 yangilanish:
- Bosh sahifadagi o‘ng tomondagi telefon kattalashtirildi.
- O‘ng tomonda endi faqat bitta telefon qoldirildi.
- Ortiqcha dekor elementlar olib tashlandi.
- Login va kursga yozilish telefon ichida ko‘rinadigan qilindi.

2026-05-08 qo‘shimcha yangilanish:
- Mavzu tushuntirishlari sayt ishlatish bo‘yicha emas, aynan tanlangan mavzuning ma’nosi, grammatik tuzilmasi, ishlatilishi, nozik farqlari va ko‘p uchraydigan xatolari bo‘yicha qayta yozildi.
- Har bir mavzuda vocabulary endi umumiy teacher/student so‘zlari emas, mavzuga mos termin va tushunchalardan tuziladi.
- Mavzu testlari endi mavzuga mos savollar, to‘ldirish, to‘g‘ri gapni tanlash, asosiy qoida va terminlarni aniqlash savollaridan iborat.
- Kirish testi va yakuniy testlar ham tegishli daraja mavzularidagi savollardan avtomatik tuziladigan qilindi.
- Backend .env faylida OPENAI_API_KEY bo‘sh qoldirildi. AI feedback kerak bo‘lsa, o‘zingizning kalitingizni yozing; bo‘lmasa tizim oddiy feedback bilan ishlaydi.


2026-05-09 dizayn yangilanishi:
- O‘quvchi kurs panelidagi mavzular grid/card ko‘rinishidan olib tashlandi.
- Darslar endi tagma-tag uzun horizontal ro‘yxat ko‘rinishida chiqadi.
- Har bir mavzu yonida yashil aylana progress ring qo‘shildi.
- Progress ring ichida o‘sha mavzuda olingan foiz bal ko‘rinadi.
- Mavzular “O‘zlashtirilgan darslar” va “Keyingi darslar” bo‘limlariga ajratildi.
- O‘quvchi paneli chap sidebar + asosiy darslar maydoni ko‘rinishida zamonaviy dashboard dizayniga o‘tkazildi.


2026-05-09 v10.2 mavzu ichki sahifa yangilanishi:
- Har bir mavzuga kirilganda “Mavzu tushuntirish” sahifasi yangi yashil/oq card dizaynida ochiladi.
- Keraksiz katta vocabulary/speaking paneli olib tashlandi.
- Tushuntirish bloklari chuqurlashtirildi: asosiy ma’no, grammatik tuzilma, qachon ishlatilishi, nozik farqlar, xatolar, ijobiy/inkor/savol shakli va eslab qolish formulasi.
- Misollar soni ko‘paytirildi va alohida “Ko‘proq misollar” blokida chiqarildi.
- Pastki qismda faqat “Mavzularga qaytish” va “5 ta mavzu testiga o‘tish” tugmalari qoldirildi.

v10.5 update:
- Student paneldagi Statistika bo'limi yangilandi.
- Statistika ichida mavzular foiz bo'yicha tartiblanadi.
- Eng sust o'zlashtirilgan / 80% dan past mavzular yuqorida chiqadi.
- Har bir mavzu yonida foiz progress, urinishlar soni va status ko'rsatiladi.


YANGI: Mavzu testlari 2 qismga bo‘lindi:
1) 5 ta tanlash testi — faqat mavzuga mos gap, tarjima va vocabulary asosida.
2) Tarjima/gap tuzish testi — o‘quvchi inglizcha yoki o‘zbekcha gapni yozadi, backend AI/fallback tekshiruv bilan foiz beradi.

2026-05-09 v10.9 mashq tartibi yangilanishi:
- Mavzu ichida endi “1-test” va “2-test” deb alohida ko‘rinmaydi.
- Bitta “Mashq bajarish” tugmasi bor.
- Tugma bosilganda avval 5 ta tanlash mashqi, undan keyin ketma-ket gap tuzish/tarjima mashqi chiqadi.
- Tanlash mashqi va yozma mashq natijalari birlashtirilib umumiy foiz hisoblanadi.
- Umumiy natija 80% yoki undan yuqori bo‘lsa keyingi mavzu ochiladi.


V10.3 QO‘SHILGANLAR:
- Ona tili va Tarix fanlari qo‘shildi.
- Bu fanlarda ham A1/A2/B1/B2 darajalari, 15 tadan mavzu, ketma-ket ochilish, mashq bajarish va statistika ishlaydi.
- Ona tili va Tarix mavzularida yozma javob, vocabulary va speaking bo‘limlari olib tashlandi; mashq faqat 5 ta tanlash savolidan iborat.
- Har bir fan bo‘yicha yakuniy testdan 90%+ olinsa sertifikat beriladi.
- Demo loginlar qo‘shildi: onastudent / student123 va tarixstudent / student123.


2026-05-09 v10.4 Ona tili/Tarix tozalandi:
- Ona tili va Tarix fanlarida Vocabulary bo‘limi olib tashlandi.
- Ona tili va Tarix fanlarida Speaking: talaffuz tekshiruvi chiqmaydi.
- Ona tili va Tarix fanlarida Yozma mashq chiqmaydi.
- Bu fanlarda mavzuni o‘qib bo‘lgach, faqat 5 ta tanlash mashqi bajariladi.


YANGI: Ingliz tili mavzularida YouTube video dars
- English fanidagi har bir mavzu ichida bitta YouTube video dars bloki chiqadi.
- Video tushuntirishdan oldin ko‘rinadi va mavzuga mos tanlangan.
- Ona tili va Tarix fanlarida video/vocabulary/speaking chiqmaydi, ularda faqat mavzu tushuntirish va 5 ta tanlash mashqi qoladi.

2026-05-09 production tayyorlash yangilanishi:
- Backend PostgreSQL bilan ishlashga tayyorlandi. DATABASE_URL yozilsa ma'lumotlar PostgreSQL app_state JSONB jadvalida saqlanadi.
- Lokal test uchun DATABASE_URL bo'sh bo'lsa, eski db.json fallback sifatida ishlaydi.
- Parollar endi oddiy text emas, bcrypt hash ko'rinishida saqlanadi.
- Eski db.json ichidagi plain passwordlar backend birinchi ishga tushganda avtomatik hash qilinadi.
- Auth JWT token asosiga o'tkazildi.
- Session control qo'shildi: bir account faqat oxirgi login qilingan bitta qurilmada ishlaydi.
- Admin parol o'zgartirsa yoki foydalanuvchini non-active qilsa, eski session yopiladi.
- Sertifikat PDF yuklash va QR verification oldingidek ishlaydi: QR skaner qilinsa /certificate/:code sahifasiga kiradi.

POSTGRESQL ULASH:
1) backend/.env.example faylini backend/.env qilib nusxa oling.
2) DATABASE_URL yozing.
3) backend papkasida npm install qiling.
4) Mavjud db.json ni PostgreSQLga ko'chirish uchun: npm run migrate
5) npm run dev qiling.
6) /api/health ichida database: "postgresql" chiqsa ulanish ishlagan bo'ladi.


2026-05-09 xavfsizlik va barqarorlik yangilanishi:
- Admin panel qotmasligi uchun accountlar va sertifikatlar server-side pagination bilan yuklanadi.
- Account qidirish, status filter va sertifikat filterlari backendda bajariladi.
- Login/admin/certificate route uchun rate limit qo'shildi.
- Security headerlar qo'shildi va x-powered-by o'chirildi.
- Admin hisobotlari serverda hisoblanadi: jami o'quvchi, active/non-active, progress, urinishlar, past mavzular, muddati tugayotgan accountlar.
- .env fayl zip ichidan olib tashlanadi; real parollar faqat lokal backend/.env ichida qolishi kerak.
- Batafsil tekshiruv: SECURITY_CHECKLIST.txt
