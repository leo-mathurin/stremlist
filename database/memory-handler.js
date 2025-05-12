const config = require('./config');

// In-memory storage for different data types
const storage = {
    watchlistCache: {},      // User watchlists: { userId: { timestamp, data } }
    activeUsers: new Set(),  // Set of active user IDs
    userActivity: {},        // User activity timestamps: { userId: timestamp }
    userConfigs: {}          // User configurations: { userId: { sortOption, etc } }
};

// Helper function to log verbose database operations
function logVerbose(...args) {
    if (config.VERBOSE_DB_LOGGING) {
        console.verbose(...args);
    }
}

/**
 * Cache watchlist data in memory
 * @param {string} userId - The IMDb user ID
 * @param {Object} watchlistData - The watchlist data to cache
 * @returns {Promise<boolean>} - Whether caching was successful
 */
async function cacheWatchlist(userId, watchlistData) {
    try {
        const cacheKey = `watchlist_${userId}`;
        storage.watchlistCache[cacheKey] = {
            timestamp: Date.now(),
            data: watchlistData
        };
        logVerbose(`Memory: Cached watchlist for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Memory: Error caching watchlist for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get cached watchlist data from memory
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Object|null>} - The cached watchlist data, or null if not found or expired
 */
async function getCachedWatchlist(userId) {
    try {
        const cacheKey = `watchlist_${userId}`;
        const cachedData = storage.watchlistCache[cacheKey];
        
        if (!cachedData) {
            logVerbose(`Memory: No cached data found for user ${userId}`);
            return null;
        }
        
        // Check if cache is expired
        if (cachedData.timestamp < Date.now() - (config.CACHE_TTL * 1000)) {
            logVerbose(`Memory: Cache expired for user ${userId}`);
            return null;
        }
        
        logVerbose(`Memory: Retrieved cached watchlist for user ${userId}, cached ${Math.round((Date.now() - cachedData.timestamp)/1000/60)} minutes ago`);
        return cachedData;
    } catch (error) {
        console.error(`Memory: Error retrieving cached watchlist for user ${userId}:`, error);
        return null;
    }
}

/**
 * Get all user IDs that have cached watchlists
 * @returns {Promise<Array<string>>} - Array of user IDs
 */
async function getCachedUserIds() {
    try {
        return Object.keys(storage.watchlistCache).map(key => key.replace('watchlist_', ''));
    } catch (error) {
        console.error('Memory: Error retrieving cached user IDs:', error);
        return [];
    }
}

/**
 * Check if memory storage is available
 * @returns {Promise<boolean>} - Always returns true for memory storage
 */
async function isMemoryAvailable() {
    return true;
}

/**
 * Store active user IDs for syncing
 * @param {Set<string>} userIds - Set of user IDs to store
 * @returns {Promise<boolean>} - Whether storing was successful
 */
async function storeActiveUsers(userIds) {
    try {
        storage.activeUsers = new Set(userIds);
        logVerbose(`Memory: Stored ${userIds.size} active users`);
        return true;
    } catch (error) {
        console.error('Memory: Error storing active users:', error);
        return false;
    }
}

/**
 * Get active user IDs for syncing
 * @returns {Promise<Array<string>>} - Array of active user IDs
 */
async function getActiveUsers() {
    try {
        const users = [...storage.activeUsers];
        logVerbose(`Memory: Retrieved ${users.length} active users`);
        return users;
    } catch (error) {
        console.error('Memory: Error retrieving active users:', error);
        return [];
    }
}

/**
 * Update user activity timestamp
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<boolean>} - Whether update was successful
 */
async function updateUserActivity(userId) {
    try {
        storage.userActivity[userId] = Date.now();
        logVerbose(`Memory: Updated activity timestamp for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Memory: Error updating activity for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get user activity timestamps
 * @returns {Promise<Object>} - Object mapping user IDs to timestamps
 */
async function getUserActivityTimestamps() {
    try {
        logVerbose(`Memory: Retrieved activity timestamps for ${Object.keys(storage.userActivity).length} users`);
        return {...storage.userActivity}; // Return a copy to prevent external modification
    } catch (error) {
        console.error('Memory: Error retrieving user activity timestamps:', error);
        return {};
    }
}

/**
 * Save user configuration to memory
 * @param {string} userId - The IMDb user ID
 * @param {Object} config - The configuration to save
 * @returns {Promise<boolean>} - Whether saving was successful
 */
async function saveUserConfig(userId, config) {
    try {
        storage.userConfigs[userId] = {...config};
        logVerbose(`Memory: Saved configuration for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Memory: Error saving configuration for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get user configuration from memory
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Object|null>} - The user configuration, or null if not found
 */
async function getUserConfig(userId) {
    try {
        const userConfig = storage.userConfigs[userId];
        if (!userConfig) {
            logVerbose(`Memory: No configuration found for user ${userId}`);
            return null;
        }
        
        logVerbose(`Memory: Retrieved configuration for user ${userId}`);
        return {...userConfig}; // Return a copy to prevent external modification
    } catch (error) {
        console.error(`Memory: Error retrieving configuration for user ${userId}:`, error);
        return null;
    }
}

/**
 * Close memory storage (no-op for memory storage)
 */
async function closeConnection() {
    logVerbose('Memory: No connection to close for memory storage');
    return true;
}

module.exports = {
    cacheWatchlist,
    getCachedWatchlist,
    getCachedUserIds,
    isMemoryAvailable,
    storeActiveUsers,
    getActiveUsers,
    updateUserActivity,
    getUserActivityTimestamps,
    saveUserConfig,
    getUserConfig,
    closeConnection
}; 