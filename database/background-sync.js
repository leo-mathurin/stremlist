/**
 * Background synchronization system for IMDb watchlists
 * Integrates job queues, workers, and rate limiting
 */

const { initialize: initializeQueue, scheduleUserSync, hasActiveJob, getQueueStats, closeQueue } = require('./job-queue');
const { initializeWorker, startWorker, getWorkerStats } = require('./worker');
const { initialize: initializeRateLimiter, acquireToken, releaseToken, getStatus: getRateLimiterStatus, close: closeRateLimiter } = require('./rate-limiter');
const config = require('./config');

// Store system status
const systemState = {
    isInitialized: false,
    queueInitialized: false,
    workerInitialized: false,
    rateLimiterInitialized: false
};

/**
 * Initialize the background sync system
 * @param {Object} dependencies - Functions needed for watchlist operations
 * @param {Function} dependencies.fetchWatchlist - Function to fetch watchlist
 * @param {Function} dependencies.storeWatchlist - Function to store watchlist
 * @returns {Promise<boolean>} - Whether initialization was successful
 */
async function initialize(dependencies) {
    if (systemState.isInitialized) {
        console.log('Background sync system already initialized');
        return true;
    }
    
    if (!dependencies || !dependencies.fetchWatchlist || !dependencies.storeWatchlist) {
        console.error('Cannot initialize background sync: Missing required dependencies');
        return false;
    }
    
    try {
        // Initialize rate limiter
        const rateLimiterConfig = {
            useRedis: config.DISTRIBUTED_RATE_LIMITING && config.REDIS_ENABLED,
            tokensPerInterval: config.RATE_LIMIT_REQUESTS,
            interval: config.RATE_LIMIT_INTERVAL
        };
        
        systemState.rateLimiterInitialized = await initializeRateLimiter(rateLimiterConfig);
        
        // Initialize job queue (if enabled)
        if (config.WORKER_ENABLED) {
            systemState.queueInitialized = await initializeQueue();
            
            // Initialize worker if queue is available
            if (systemState.queueInitialized) {
                systemState.workerInitialized = initializeWorker({
                    fetchWatchlist: async (userId) => {
                        // Use rate limiter for fetching
                        const canProceed = await acquireToken();
                        if (!canProceed) {
                            console.log(`Rate limited: Delaying fetch for user ${userId}`);
                            // Wait and try again
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            return dependencies.fetchWatchlist(userId);
                        }
                        
                        try {
                            const result = await dependencies.fetchWatchlist(userId);
                            await releaseToken(true);
                            return result;
                        } catch (error) {
                            await releaseToken(false);
                            throw error;
                        }
                    },
                    storeWatchlist: dependencies.storeWatchlist
                });
                
                // Start worker if initialized successfully
                if (systemState.workerInitialized) {
                    await startWorker(config.WORKER_CONCURRENCY);
                }
            }
        }
        
        systemState.isInitialized = systemState.rateLimiterInitialized && 
            (!config.WORKER_ENABLED || (systemState.queueInitialized && systemState.workerInitialized));
        
        console.log(`Background sync system initialized (queue: ${systemState.queueInitialized}, worker: ${systemState.workerInitialized}, rate limiter: ${systemState.rateLimiterInitialized})`);
        return systemState.isInitialized;
    } catch (error) {
        console.error('Failed to initialize background sync system:', error);
        return false;
    }
}

/**
 * Schedule a sync job for a user
 * @param {string} userId - The IMDb user ID
 * @param {string} priority - Priority level: 'high', 'normal', or 'low'
 * @returns {Promise<boolean>} - Whether scheduling was successful
 */
async function scheduleSyncForUser(userId, priority = 'normal') {
    if (!systemState.isInitialized || !systemState.queueInitialized) {
        return false;
    }
    
    // Check if user already has an active job
    const hasJob = await hasActiveJob(userId);
    if (hasJob) {
        console.log(`User ${userId} already has an active sync job`);
        return true;
    }
    
    // Schedule the job
    const job = await scheduleUserSync(userId, priority);
    return job !== null;
}

/**
 * Schedule sync jobs for multiple users with priority
 * @param {Array<string>} userIds - List of user IDs to sync
 * @param {function} priorityCalculator - Function to calculate priority for each user
 * @returns {Promise<Object>} - Results of scheduling
 */
async function scheduleBulkSync(userIds, priorityCalculator = null) {
    if (!systemState.isInitialized || !systemState.queueInitialized) {
        return { success: false, message: 'Background sync not initialized' };
    }
    
    if (!userIds || !userIds.length) {
        return { success: true, scheduled: 0, skipped: 0, message: 'No users to sync' };
    }
    
    const results = {
        success: true,
        scheduled: 0,
        skipped: 0,
        failed: 0
    };
    
    for (const userId of userIds) {
        // Determine priority if calculator provided
        let priority = 'normal';
        if (typeof priorityCalculator === 'function') {
            priority = priorityCalculator(userId);
        }
        
        // Check if user already has an active job
        const hasJob = await hasActiveJob(userId);
        if (hasJob) {
            results.skipped++;
            continue;
        }
        
        // Schedule the job
        const job = await scheduleUserSync(userId, priority);
        if (job) {
            results.scheduled++;
        } else {
            results.failed++;
        }
    }
    
    results.message = `Scheduled ${results.scheduled} jobs, skipped ${results.skipped} (already queued), failed ${results.failed}`;
    return results;
}

