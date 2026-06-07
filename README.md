# Cicle Clone - Node.js Edition

Aplikasi manajemen tugas dan kolaborasi tim mirip **Cicle.app**, dibuat dengan **Node.js + Express + Prisma + Socket.io + EJS + Tailwind**.

## Fitur MVP

- ✅ Registrasi + Login (dengan pembuatan Company otomatis)
- ✅ Multi-workspace support dasar
- ✅ Kanban Board dengan Drag & Drop (To Do → In Progress → Done)
- ✅ Buat, edit, hapus tugas + assignee + deadline
- ✅ Real-time Chat per proyek (Socket.io)
- ✅ Komentar tugas (dasar)
- ✅ Deploy-ready dengan Dockerfile untuk **EasyPanel**

## Tech Stack

- **Backend**: Node.js 20, Express, Prisma ORM, Socket.io
- **Database**: PostgreSQL
- **Frontend**: EJS + Tailwind CSS (CDN) + Vanilla JS
- **Deployment**: EasyPanel (Docker)

## Cara Menjalankan Lokal

1. Clone repo ini
2. `npm install`
3. Copy `.env.example` ke `.env` dan isi `DATABASE_URL`
4. `npx prisma migrate dev`
5. `npm run dev`

Atau pakai Docker Compose:
```bash
docker compose up --build
```

## Deploy ke EasyPanel

1. Buat repo GitHub baru dan push semua file ini
2. Di EasyPanel:
   - Buat Project baru
   - Pilih **Git** → Connect ke repo GitHub kamu
   - Build Method: **Dockerfile**
   - Tambahkan Service **PostgreSQL** (atau external DB)
   - Set Environment Variable:
     - `DATABASE_URL` = connection string Postgres kamu
     - `SESSION_SECRET` = random string panjang
   - Deploy!

Aplikasi akan otomatis build dan jalan di domain yang disediakan EasyPanel.

## Struktur Folder

```
cicle-clone/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app.js
│   ├── routes/
│   ├── views/          # EJS templates
│   └── public/
└── README.md
```

## Roadmap (Next Features)

- Role-based access control lebih baik
- File attachment di tugas
- Performance report / dashboard analytics
- Mobile responsive lebih baik
- Invite member via email
- Recurring tasks

Dibuat dengan ❤️ oleh Grok untuk Ryan.

---

**Siap digunakan!** Buka `http://localhost:3000` setelah setup.
