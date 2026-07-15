# Poko Member Bot — Meta WhatsApp Cloud API Official

Bot WhatsApp gamifikasi member + website publik testimoni yang memakai **WhatsApp Cloud API resmi dari Meta**, bukan Baileys/WhatsApp Web.

Fitur inti:

- Member daftar akun lewat WhatsApp: `.akun username password`
- Member kirim testimoni gambar/video lewat WhatsApp dengan caption `.testimoni ...`
- Media testimoni disimpan ke Cloudflare R2
- Data member, testimoni, poin, XP, voucher, dan redeem disimpan ke Neon PostgreSQL atau local fallback
- Website publik EJS: `/`, `/search`, `/@username`
- Webhook official Meta: `/webhook`
- Tanpa pairing code, tanpa QR, tanpa session WhatsApp Web

## Perbedaan penting dari versi Baileys

Versi ini **tidak login WhatsApp dari web/console**. Nomor harus sudah terhubung sebagai nomor WhatsApp Business Platform / Cloud API di Meta. Pesan masuk dikirim Meta ke server melalui webhook, lalu bot membalas melalui Graph API.

Karena memakai API resmi:

- Tidak ada folder `session/`
- Tidak ada pairing code
- Tidak ada QR scan
- Tidak support command grup WhatsApp seperti bot Baileys
- Pesan bebas biasanya hanya bisa dikirim dalam customer service window; di luar window perlu template message

## Struktur project

```txt
main.js
src/
├─ handler.js       # command member/testimoni
├─ meta.js          # client WhatsApp Cloud API + webhook parser
├─ web.js           # Express routes + webhook
├─ db.js            # logic member/testimoni/gamification
├─ persistence.js   # Neon/local persistence
├─ storage.js       # R2/local media storage
├─ rewards.js
└─ utils.js
views/
├─ pages/
│  ├─ home.ejs
│  ├─ search.ejs
│  ├─ profile.ejs
│  ├─ not-found.ejs
│  └─ meta-setup.ejs
└─ partials/
public/styles.css
```

## 1. Install

```bash
npm install
```

## 2. Buat `.env`

```bash
cp .env.example .env
```

Windows CMD:

```cmd
copy .env.example .env
```

Isi minimal:

```env
PUBLIC_BASE_URL=https://yogami.onrender.com
PORT=10000
OWNER_NUMBER=628xxxxxxxxxx

GRAPH_API_VERSION=v25.0
WHATSAPP_ACCESS_TOKEN=EAAGxxxxxxxxxxxxxxxxxxxx
WHATSAPP_PHONE_NUMBER_ID=123456789012345
WHATSAPP_BUSINESS_ACCOUNT_ID=123456789012345
WHATSAPP_VERIFY_TOKEN=buat_token_random_sendiri_misal_poko_webhook_2026
WHATSAPP_WEBHOOK_PATH=/webhook
META_APP_SECRET=isi_app_secret_meta

DB_PROVIDER=neon
DATABASE_URL=postgresql://user:password@host-pooler.region.aws.neon.tech/neondb?sslmode=require
DB_STATE_KEY=main

STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=isi_account_id_cloudflare
R2_ACCESS_KEY_ID=isi_access_key_id_r2
R2_SECRET_ACCESS_KEY=isi_secret_access_key_r2
R2_BUCKET=poko-testimoni
R2_PUBLIC_BASE_URL=https://media.domainkamu.com
R2_UPLOAD_PREFIX=testimonials
```

## 3. Jalankan lokal

```bash
npm start
```

Untuk cek syntax:

```bash
npm run check
```

## 4. Setup webhook di Meta

Di Meta Developer Dashboard:

1. Buka app kamu.
2. Masuk ke **WhatsApp > Configuration**.
3. Pada bagian webhook, isi Callback URL:

```txt
https://yogami.onrender.com/webhook
```

4. Isi Verify Token sama persis dengan env:

```txt
WHATSAPP_VERIFY_TOKEN
```

5. Klik Verify and Save.
6. Subscribe field **messages**.

Kalau callback URL diverifikasi, Meta akan memanggil `GET /webhook` dengan `hub.challenge`; server ini akan membalas challenge jika verify token cocok.

## 5. Setup token Meta

Untuk development, token sementara dari Meta bisa dipakai dulu. Untuk production, sebaiknya gunakan system user token/permanent token dengan permission yang sesuai untuk WhatsApp Business Platform.

Env yang dibutuhkan:

```env
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
```

`WHATSAPP_PHONE_NUMBER_ID` adalah ID nomor dari WhatsApp Cloud API, bukan nomor HP biasa.

## 6. Setup Cloudflare R2

Buat bucket, misalnya:

```txt
poko-testimoni
```

Buat R2 API token dengan akses Object Read & Write, lalu isi:

```env
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=poko-testimoni
R2_PUBLIC_BASE_URL=https://media.domainkamu.com
```

