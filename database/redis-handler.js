const Redis = require('ioredis');
const { promisify } = require('util');
const config = require('./config');

// Create Redis client
let redisClient;

// Only initialize Redis if enabled
if (config.REDIS_ENABLED) {
    try {
        redisClient = new Redis(config.REDIS_URL, {
            retryStrategy: (times) => {
                const delay = Math.min(times * 100, 3000);
                console.log(`Redis connection failed, retrying in ${delay}ms...`);
                return delay;
            },
            maxRetriesPerRequest: 3
        });

        redisClient.on('connect', () => {
            console.log('Connected to Redis');
        });

        redisClient.on('error', (err) => {
            console.error('Redis connection error:', err);
        });

        redisClient.on('reconnecting', () => {
            console.log('Reconnecting to Redis...');
        });
    } catch (error) {
        console.error('Failed to initialize Redis client:', error);
        // Continue without Redis - will use in-memory fallback
    }
} else {
    console.log('Redis is disabled via configuration. Using memory fallback.');
}

// Helper function to log verbose database operations
function logVerbose(...args) {
    if (config.VERBOSE_DB_LOGGING) {
        console.verbose(...args);
    }
}

/**
 * Cache watchlist data in Redis
 * @param {string} userId - The IMDb user ID
 * @param {Object} watchlistData - The watchlist data to cache
 * @returns {Promise<boolean>} - Whether caching was successful
 */
