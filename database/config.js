/**
 * Database and caching configuration
 * These values are read from environment variables defined in .env
 */

// Cache settings
// Convert environment variable minutes to seconds for internal use
const CACHE_TTL = parseInt(process.env.CACHE_TTL || 15) * 60; // Default: 15 minutes in seconds
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || 30) * 60; // Default: 30 minutes in seconds

// Redis settings
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false';

// Fallback settings
const USE_MEMORY_FALLBACK = process.env.USE_MEMORY_FALLBACK !== 'false';

// Worker settings
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || 3);
const WORKER_ENABLED = process.env.WORKER_ENABLED !== 'false';

// Rate limiting settings
const RATE_LIMIT_REQUESTS = parseInt(process.env.RATE_LIMIT_REQUESTS || 30);
const RATE_LIMIT_INTERVAL = parseInt(process.env.RATE_LIMIT_INTERVAL || 60) * 1000; // Convert to milliseconds
const DISTRIBUTED_RATE_LIMITING = process.env.DISTRIBUTED_RATE_LIMITING === 'true';

// Logging
const VERBOSE_DB_LOGGING = process.env.VERBOSE_DB_LOGGING === 'true';

module.exports = {
    // Cache settings
    CACHE_TTL,
    SYNC_INTERVAL,
    
    // Redis settings
    REDIS_URL,
    REDIS_ENABLED,
    USE_MEMORY_FALLBACK,
    
    // Worker settings
    WORKER_CONCURRENCY,
    WORKER_ENABLED,
    
    // Rate limiting settings
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_INTERVAL,
    DISTRIBUTED_RATE_LIMITING,
    
    // Logging
    VERBOSE_DB_LOGGING
}; 