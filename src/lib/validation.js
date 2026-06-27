const { z } = require('zod');

// Auth schemas
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name wajib diisi').max(100),
  email: z.string().trim().email('Email tidak valid').max(255),
  password: z.string().min(6, 'Password minimal 6 karakter').max(128),
  companyName: z.string().trim().max(200).optional().default('')
});

const loginSchema = z.object({
  email: z.string().trim().email('Email tidak valid').max(255),
  password: z.string().min(1, 'Password wajib diisi').max(128)
});

// Task schemas
const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'Judul task wajib diisi').max(500),
  description: z.string().trim().max(5000).optional().default(''),
  projectId: z.string().min(1, 'Project wajib diisi'),
  assigneeId: z.string().optional().default(''),
  dueDate: z.string().optional().default(''),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional().default('TODO'),
  priority: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().default('NONE'),
  checklists: z.array(z.string().trim().max(500)).max(100).optional().default([])
});

const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(5000).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  priority: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional()
});

// Chat message schema
const chatMessageSchema = z.object({
  content: z.string().trim().max(5000).optional().default(''),
  parentId: z.string().nullable().optional()
});

// Comment schema
const commentSchema = z.object({
  content: z.string().trim().min(1, 'Komentar wajib diisi').max(5000),
  parentId: z.string().nullable().optional()
});

// Project create schema
const projectCreateSchema = z.object({
  name: z.string().trim().min(1, 'Nama proyek wajib diisi').max(200),
  description: z.string().trim().max(2000).optional().default(''),
  companyId: z.string().min(1, 'Brand wajib diisi')
});

// Generic validation middleware factory
function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const data = source === 'body' ? req.body : req.query;
      const result = schema.safeParse(data);
      if (!result.success) {
        const errors = result.error.errors.map(e => e.message).join(', ');
        if (req.xhr || req.headers.accept?.includes('json')) {
          return res.status(400).json({ error: errors });
        }
        req.flash('error', errors);
        return res.redirect('back');
      }
      req.validated = result.data;
      next();
    } catch (err) {
      console.error('Validation error:', err);
      res.status(400).json({ error: 'Invalid input' });
    }
  };
}

module.exports = {
  registerSchema,
  loginSchema,
  taskCreateSchema,
  taskUpdateSchema,
  chatMessageSchema,
  commentSchema,
  projectCreateSchema,
  validate
};
