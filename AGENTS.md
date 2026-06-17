# Agent Workflow Preferences

## Git Workflow — ALWAYS commit and push after making changes

After making ANY non-trivial code changes in this project, the user expects:
1. **Commit** the changes with a descriptive message
2. **Push** to `origin/main` immediately

This is because the user deploys via **EasyPanel** which auto-deploys from the `main` branch on GitHub. The user wants changes live as soon as possible so they don't have to manually commit/push themselves.

### Commit message format
- Use clear, descriptive messages in Indonesian or English
- Examples:
  - `feat: add inline edit for assignee and due date on task detail`
  - `fix: preview panel show PIC and deadline more prominently`
  - `feat: add edit status/priority/due/assignee in kanban preview`

### When to commit/push
- After implementing a feature
- After fixing a bug
- After making UI improvements
- Basically: after every meaningful code change, before saying "done"

### Never do
- Don't wait for the user to ask "commit and push" — do it proactively
- Don't leave changes uncommitted at the end of a turn

## Project-Specific Notes

### Tech stack
- Backend: Node.js + Express + Prisma + PostgreSQL
- Frontend: EJS templates + Tailwind CSS + vanilla JS
- Real-time: Socket.io
- File uploads: Multer (local storage in `src/public/uploads/`)

### Key files
- `prisma/schema.prisma` — database schema
- `src/routes/` — Express route handlers
- `src/views/` — EJS templates
- `src/lib/` — shared utilities (prisma, auth, upload, notify, etc.)
- `src/middleware/auth.js` — auth middleware

### Deployment
- Platform: EasyPanel (Docker-based)
- Repo: https://github.com/rizkyzaneva-sukses/cicle-clone.git
- Branch: `main`
- EasyPanel auto-deploys on push to `main`

## User Communication Style

The user communicates in **Indonesian (Bahasa Indonesia)**. Responses should be concise and technical. Avoid unnecessary preamble/postamble. The user prefers direct, action-oriented communication.
