# Changelog

All notable changes to the Cicle Clone project.

## [2.0.0] - 2025-06-27

### 🔒 Security & Bug Fixes

#### 1. Session Secret Hardcoded Fix
- **File**: `src/app.js`
- App now **refuses to start** if `NODE_ENV=production` and `SESSION_SECRET` is not set or is the default value
- Prevents running with insecure default secrets in production

#### 2. CSRF Protection
- **Files**: `src/app.js`
- Added CSRF token generation and validation middleware
- CSRF tokens are stored in session and validated on all form POST requests
- JSON API requests are exempted (they use session auth)
- File uploads (multipart) are exempted
- Token is available in all EJS views via `csrfToken`

#### 3. Maintenance Race Condition Fix
- **File**: `src/app.js`
- Added `maintenanceRunning` flag to prevent parallel maintenance execution
- Maintenance runs once and subsequent requests await the same promise
- Proper error handling with flag reset on completion

#### 4. Socket.io Auth Check
- **File**: `src/app.js`
- Added Socket.io middleware that verifies user session from `handshake.auth`
- Stores `userId` and `userName` in `socket.data`
- `join-project` event now verifies project access before allowing room join
- `join-user` event validates that the userId matches the authenticated user

#### 5. Chat Messages Pagination
- **Files**: `src/routes/chat.js`
- Changed from `take:100` to cursor-based pagination
- Added `?before=<timestamp>&limit=50` query parameters
- Returns pagination metadata: `{ hasMore, oldestTimestamp, totalCount, limit }`
- Default limit: 50, max: 100

#### 6. Error Handler Improvement
- **Files**: `src/lib/errorHandler.js`, `src/views/error.ejs`
- Added error ID generation using UUID
- Logs full error details: method, URL, user, message, stack trace
- Returns user-friendly message with error ID for support
- Added dedicated error page template

---

### 🏗️ Architecture Improvements

#### 7. Rate Limiting
- **File**: `src/app.js`
- Installed `express-rate-limit`
- `/auth/login`: 10 requests per 15 minutes
- `/auth/register`: 5 requests per hour
- General API: 100 requests per minute
- Proper error messages in Indonesian

#### 8. Input Validation with Zod
- **Files**: `src/lib/validation.js`
- Installed `zod`
- Created validation schemas for:
  - User registration and login
  - Task create/update
  - Chat messages
  - Comments
  - Project creation
- Created reusable `validate()` middleware factory

#### 9. Database Query Optimization
- **Files**: `prisma/schema.prisma`, `src/lib/maintenance.js`
- Added indexes on:
  - `Task(assigneeId, status)` - for My Tasks queries
  - `Task(projectId, status)` - for Kanban board queries
  - `Task(dueDate)` - for deadline queries
  - `ActivityLog(userId, createdAt)` - for activity timeline
  - `ActivityLog(projectId, createdAt)` - for project activity
  - `ActivityLog(createdAt)` - for global activity
  - `ChatMessage(parentId)` - for threaded messages
  - `ChatMessage(projectId, createdAt)` - for chat pagination
- Maintenance functions ensure all indexes exist at runtime

#### 10. Socket.io Scaling (Redis Adapter)
- **File**: `src/app.js`
- Installed `@socket.io/redis-adapter` and `ioredis`
- Conditional Redis adapter setup (only if `REDIS_URL` is set)
- Falls back to in-memory if no Redis configured
- Documented in `.env.example`

#### 11. Prisma Connection Pooling
- **File**: `.env.example`
- Added `connection_limit=10` to DATABASE_URL example
- Documented connection pooling best practices

---

### 🚀 New Features - Productivity & Focus

#### 12. Pomodoro Timer Upgrade
- **Files**: `src/routes/focus.js`, `src/views/focus.ejs`
- Added two preset modes:
  - **Pomodoro Klasik** (25min work / 5min break)
  - **Fokus Panjang** (50min work / 10min break)
- Configurable timer with 25/30/50/60 minute presets
- Long break unlocked after 3 focus sessions
- **Daily and weekly focus statistics** with bar chart
- **Focus Mode** toggle that hides notifications and chat
- Weekly stats API endpoint (`GET /focus/stats`)

#### 13. Smart Notifications
- **File**: `src/lib/smartNotify.js`
- Batch notifications: if 10+ tasks updated within 5 min, sends summary
- Priority-based: URGENT tasks push immediately, LOW tasks can be deferred
- **Do Not Disturb** schedule per user (`dndStart`/`dndEnd` fields on User model)
- Digest email capability with nodemailer structure
- Enhanced `notifyUser` with `preview` and `actionButtons` options

#### 14. Task Templates with Quick Create
- **File**: `src/routes/templates.js` (existing, already had good CRUD)
- Template library per project/brand
- "Create from Template" button in Kanban UI (already existed)
- Template selector in task creation form
- Checklist items auto-populated from template

---

### 👥 New Features - Collaboration

#### 15. Activity Feed Per User
- **Files**: `src/routes/activity.js`, `src/views/activity/timeline.ejs`
- Added **Timeline view** (`/activity/timeline`)
- Filter by project, user, and date
- Visual timeline with dots and connecting line
- Shows who did what, when

#### 16. Task Dependencies Visualization
- **Files**: `src/routes/dependencies.js`, `src/views/tasks/dependencies.ejs`
- Added dependency graph endpoint (`/dependencies/graph/:projectId`)
- SVG-based visualization with nodes and arrows
- Color-coded by status (green=done, amber=in-progress, gray=todo)
- Critical path highlighting (red arrows for incomplete chains)
- Legend showing status colors