/**
 * Schedule staggered sync jobs for all users across a time interval
 * @param {Array<string>} userIds - List of user IDs to sync
 * @param {number} totalIntervalMs - Total time interval to spread users across (in milliseconds)
 * @returns {Promise<Object>} - Results of scheduling
 */
async function scheduleStaggeredSync(userIds, totalIntervalMs) {
    if (!systemState.isInitialized || !systemState.queueInitialized) {
        return { success: false, message: 'Background sync not initialized' };
    }
    
    if (!userIds || !userIds.length) {
        return { success: true, scheduled: 0, message: 'No users to sync' };
    }
    
    // Calculate delay between users
    const delayBetweenUsers = Math.floor(totalIntervalMs / userIds.length);
    
    console.log(`Scheduling ${userIds.length} users over ${totalIntervalMs/60000/60} hours`);
    console.log(`Delay between users: ${delayBetweenUsers/1000} seconds`);
    
    const results = {
        success: true,
        scheduled: 0,
        failed: 0
    };
    
    // Schedule each user with progressive delay
    userIds.forEach((userId, index) => {
        const delay = index * delayBetweenUsers;
        
        setTimeout(async () => {
            try {
                const job = await scheduleUserSync(userId, 'normal');
                if (job) {
                    results.scheduled++;
                    console.log(`Scheduled user ${userId} (${index + 1}/${userIds.length})`);
                } else {
                    results.failed++;
                    console.error(`Failed to schedule user ${userId}`);
                }
            } catch (error) {
                results.failed++;
                console.error(`Failed to schedule user ${userId}:`, error);
            }
        }, delay);
    });
    
    results.message = `Scheduled ${results.scheduled} staggered sync jobs over ${totalIntervalMs/60000/60} hours`;
    return results;
}

/**
 * Check if a token is available for IMDb API request
 * @returns {Promise<boolean>} - Whether a token is available
 */
async function canMakeImdbRequest() {
    if (!systemState.rateLimiterInitialized) {
        return true; // No rate limiting if not initialized
    }
    
    return acquireToken();
}

/**
 * Make a rate-limited request to IMDb
 * @param {Function} requestFn - Function that makes the actual request
 * @returns {Promise<any>} - Result of the request
 */
async function makeRateLimitedRequest(requestFn) {
    if (!systemState.rateLimiterInitialized) {
        return requestFn(); // No rate limiting if not initialized
    }
    
    const canProceed = await acquireToken();
    if (!canProceed) {
        // Wait and try again if rate limited
        await new Promise(resolve => setTimeout(resolve, 2000));
        return makeRateLimitedRequest(requestFn);
    }
    
    try {
        const result = await requestFn();
        await releaseToken(true);
        return result;
    } catch (error) {
        await releaseToken(false);
        throw error;
    }
}

/**
 * Get system status
 * @returns {Promise<Object>} - Current system status
 */
async function getStatus() {
    const status = {
        isInitialized: systemState.isInitialized,
        components: {
            queue: {
                initialized: systemState.queueInitialized,
                stats: null
            },
            worker: {
                initialized: systemState.workerInitialized,
                stats: null
            },
            rateLimiter: {
                initialized: systemState.rateLimiterInitialized,
                stats: null
            }
        }
    };
    
    // Get component stats
    if (systemState.queueInitialized) {
        status.components.queue.stats = await getQueueStats();
    }
    
    if (systemState.workerInitialized) {
        status.components.worker.stats = getWorkerStats();
    }
    
    if (systemState.rateLimiterInitialized) {
        status.components.rateLimiter.stats = await getRateLimiterStatus();
    }
    
    return status;
}

/**
 * Shutdown the background sync system
 * @returns {Promise<void>}
 */
async function shutdown() {
    try {
        // Close components in reverse order
        if (systemState.queueInitialized) {
            await closeQueue();
        }
        
        if (systemState.rateLimiterInitialized) {
            await closeRateLimiter();
        }
        
        // Reset state
        systemState.isInitialized = false;
        systemState.queueInitialized = false;
        systemState.workerInitialized = false;
        systemState.rateLimiterInitialized = false;
        
        console.log('Background sync system shut down');
    } catch (error) {
        console.error('Error shutting down background sync system:', error);
    }
}

module.exports = {
    initialize,
    scheduleSyncForUser,
    scheduleBulkSync,
    scheduleStaggeredSync,
    canMakeImdbRequest,
    makeRateLimitedRequest,
    getStatus,
    shutdown
}; 