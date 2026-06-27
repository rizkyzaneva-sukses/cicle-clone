const { v4: uuidv4 } = require('uuid');

function errorHandler(err, req, res, next) {
  const errorId = uuidv4();
  const timestamp = new Date().toISOString();

  // Log full error details
  console.error(`[${timestamp}] Error ID: ${errorId}`);
  console.error(`  Method: ${req.method} ${req.originalUrl}`);
  console.error(`  User: ${req.session?.user?.id || 'anonymous'}`);
  console.error(`  Message: ${err.message}`);
  console.error(`  Stack: ${err.stack}`);

  // Determine status code
  const statusCode = err.statusCode || err.status || 500;

  if (req.xhr || req.headers?.accept?.includes('json')) {
    return res.status(statusCode).json({
      error: 'Terjadi kesalahan internal',
      errorId,
      message: process.env.NODE_ENV === 'production'
        ? 'Silakan hubungi admin dengan Error ID di atas.'
        : err.message
    });
  }

  res.status(statusCode).render('error', {
    title: 'Error',
    errorId,
    statusCode,
    message: process.env.NODE_ENV === 'production'
      ? 'Terjadi kesalahan. Silakan hubungi admin.'
      : err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
}

module.exports = { errorHandler };
