# PRD: Cicle Clone - Aplikasi Manajemen Tugas & Kolaborasi Tim

**Versi:** 1.0  
**Tanggal:** 6 Juni 2026  
**Penulis:** Grok (xAI) untuk Ryan  
**Tujuan:** Membuat MVP aplikasi serupa Cicle.app menggunakan Node.js, deployable via EasyPanel + Docker, code di GitHub repo.

---

## 1. Ringkasan Eksekutif (Executive Summary)

Cicle.app adalah all-in-one productivity tool khas Indonesia untuk tim kecil-menengah: menggabungkan **Kanban task management**, **real-time chat tim**, dan **pelaporan kinerja** dalam satu aplikasi sederhana dan mobile-friendly. 

**Versi ini (Cicle Clone)** bertujuan membuat MVP yang fungsional, scalable, dan mudah di-deploy sendiri via EasyPanel (Docker-based PaaS). Fokus pada kesederhanaan seperti Cicle: ganti WhatsApp grup kerja + Trello + spreadsheet menjadi satu tool.

**MVP Scope:** Core task management + basic team chat + auth + dashboard.  
**Target Launch:** 4-6 minggu untuk MVP pertama.  
**Tech Philosophy:** Simple, reliable, Indonesian-friendly (bahasa default ID), self-hostable.

---

## 2. Masalah yang Diselesaikan

- Tim Indonesia sering pakai campuran tools (WA grup numpuk, Trello terpisah, Google Sheet manual) → chaos & hilang konteks.
- Butuh tool lokal yang murah, mudah dipakai leader & anggota tim, support mobile.
- Butuh real-time collaboration tanpa kompleksitas enterprise tools seperti Jira/Asana.

---

## 3. Target Pengguna

**Primary:**
- Owner / Leader bisnis kecil-menengah di Indonesia (tim 3-50 orang)
- Tim remote/WFH atau hybrid
- Departemen operasional, marketing, development, customer service

**Secondary:**
- Freelance teams atau startup early stage

**Persona:**
- Budi (Founder): Ingin pantau semua tugas tim tanpa ribet
- Sinta (Team Member): Ingin chat + update task cepat dari HP

---

## 4. Fitur Utama (Requirements)

### 4.1 MVP (Fase 1 - Core)

**Autentikasi & Organisasi**
- Register/Login (email + password, atau magic link)
- Buat Company/Workspace (multi-tenant)
- Invite member via email + role (Admin, Manager, Member)
- Profile management (avatar, name, position)

**Tim & Struktur**
- Buat Team / Project (mirip grup WA tapi terstruktur)
- Assign member ke Team/Project
- Permission sederhana (siapa bisa edit task, dll.)

**Task Management (Kanban)**
- Board per Team/Project
- List (To Do, In Progress, Done, custom)
- Card/Task: title, description (rich text), due date, assignee, checklist/subtask, attachment (file), priority, labels
- Drag & drop antar list
- Bulk actions
- Recurring tasks (basic)
- Filter & search tasks
- Archive card

**Komunikasi**
- Group Chat per Team/Project (real-time)
- Private Chat antar member
- Read receipts ("seen by")
- Mention @user
- Attachment file di chat
- Push notification (basic via web push / nanti mobile)

**Dashboard & Reporting (Basic)**
- My Tasks overview
- Team performance summary (completed tasks, overdue)
- Simple activity log

**Umum**
- Dark/Light mode
- Responsive (mobile first)
- Bahasa Indonesia default + English

### 4.2 Fase 2 (Post-MVP)

- Advanced reporting & analytics (charts)
- File management terpusat
- Calendar view + sync Google Calendar
- Notifications center + email digest
- Integrasi (Slack, Google Drive, WhatsApp Business API?)
- AI assistant sederhana (suggest due date, summarize chat)
- Mobile app native (React Native / Flutter) atau PWA
- Video call / meeting notes
- Time tracking

### 4.3 Non-Functional Requirements

- **Performance:** Load board < 2s, real-time chat < 500ms latency
- **Security:** JWT auth, role-based access control (RBAC), data encryption at rest, rate limiting
- **Scalability:** Multi-tenant, horizontal scaling via Docker
- **Reliability:** 99.5% uptime, backup otomatis
- **Usability:** Onboarding < 5 menit, UI clean seperti Cicle
- **Compliance:** Data privacy (sesuai regulasi Indonesia)

---

## 5. User Stories (Contoh)

**Sebagai Leader:**
- Saya bisa membuat workspace perusahaan saya
- Saya bisa invite karyawan dan atur role mereka
- Saya bisa membuat board Kanban untuk proyek X
- Saya bisa assign tugas ke anggota tim dan lihat progress real-time
- Saya bisa chat dengan tim di satu tempat tanpa WA

**Sebagai Member:**
- Saya bisa lihat semua tugas saya di satu dashboard
- Saya bisa update status tugas dengan drag & drop
- Saya bisa chat di group proyek dan tahu siapa yang sudah baca
- Saya dapat notifikasi saat ditag atau deadline dekat

---

## 6. Tech Stack yang Direkomendasikan

**Backend (Node.js - sesuai request)**
- Runtime: Node.js 20+ (LTS)
- Framework: Express.js atau Fastify (lebih cepat)
- ORM: Prisma (sangat recommended untuk PostgreSQL)
- Database: PostgreSQL 16+ (via Docker atau managed)
- Auth: JWT + bcryptjs / better-auth atau Passport.js
- Real-time: Socket.io
- File Upload: Multer + AWS S3 atau local storage (MinIO untuk self-host)
- Validation: Zod
- Logging: Winston / Pino
- Email: Nodemailer atau Resend

