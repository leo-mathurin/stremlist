/**
 * Job queue manager using Bull and Redis
 * Handles scheduling and prioritization of watchlist synchronization tasks
 */

const Queue = require('bull');
const config = require('./config');
const { isRedisAvailable } = require('./redis-handler');

// Queue names
const QUEUE_NAMES = {
    WATCHLIST_SYNC: 'watchlist-sync',
};

// Priority levels
const PRIORITY = {
    HIGH: 1,
    NORMAL: 10,
    LOW: 20
};

// Default job options
const DEFAULT_JOB_OPTIONS = {
    attempts: 3,
    backoff: { 
        type: 'exponential', 
        delay: 10000 // 10 seconds initial delay, then exponential
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200      // Keep last 200 failed jobs
};

// Create queues
let syncQueue;

// Initialize the queue system
async function initialize(concurrency = 3) {
    // Only create queue if Redis is enabled and available
    if (!config.REDIS_ENABLED) {
        console.log('Queue system disabled: Redis is not enabled in configuration.');
        return false;
    }

    try {
        // Check Redis connection
        const redisAvailable = await isRedisAvailable();
        if (!redisAvailable) {
            console.error('Queue system initialization failed: Redis is not available.');
            return false;
        }
        
        // Create the queue
        syncQueue = new Queue(QUEUE_NAMES.WATCHLIST_SYNC, config.REDIS_URL);
        
        // Set up queue event handlers
        setupQueueEvents(syncQueue);
        
        console.log('Job queue system initialized successfully.');
        return true;
    } catch (error) {
        console.error('Failed to initialize job queue system:', error);
        return false;
    }
}

// Setup queue event handlers for monitoring
function setupQueueEvents(queue) {
    queue.on('error', (error) => {
        console.error(`Queue error: ${error}`);
    });
    
    if (config.VERBOSE_DB_LOGGING) {
        queue.on('completed', (job) => {
            console.log(`Job ${job.id} completed for user ${job.data.userId}`);
        });
        
        queue.on('failed', (job, error) => {
            console.error(`Job ${job.id} failed for user ${job.data.userId}: ${error.message}`);
        });
        
        queue.on('stalled', (job) => {
            console.warn(`Job ${job.id} stalled for user ${job.data.userId}`);
        });
    }
}

/**
 * Schedule a watchlist sync job for a user
 * @param {string} userId - The IMDb user ID
 * @param {string} priority - Priority level: 'high', 'normal', or 'low'
 * @param {Object} options - Additional job options
 * @returns {Promise<Object|null>} - The created job or null if queue isn't ready
 */
async function scheduleUserSync(userId, priority = 'normal', options = {}) {
    if (!syncQueue) {
        console.warn(`Cannot schedule sync for user ${userId}: Queue not initialized`);
        return null;
    }
    
    // Map string priority to numerical value
    let priorityValue;
    switch (priority.toLowerCase()) {
        case 'high':
            priorityValue = PRIORITY.HIGH;
            break;
        case 'low':
            priorityValue = PRIORITY.LOW;
            break;
        case 'normal':
        default:
            priorityValue = PRIORITY.NORMAL;
    }
    
    // Combine default options with provided options
    const jobOptions = {
        ...DEFAULT_JOB_OPTIONS,
        ...options,
        priority: priorityValue
    };
    
    // Add job to queue
    try {
        const job = await syncQueue.add({ userId, timestamp: Date.now() }, jobOptions);
        if (config.VERBOSE_DB_LOGGING) {
            console.log(`Scheduled sync for user ${userId} with priority ${priority} (${priorityValue})`);
        }
        return job;
    } catch (error) {
        console.error(`Failed to schedule sync for user ${userId}:`, error);
        return null;
    }
}

/**
 * Get the watchlist sync queue
 * @returns {Object|null} - The Bull queue instance or null if not initialized
 */
function getSyncQueue() {
    return syncQueue;
}

/**
 * Check if a user has an active job in the queue
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<boolean>} - Whether the user has an active job
 */
async function hasActiveJob(userId) {
    if (!syncQueue) return false;
    
    try {
        // Get active jobs (waiting and active)
        const waitingJobs = await syncQueue.getWaiting();
        const activeJobs = await syncQueue.getActive();
        const delayedJobs = await syncQueue.getDelayed();
        
        // Combine all jobs
        const allJobs = [...waitingJobs, ...activeJobs, ...delayedJobs];
        
        // Check if any job has this userId
        return allJobs.some(job => job.data && job.data.userId === userId);
    } catch (error) {
        console.error(`Error checking active jobs for user ${userId}:`, error);
        return false;
    }
}

/**
 * Get queue statistics
 * @returns {Promise<Object>} - Queue statistics
 */
async function getQueueStats() {
    if (!syncQueue) {
        return {
            isActive: false,
            stats: null
        };
    }
    
    try {
        const [counts, failedCount, completedCount, activeCount, delayedCount, waitingCount] = await Promise.all([
            syncQueue.getJobCounts(),
            syncQueue.getFailedCount(),
            syncQueue.getCompletedCount(),
            syncQueue.getActiveCount(),
            syncQueue.getDelayedCount(),
            syncQueue.getWaitingCount()
        ]);
        
        return {
            isActive: true,
            stats: {
                counts,
                failedCount,
                completedCount,
                activeCount,
                delayedCount,
                waitingCount
            }
        };
    } catch (error) {
        console.error('Error getting queue statistics:', error);
        return {
            isActive: true,
            stats: null,
            error: error.message
        };
    }
}

/**
 * Clear all jobs from the queue (emergency cleanup)
 * @returns {Promise<Object>} - Cleanup results
 */
async function clearAllJobs() {
    if (!syncQueue) {
        return { success: false, message: 'Queue not initialized' };
    }
    
    try {
        console.log('Starting emergency queue cleanup...');
        
        // Get current stats before cleanup
        const statsBefore = await getQueueStats();
        console.log('Queue stats before cleanup:', statsBefore.stats);
        
        // Clear all job types using correct Bull API syntax
        await Promise.all([
            syncQueue.clean(0, 'completed'),   // Remove completed jobs older than 0ms
            syncQueue.clean(0, 'failed'),      // Remove failed jobs older than 0ms
        ]);
        
        // Handle waiting and delayed jobs differently
        const waitingJobs = await syncQueue.getWaiting();
        const delayedJobs = await syncQueue.getDelayed();
        const activeJobs = await syncQueue.getActive();
        
        // Remove waiting jobs
        for (const job of waitingJobs) {
            await job.remove();
        }
        
        // Remove delayed jobs (these are the problematic staggered jobs)
        for (const job of delayedJobs) {
            await job.remove();
        }
        
        // Remove active jobs
        for (const job of activeJobs) {
            await job.remove();
        }
        
        // Get stats after cleanup
        const statsAfter = await getQueueStats();
        console.log('Queue stats after cleanup:', statsAfter.stats);
        
        console.log('Emergency queue cleanup completed successfully');
        return { 
            success: true, 
            message: 'Queue cleared successfully',
            before: statsBefore.stats,
            after: statsAfter.stats
        };
    } catch (error) {
        console.error('Error during queue cleanup:', error);
        return { 
            success: false, 
            message: `Queue cleanup failed: ${error.message}`,
            error: error.message
        };
    }
}

/**
 * Close the queue connection
 * @returns {Promise<void>}
 */
async function closeQueue() {
    if (syncQueue) {
        try {
            await syncQueue.close();
            console.log('Job queue closed');
            syncQueue = null; // Properly nullify the queue after closing
        } catch (error) {
            console.error('Error closing job queue:', error);
        }
    }
}

module.exports = {
    initialize,
    scheduleUserSync,
    getSyncQueue,
    hasActiveJob,
    getQueueStats,
    clearAllJobs,
    closeQueue,
    PRIORITY
}; 