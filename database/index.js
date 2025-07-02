/**
 * Database interface that selects the appropriate backend
 * based on configuration and availability
 */

const config = require('./config');
const redisHandler = require('./redis-handler');
const memoryHandler = require('./memory-handler');
const backgroundSync = require('./background-sync');
const { fetchWatchlist } = require('../scripts/fetch_watchlist');

// Track which storage backend is currently in use
let currentBackend = null;
let isRedisActive = false;
let isBackgroundSyncInitialized = false;

/**
 * Initialize the database connection and select the appropriate backend
 */
async function initialize() {
    console.log('Initializing database connection...');
    
    // Check if Redis is available
    if (config.REDIS_ENABLED) {
        try {
            isRedisActive = await redisHandler.isRedisAvailable();
            if (isRedisActive) {
                console.log('Using Redis for persistent storage');
                currentBackend = redisHandler;
                // Initialize background sync after storage is ready
                await initializeBackgroundSync();
                return true;
            } else {
                console.log('Redis is not available');
            }
        } catch (error) {
            console.error('Error checking Redis availability:', error);
        }
    } else {
        console.log('Redis is disabled in configuration');
    }
    
    // Fall back to memory storage if Redis is not available
    if (config.USE_MEMORY_FALLBACK) {
        console.log('Using in-memory storage (fallback)');
        currentBackend = memoryHandler;
        // Try to initialize background sync even with memory backend
        await initializeBackgroundSync();
        return true;
    } else {
        console.error('All storage backends failed and fallback is disabled');
        return false;
    }
}

/**
 * Initialize the background sync system if it's enabled
 */
async function initializeBackgroundSync() {
    if (!config.WORKER_ENABLED) {
        console.log('Background sync system is disabled in configuration');
        return false;
    }
    
    try {
        // Set up background sync with dependencies from this module
        isBackgroundSyncInitialized = await backgroundSync.initialize({
            fetchWatchlist: fetchImdbWatchlist, // This needs to be implemented in your code
            storeWatchlist: async (userId, watchlistData) => {
                return await getHandler().cacheWatchlist(userId, watchlistData);
            }
        });
        
        return isBackgroundSyncInitialized;
    } catch (error) {
        console.error('Failed to initialize background sync:', error);
        return false;
    }
}

/**
 * Check if the storage backend is healthy and switch if needed
 */
async function checkHealth() {
    // If we're using Redis, check if it's still available
    if (currentBackend === redisHandler) {
        try {
            isRedisActive = await redisHandler.isRedisAvailable();
            if (!isRedisActive) {
                console.error('Redis connection lost, switching to memory fallback');
                currentBackend = memoryHandler;
            }
        } catch (error) {
            console.error('Error checking Redis health:', error);
            currentBackend = memoryHandler;
        }
    } 
    // If we're using memory, try to switch back to Redis if it was enabled
    else if (currentBackend === memoryHandler && config.REDIS_ENABLED) {
        try {
            isRedisActive = await redisHandler.isRedisAvailable();
            if (isRedisActive) {
                console.log('Redis connection restored, switching back to Redis');
                currentBackend = redisHandler;
            }
        } catch (error) {
            // Stay on memory backend
        }
    }
    
    return currentBackend === redisHandler ? 'redis' : 'memory';
}

/**
 * Get the appropriate handler for database operations
 * @returns {Object} The current database handler
 */
function getHandler() {
    if (!currentBackend) {
        // Auto-initialize if not already done
        initialize();
    }
    return currentBackend || memoryHandler; // Default to memory if initialization fails
}

/**
 * Close all database connections
 */
async function closeConnections() {
    try {
        // Shutdown background sync system first
        if (isBackgroundSyncInitialized) {
            await backgroundSync.shutdown();
        }
        
        // Then close database connections
        if (isRedisActive) {
            await redisHandler.closeConnection();
        }
        
        console.log('Database connections closed');
    } catch (error) {
        console.error('Error closing database connections:', error);
    }
}