async function cacheWatchlist(userId, watchlistData) {
    if (!redisClient || redisClient.status !== 'ready') {
        return false;
    }

    const cacheKey = `watchlist_${userId}`;
    const cacheData = {
        timestamp: Date.now(),
        data: watchlistData
    };

    try {
        await redisClient.set(
            cacheKey, 
            JSON.stringify(cacheData),
            'EX',
            config.CACHE_TTL
        );
        logVerbose(`Redis: Cached watchlist for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Redis: Error caching watchlist for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get cached watchlist data from Redis
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Object|null>} - The cached watchlist data, or null if not found
 */
async function getCachedWatchlist(userId) {
    if (!redisClient || redisClient.status !== 'ready') {
        return null;
    }

    const cacheKey = `watchlist_${userId}`;
    
    try {
        const cachedData = await redisClient.get(cacheKey);
        if (!cachedData) {
            logVerbose(`Redis: No cached data found for user ${userId}`);
            return null;
        }

        const parsedData = JSON.parse(cachedData);
        logVerbose(`Redis: Retrieved cached watchlist for user ${userId}, cached ${Math.round((Date.now() - parsedData.timestamp)/1000/60)} minutes ago`);
        return parsedData;
    } catch (error) {
        console.error(`Redis: Error retrieving cached watchlist for user ${userId}:`, error);
        return null;
    }
}

/**
 * Get all user IDs that have cached watchlists
 * @returns {Promise<Array<string>>} - Array of user IDs
 */
async function getCachedUserIds() {
    if (!redisClient || redisClient.status !== 'ready') {
        return [];
    }

    try {
        const keys = await redisClient.keys('watchlist_*');
        return keys.map(key => key.replace('watchlist_', ''));
    } catch (error) {
        console.error('Redis: Error retrieving cached user IDs:', error);
        return [];
    }
}

/**
 * Check if Redis connection is alive and working
 * @returns {Promise<boolean>} - Whether Redis is available
 */
async function isRedisAvailable() {
    if (!redisClient) return false;
    
    try {
        const pong = await redisClient.ping();
        return pong === 'PONG';
    } catch (error) {
        console.error('Redis: Connection check failed:', error);
        return false;
    }
}

/**
 * Store active user IDs for syncing
 * @param {Set<string>} userIds - Set of user IDs to store
 * @returns {Promise<boolean>} - Whether storing was successful
 */
async function storeActiveUsers(userIds) {
    if (!redisClient || redisClient.status !== 'ready') {
        return false;
    }

    try {
        await redisClient.del('active_users');
        if (userIds.size > 0) {
            await redisClient.sadd('active_users', [...userIds]);
        }
        logVerbose(`Redis: Stored ${userIds.size} active users`);
        return true;
    } catch (error) {
        console.error('Redis: Error storing active users:', error);
        return false;
    }
}

/**
 * Get active user IDs for syncing
 * @returns {Promise<Array<string>>} - Array of active user IDs
 */
async function getActiveUsers() {
    if (!redisClient || redisClient.status !== 'ready') {
        return [];
    }

    try {
        const users = await redisClient.smembers('active_users');
        logVerbose(`Redis: Retrieved ${users.length} active users`);
        return users;
    } catch (error) {
        console.error('Redis: Error retrieving active users:', error);
        return [];
    }
}

/**
 * Update user activity timestamp
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<boolean>} - Whether update was successful
 */
async function updateUserActivity(userId) {
    if (!redisClient || redisClient.status !== 'ready') {
        return false;
    }

    try {
        await redisClient.hset('user_activity', userId, Date.now());
        logVerbose(`Redis: Updated activity timestamp for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Redis: Error updating activity for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get user activity timestamps
 * @returns {Promise<Object>} - Object mapping user IDs to timestamps
 */
async function getUserActivityTimestamps() {
    if (!redisClient || redisClient.status !== 'ready') {
        return {};
    }

    try {
        const timestamps = await redisClient.hgetall('user_activity');
        const result = {};
        
        // Convert string timestamps to numbers
        for (const [userId, timestamp] of Object.entries(timestamps)) {
            result[userId] = parseInt(timestamp);
        }
        
        logVerbose(`Redis: Retrieved activity timestamps for ${Object.keys(result).length} users`);
        return result;
    } catch (error) {
        console.error('Redis: Error retrieving user activity timestamps:', error);
        return {};
    }
}

/**
 * Save user configuration to Redis
 * @param {string} userId - The IMDb user ID
 * @param {Object} config - The configuration to save
 * @returns {Promise<boolean>} - Whether saving was successful
 */
async function saveUserConfig(userId, config) {
    if (!redisClient || redisClient.status !== 'ready') {
        return false;
    }

    try {
        await redisClient.hset(`user_config_${userId}`, ...Object.entries(config).flat());
        logVerbose(`Redis: Saved configuration for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Redis: Error saving configuration for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get user configuration from Redis
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Object|null>} - The user configuration, or null if not found
 */
async function getUserConfig(userId) {
    if (!redisClient || redisClient.status !== 'ready') {
        return null;
    }

    try {
        const config = await redisClient.hgetall(`user_config_${userId}`);
        if (!config || Object.keys(config).length === 0) {
            logVerbose(`Redis: No configuration found for user ${userId}`);
            return null;
        }
        
        logVerbose(`Redis: Retrieved configuration for user ${userId}`);
        return config;
    } catch (error) {
        console.error(`Redis: Error retrieving configuration for user ${userId}:`, error);
        return null;
    }
}

/**
 * Get the current count of active Redis connections
 * @returns {Promise<number>} - Number of active clients
 */
async function getActiveConnectionsCount() {
    if (!redisClient || redisClient.status !== 'ready') {
        return 0;
    }

    try {
        // Get Redis client list info
        const clientInfo = await redisClient.client('LIST');
        // Count the number of client connections (each client is on a new line)
        const clientCount = clientInfo.split('\n').filter(line => line.trim().length > 0).length;
        // Subtract 1 to exclude our own connection
        const activeCount = Math.max(0, clientCount - 1);
        
        logVerbose(`Redis: Retrieved active connection count: ${activeCount}`);
        return activeCount;
    } catch (error) {
        console.error('Redis: Error retrieving active connections count:', error);
        return 0;
    }
}

/**
 * Close Redis connection gracefully
 */
async function closeConnection() {
    if (redisClient) {
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully');
        } catch (error) {
            console.error('Error closing Redis connection:', error);
        }
    }
}

// Helper functions that work only for this module
module.exports = {
    cacheWatchlist,
    getCachedWatchlist,
    getCachedUserIds,
    isRedisAvailable,
    storeActiveUsers,
    getActiveUsers,
    updateUserActivity,
    getUserActivityTimestamps,
    getActiveConnectionsCount,
    closeConnection,
    saveUserConfig,
    getUserConfig
}; 