**Frontend (untuk MVP full)**
- Option A (Recommended untuk cepat): Next.js 15 (App Router) + Tailwind + shadcn/ui + TanStack Query
  - Bisa jadi fullstack (API routes + server components)
- Option B: Separate Vite + React + Tailwind

**Infrastructure & Deployment**
- **Container:** Docker + Docker Compose (untuk local dev)
- **Deployment:** EasyPanel (Docker image)
- **CI/CD:** GitHub Actions (build & push image ke registry)
- **Repo:** GitHub (monorepo atau backend + frontend terpisah)
- **Hosting DB:** Supabase / Neon / Railway / atau self-host PostgreSQL di VPS yang sama dengan EasyPanel
- **Storage:** Local volume atau S3-compatible (MinIO)
- **Monitoring:** Basic logs via EasyPanel + optional Sentry

**Alternatif Ringan untuk MVP Super Cepat**
- Gunakan **T3 Stack** (Next.js + tRPC + Prisma + Tailwind) — sangat cocok untuk solo dev / small team

---

## 7. Arsitektur Sistem (High Level)

```
User (Browser / Mobile)
        ↓
Frontend (Next.js / React)  ←→  Backend API (Node.js + Express/Fastify)
        ↓                              ↓
   Socket.io Client              Socket.io Server (real-time chat)
                                      ↓
                              Prisma ORM → PostgreSQL
                                      ↓
                              File Storage (S3 / MinIO)
```

**Multi-tenancy:** Setiap Company punya workspace terisolasi (via companyId di semua tabel).

**Docker Strategy:**
- Multi-stage build untuk production image kecil
- Separate service: app, db (postgres), redis (untuk Socket.io scaling jika perlu)

---

## 8. Deployment dengan EasyPanel + Docker

**Langkah Umum:**
1. Push code ke GitHub
2. Di EasyPanel: Connect GitHub repo
3. Buat Docker service dari Dockerfile
4. Set environment variables (DATABASE_URL, JWT_SECRET, dll.)
5. Deploy → otomatis build & run

**Dockerfile yang akan dibuat:**
- Base: node:20-alpine
- Multi-stage: builder → production
- Copy only necessary files
- Run `npm ci --only=production`
- Expose port 3000 (atau sesuai)
- Healthcheck

**docker-compose.yml** untuk local development (app + postgres + redis optional)

**Environment Variables penting:**
- NODE_ENV=production
- DATABASE_URL=postgresql://...
- JWT_SECRET=...
- PORT=3000
- CORS_ORIGIN=...

---

## 9. Roadmap & Timeline (Estimasi)

**Fase 0: Setup (1 minggu)**
- GitHub repo + monorepo structure
- Prisma schema + initial migration
- Auth system (register/login/JWT)
- Basic Express/Fastify server + health endpoint
- Dockerfile + docker-compose
- Deploy pertama ke EasyPanel (hello world)

**Fase 1: Core MVP (3-4 minggu)**
- Company & Team management + invite
- Kanban Board + Tasks CRUD + Drag & Drop (frontend)
- Basic Group & Private Chat dengan Socket.io + read receipts
- Dashboard sederhana
- File attachment (task & chat)
- Polish UI + responsive

**Fase 2: Polish & Reporting (2 minggu)**
- Performance reports
- Notifications
- Onboarding flow
- Bug fixes & optimization

**Total MVP siap production:** ~6-8 minggu (tergantung pace)

---

## 10. Success Metrics (MVP)

- User bisa complete full onboarding dalam <10 menit
- Board dengan 50+ tasks load <3 detik
- Real-time chat delay <1 detik
- 0 critical security issues
- Positive feedback dari 5-10 beta user Indonesia

---

## 11. Risiko & Mitigasi

| Risiko                  | Mitigasi                              |
|-------------------------|---------------------------------------|
| Scope creep             | Strict MVP definition + phased approach |
| Real-time complexity    | Mulai dengan Socket.io sederhana     |
| File storage            | Mulai pakai local volume, nanti S3   |
| Mobile experience       | Responsive web dulu, PWA nanti       |
| Data migration nanti    | Gunakan Prisma migration sejak awal  |

---

## 12. Lampiran & Referensi

- Desain UI: Mirip Cicle (clean, card-based, Kanban dominant)
- Warna brand: Biru/Teal profesional + aksen hijau (opsional)
- Icon: Lucide-react atau Heroicons
- Referensi: Cicle.app, Trello, ClickUp (simplified)

---

**Next Step setelah PRD disetujui:**
1. Buat GitHub repo structure lengkap
2. Tulis Dockerfile + docker-compose.yml
3. Buat Prisma schema lengkap
4. Implementasi auth + basic API
5. Mulai coding!

---

**Catatan untuk Ryan:**
PRD ini dibuat fleksibel. Kalau mau ubah prioritas fitur, tambah/hapus sesuatu, atau pakai stack berbeda (misal pakai tRPC / NestJS), bilang aja. Kita bisa iterasi PRD ini dulu sebelum coding.

Mau lanjut ke **GitHub repo structure + Dockerfile** sekarang? Atau revisi PRD dulu? 

Siap bantu sampai app jalan di EasyPanel bro! 🚀