/**
 * Fetch a user's IMDb watchlist
 * This function connects to the actual implementation in scripts/fetch_watchlist.js
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Object>} - The watchlist data
 */
async function fetchImdbWatchlist(userId) {
    try {
        return await fetchWatchlist(userId);
    } catch (error) {
        console.error(`Error fetching watchlist for user ${userId}:`, error);
        throw error;
    }
}

/**
 * Check if Redis is currently active and being used as storage backend
 * @returns {boolean} - Whether Redis is active
 */
function getRedisStatus() {
    return isRedisActive && currentBackend === redisHandler;
}

// Export functions that proxy to the selected backend
module.exports = {
    initialize,
    checkHealth,
    closeConnections,
    isRedisActive: getRedisStatus,
    
    // Data operations - these proxy to the currently active backend
    cacheWatchlist: async (userId, watchlistData) => {
        return await getHandler().cacheWatchlist(userId, watchlistData);
    },
    
    getCachedWatchlist: async (userId) => {
        return await getHandler().getCachedWatchlist(userId);
    },
    
    getCachedUserIds: async () => {
        return await getHandler().getCachedUserIds();
    },
    
    storeActiveUsers: async (userIds) => {
        return await getHandler().storeActiveUsers(userIds);
    },
    
    getActiveUsers: async () => {
        return await getHandler().getActiveUsers();
    },
    
    updateUserActivity: async (userId) => {
        return await getHandler().updateUserActivity(userId);
    },
    
    getUserActivityTimestamps: async () => {
        return await getHandler().getUserActivityTimestamps();
    },
    
    // User configuration functions
    saveUserConfig: async (userId, config) => {
        return await getHandler().saveUserConfig(userId, config);
    },
    
    getUserConfig: async (userId) => {
        return await getHandler().getUserConfig(userId);
    },
    
    // Redis-specific operations
    getActiveConnectionsCount: async () => {
        // Only call this on Redis handler, as memory doesn't have connections
        if (isRedisActive && currentBackend === redisHandler) {
            return await redisHandler.getActiveConnectionsCount();
        }
        return 0;
    },
    
    // Redis availability check
    isRedisAvailable: async () => {
        if (config.REDIS_ENABLED) {
            return await redisHandler.isRedisAvailable();
        }
        return false;
    },
    
    // Background sync operations
    scheduleSyncForUser: async (userId, priority = 'normal') => {
        if (!isBackgroundSyncInitialized) return false;
        return await backgroundSync.scheduleSyncForUser(userId, priority);
    },
    
    scheduleBulkSync: async (userIds, priorityCalculator = null) => {
        if (!isBackgroundSyncInitialized) {
            return { success: false, message: 'Background sync not initialized' };
        }
        return await backgroundSync.scheduleBulkSync(userIds, priorityCalculator);
    },
    
    scheduleStaggeredSync: async (userIds, totalIntervalMs) => {
        if (!isBackgroundSyncInitialized) {
            return { success: false, message: 'Background sync not initialized' };
        }
        return await backgroundSync.scheduleStaggeredSync(userIds, totalIntervalMs);
    },
    
    makeRateLimitedRequest: async (requestFn) => {
        if (!isBackgroundSyncInitialized) return requestFn();
        return await backgroundSync.makeRateLimitedRequest(requestFn);
    },
    
    canMakeImdbRequest: async () => {
        if (!isBackgroundSyncInitialized) return true;
        return await backgroundSync.canMakeImdbRequest();
    },
    
    getBackgroundSyncStatus: async () => {
        if (!isBackgroundSyncInitialized) {
            return { isInitialized: false };
        }
        return await backgroundSync.getStatus();
    },
    
    // Queue management
    clearAllJobs: async () => {
        const { clearAllJobs } = require('./job-queue');
        return await clearAllJobs();
    },
    
    // Expose background sync directly for advanced usage
    backgroundSync
}; 