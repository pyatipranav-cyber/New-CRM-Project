'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
const tooMany = (message = 'Too many attempts. Please wait a few minutes and try again.') =>
  new AppError(429, 'RATE_LIMITED', message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany };
