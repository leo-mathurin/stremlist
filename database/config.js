/**
 * Database and caching configuration
 * Uses centralized constants from the main constants.js file
 */
const constants = require('../constants');

module.exports = {
    // Cache settings
    CACHE_TTL: constants.CACHE_TTL,
    SYNC_INTERVAL: constants.SYNC_INTERVAL,
    
    // Redis settings
    REDIS_URL: constants.REDIS_URL,
    REDIS_ENABLED: constants.REDIS_ENABLED,
    USE_MEMORY_FALLBACK: constants.USE_MEMORY_FALLBACK,
    
    // Worker settings
    WORKER_CONCURRENCY: constants.WORKER_CONCURRENCY,
    WORKER_ENABLED: constants.WORKER_ENABLED,
    
    // Rate limiting settings
    RATE_LIMIT_REQUESTS: constants.RATE_LIMIT_REQUESTS,
    RATE_LIMIT_INTERVAL: constants.RATE_LIMIT_INTERVAL,
    DISTRIBUTED_RATE_LIMITING: constants.DISTRIBUTED_RATE_LIMITING,
    
    // Logging
    VERBOSE_DB_LOGGING: constants.VERBOSE_DB_LOGGING
};