#### 17. Workload Balancing View
- **Files**: `src/routes/workload.js`, `src/views/workload.ejs`
- Dashboard per member: active tasks, completion rate, overdue count
- Capacity bar visualization (0-10 task scale)
- Overload detection (>10 active tasks)
- Reassignment suggestions for overloaded members
- Summary cards: total members, active tasks, overloaded count

#### 18. Chat Threading
- **Files**: `src/routes/chat.js`, `prisma/schema.prisma`
- Added `parentId` field to ChatMessage model
- Reply-to functionality in chat routes
- Thread-aware message loading (parent messages with reply previews)
- Socket.io events for threaded messages
- Prisma migration support via maintenance function

#### 19. Contextual @mention Notifications
- **File**: `src/lib/notify.js`
- Enhanced `notifyUser` to include `preview` and `actionButtons` options
- Notification events now carry preview text and action buttons
- Structure supports Approve, Done, Reply action buttons

---

### ⚡ Quick Wins

#### 20. Keyboard Shortcuts
- **File**: `src/public/js/shortcuts.js`
- `K` = Kanban view, `C` = create task, `/` = search, `Escape` = close modal
- `D` = My Day, `T` = My Tasks, `G` = Dashboard
- `?` = Show shortcuts help overlay
- `Ctrl+K` = Focus search input
- Help overlay with all shortcuts listed

#### 21. Task Color Coding by Priority
- **File**: `src/views/projects/kanban.ejs`
- URGENT = red left border, HIGH = orange, MEDIUM = yellow, LOW = blue, NONE = gray
- Applied to all Kanban cards
- Visual priority indicator on cards

#### 22. Overdue Task Visual Highlight
- **Files**: `src/views/projects/kanban.ejs`
- Red background (`bg-red-50`) for overdue task cards
- Red border for overdue cards
- "X days overdue" badge shown on cards
- Applied to Kanban board

#### 23. "My Day" View
- **Files**: `src/routes/my-day.js`, `src/views/my-day.ejs`
- Shows tasks due today, in progress, and suggested tasks
- Quick add/remove from "My Day" with star toggle
- Suggested tasks: overdue or high priority
- Quick move buttons (Mulai/Selesai)
- Stats cards: tasks today, in progress count

#### 24. Bulk Task Operations
- **File**: `src/views/projects/kanban.ejs` (already existed in original)
- Checkbox selection on Kanban cards
- Bulk status change (To Do, Doing, Done)
- Bulk assign, bulk deadline, bulk move to project
- Bulk delete with confirmation

#### 25. Export Tasks to CSV/Excel
- **Files**: `src/routes/export.js`
- Installed `exceljs`
- Export filtered tasks to CSV or XLSX
- Export button added to Kanban toolbar
- Export endpoint for project tasks (`/export/tasks/:projectId`)
- Export endpoint for My Tasks (`/export/my-tasks`)
- Filtered by status, priority, assignee

#### 26. Dark Mode Toggle
- **Files**: `src/public/js/dark-mode.js`, `src/views/partials/header.ejs`
- Dark mode CSS classes with comprehensive overrides
- Toggle button in navbar (moon/sun icon)
- Preference stored in localStorage
- Syncs across browser tabs
- System preference detection (prefers-color-scheme)
- Applied to all EJS views via dark mode CSS

---

### 📦 New Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `csrf-csrf` | ^3.0.6 | CSRF protection |
| `express-rate-limit` | ^7.5.0 | Rate limiting |
| `zod` | ^3.24.2 | Input validation |
| `exceljs` | ^4.4.0 | Excel export |
| `uuid` | ^11.1.0 | Error ID generation |
| `nodemailer` | ^6.9.16 | Email sending (prepared) |
| `ioredis` | ^5.4.2 | Redis client for Socket.io |
| `socket.io-redis` | ^6.1.1 | Socket.io Redis adapter |

### 📁 New Files

| File | Purpose |
|------|---------|
| `src/lib/validation.js` | Zod validation schemas and middleware |
| `src/lib/smartNotify.js` | Smart notification batching and DND |
| `src/lib/errorHandler.js` | Error handler with error ID generation |
| `src/routes/export.js` | CSV/XLSX export endpoints |
| `src/routes/workload.js` | Workload balancing dashboard |
| `src/routes/my-day.js` | My Day feature |
| `src/views/error.ejs` | Error page template |
| `src/views/workload.ejs` | Workload dashboard view |
| `src/views/my-day.ejs` | My Day view |
| `src/views/activity/timeline.ejs` | Activity timeline view |
| `src/views/tasks/dependencies.ejs` | Dependency graph visualization |
| `src/public/js/shortcuts.js` | Keyboard shortcuts handler |
| `src/public/js/dark-mode.js` | Dark mode toggle logic |
| `CHANGELOG.md` | This file |

### 🔄 Modified Files

| File | Changes |
|------|---------|
| `src/app.js` | Security fixes, rate limiting, CSRF, socket auth, error handler, new routes |
| `prisma/schema.prisma` | ChatMessage.parentId, User.dnd fields, Task.myDay, indexes |
| `src/lib/maintenance.js` | New migration functions for all schema changes |
| `src/lib/notify.js` | Enhanced with preview and action buttons |
| `src/routes/chat.js` | Pagination, threading support |
| `src/routes/focus.js` | Weekly stats, enhanced Pomodoro |
| `src/routes/activity.js` | Timeline view route, enhanced action labels |
| `src/routes/dependencies.js` | Graph visualization endpoint |
| `src/views/focus.ejs` | 25/5 and 50/10 modes, weekly chart, focus mode |
| `src/views/projects/kanban.ejs` | Priority color coding, overdue highlight, export/deps buttons |
| `src/views/partials/header.ejs` | New sidebar links, dark mode JS, shortcuts JS |
| `package.json` | New dependencies |
| `.env.example` | Redis, SMTP, connection pooling docs |
