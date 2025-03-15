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

// Logging
const VERBOSE_DB_LOGGING = process.env.VERBOSE_DB_LOGGING === 'true';

module.exports = {
    CACHE_TTL,
    SYNC_INTERVAL,
    REDIS_URL,
    REDIS_ENABLED,
    USE_MEMORY_FALLBACK,
    VERBOSE_DB_LOGGING
}; 