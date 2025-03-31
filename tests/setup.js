/**
 * Jest test setup file
 * Sets up environment variables and global mocks for testing
 */

// Set environment variables for testing
process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = 'true'; // Enable Redis for testing
process.env.USE_MEMORY_FALLBACK = 'true';
process.env.CACHE_TTL = '2'; // 2 minutes for faster testing
process.env.SYNC_INTERVAL = '1'; // 1 minute for faster testing
process.env.WORKER_CONCURRENCY = '1';
process.env.WORKER_ENABLED = 'true';
process.env.RATE_LIMIT_REQUESTS = '100'; // Higher limit for testing
process.env.RATE_LIMIT_INTERVAL = '1'; // 1 second for faster testing
process.env.DISTRIBUTED_RATE_LIMITING = 'false';
process.env.VERBOSE_DB_LOGGING = 'false'; 