`R2_PUBLIC_BASE_URL` harus URL publik bucket, bisa custom domain atau public `r2.dev` URL.

## 7. Setup Neon

Buat database Neon, lalu copy pooled connection string:

```env
DB_PROVIDER=neon
DATABASE_URL=postgresql://user:password@host-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Project ini memakai JSONB state supaya migrasi dari local JSON ke Neon cepat dan command lama tetap jalan. Kalau traffic sudah besar, struktur bisa di-upgrade ke tabel relational terpisah.

## 8. Cara pakai via WhatsApp

Buat akun testimoni:

```txt
.akun poko rahasia123
```

Kirim foto/video dengan caption:

```txt
.testimoni testimoni thalassemia, pelayanannya membantu dan responsnya cepat
```

Lihat link profil:

```txt
.link
```

Profil publik:

```txt
https://yogami.onrender.com/@poko
```

Cari testimoni:

```txt
https://yogami.onrender.com/search?q=testimoni%20thalassemia
```

## 9. Command yang tersedia

Member:

```txt
.menu
.akun username password
.testimoni teks testimoni  # caption foto/video
.link
.daftar Nama Kamu
.profil
.checkin
.quest
.rank
.claim KODE
.shop
.beli ID_REWARD
.transfer 628xxxxxxxxxx 10
```

Owner:

```txt
.addpoint 628xxxxxxxxxx 100
.minpoint 628xxxxxxxxxx 100
.addxp 628xxxxxxxxxx 100
.addvoucher KODE poin stok deskripsi
.delvoucher KODE
.memberlist
.pending
.done ID
.cancel ID
```

Catatan: karena Cloud API bukan bot grup/WhatsApp Web, mention grup tidak menjadi fitur utama. Untuk command target member, pakai nomor format `628xxxx`.

## 10. Deploy ke Render

Environment variables di Render harus sama dengan `.env`. Pastikan:

```env
PUBLIC_BASE_URL=https://nama-service.onrender.com
PORT=10000
```

Setelah deploy, buka:

```txt
https://nama-service.onrender.com/health
https://nama-service.onrender.com/connect
```

Halaman `/connect` sekarang hanya menampilkan status dan instruksi Meta Cloud API, bukan pairing code.

## 11. Troubleshooting

### Webhook verification gagal

Cek:

- `PUBLIC_BASE_URL` sudah benar dan HTTPS
- `WHATSAPP_WEBHOOK_PATH=/webhook`
- Verify token di Meta sama persis dengan `WHATSAPP_VERIFY_TOKEN`
- Service Render sudah running

### Bot tidak membalas pesan

Cek:

- Field webhook **messages** sudah disubscribe
- `WHATSAPP_ACCESS_TOKEN` masih aktif
- `WHATSAPP_PHONE_NUMBER_ID` benar
- Nomor yang mengirim pesan termasuk nomor test recipient jika app masih development mode
- Log Render apakah ada `Meta API error`

### Testimoni media gagal upload

Cek:

- R2 env lengkap
- Bucket publik sudah aktif
- `R2_PUBLIC_BASE_URL` bisa diakses publik
- Ukuran media tidak melewati `maxMediaMb`

### Database kembali kosong setelah redeploy

Cek:

- `DB_PROVIDER=neon`
- `DATABASE_URL` benar dan memakai SSL
- Log tidak menampilkan warning konfigurasi Neon

## 12. Catatan production

- Jangan commit `.env`.
- Gunakan access token yang aman untuk production.
- Isi `META_APP_SECRET` supaya signature webhook bisa divalidasi.
- Jangan blast pesan massal tanpa consent/template yang benar.
- Untuk trafik besar, pindahkan processing webhook ke queue agar respons ke Meta tetap cepat.

## Perbaikan media R2 tidak muncul / URL dianggap berbahaya

Versi ini memakai mode rekomendasi:

```env
MEDIA_SERVE_MODE=proxy
R2_PUBLIC_BASE_URL=
```

Dengan mode `proxy`, file tetap disimpan di Cloudflare R2, tetapi website menampilkan media lewat domain aplikasi sendiri:

```txt
https://domainkamu.com/media/TST_xxxxx
```

Jadi bucket R2 tidak perlu dibuat public dan website tidak lagi membuka URL `r2.dev` atau `r2.cloudflarestorage.com` langsung dari browser.

Kenapa ini lebih aman:

- Bucket R2 boleh tetap private.
- Browser hanya melihat domain website kamu, bukan endpoint R2.
- Data lama yang punya `storageKey` tetap bisa tampil lewat `/media/:id`.
- Mengurangi risiko warning dari domain publik sementara seperti `r2.dev`.

Kalau kamu tetap ingin public URL langsung dari R2, baru pakai:

```env
MEDIA_SERVE_MODE=public
R2_PUBLIC_BASE_URL=https://media.domainkamu.com
```

Untuk production, gunakan custom domain R2 sendiri, bukan `r2.dev`.
