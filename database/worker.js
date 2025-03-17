/**
 * Worker system for processing watchlist sync jobs
 * Consumes jobs from the Bull queue and updates watchlists
 */

const { getSyncQueue } = require('./job-queue');
const config = require('./config');
const { updateUserActivity } = require('./redis-handler');

// Import these functions from your existing code that handles IMDb watchlist fetching
// This is a placeholder - replace with your actual functions
let fetchImdbWatchlist, storeWatchlistData;

// Worker stats
const workerStats = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    startTime: null,
    lastJobTime: null
};

/**
 * Initialize the worker by loading required dependencies and configuring it
 * @param {Object} dependencies - Object containing required functions
 * @param {Function} dependencies.fetchWatchlist - Function to fetch watchlist data
 * @param {Function} dependencies.storeWatchlist - Function to store watchlist data
 * @returns {boolean} - Whether initialization was successful
 */
function initializeWorker(dependencies) {
    if (!dependencies || !dependencies.fetchWatchlist || !dependencies.storeWatchlist) {
        console.error('Worker initialization failed: Missing required dependencies');
        return false;
    }
    
    // Set the dependencies
    fetchImdbWatchlist = dependencies.fetchWatchlist;
    storeWatchlistData = dependencies.storeWatchlist;
    
    // Reset stats
    workerStats.processed = 0;
    workerStats.succeeded = 0;
    workerStats.failed = 0;
    workerStats.startTime = Date.now();
    
    console.log('Worker initialized successfully');
    return true;
}

/**
 * Start processing jobs with the specified concurrency
 * @param {number} concurrency - Number of jobs to process concurrently
 * @returns {Promise<boolean>} - Whether worker started successfully
 */
async function startWorker(concurrency = 3) {
    const queue = getSyncQueue();
    if (!queue) {
        console.error('Worker start failed: Queue not initialized');
        return false;
    }
    
    if (!fetchImdbWatchlist || !storeWatchlistData) {
        console.error('Worker start failed: Worker not initialized with required dependencies');
        return false;
    }
    
    try {
        // Register the processor function
        queue.process(concurrency, processWatchlistJob);
        console.log(`Worker started with concurrency ${concurrency}`);
        return true;
    } catch (error) {
        console.error('Failed to start worker:', error);
        return false;
    }
}

/**
 * Process a watchlist sync job
 * @param {Object} job - The Bull job to process
 * @returns {Promise<Object>} - Result of the job processing
 */
async function processWatchlistJob(job) {
    const { userId } = job.data;
    workerStats.lastJobTime = Date.now();
    workerStats.processed++;
    
    try {
        // Log job start
        job.progress(10);
        if (config.VERBOSE_DB_LOGGING) {
            console.log(`Processing sync job for user ${userId}`);
        }
        
        // Fetch the watchlist from IMDb
        job.progress(30);
        const watchlistData = await fetchImdbWatchlist(userId);
        
        // Update user activity timestamp in Redis
        await updateUserActivity(userId);
        
        // Store the fetched data
        job.progress(80);
        await storeWatchlistData(userId, watchlistData);
        
        // Mark job complete
        job.progress(100);
        workerStats.succeeded++;
        
        return {
            success: true,
            userId,
            timestamp: Date.now(),
            itemCount: watchlistData.items ? watchlistData.items.length : 0
        };
    } catch (error) {
        workerStats.failed++;
        console.error(`Job failed for user ${userId}:`, error);
        
        // Rethrow the error to let Bull handle retries
        throw new Error(`Watchlist sync failed for ${userId}: ${error.message}`);
    }
}

/**
 * Get worker statistics
 * @returns {Object} - Current worker statistics
 */
function getWorkerStats() {
    const now = Date.now();
    const uptime = workerStats.startTime ? now - workerStats.startTime : 0;
    const idleTime = workerStats.lastJobTime ? now - workerStats.lastJobTime : uptime;
    
    return {
        ...workerStats,
        uptime,
        idleTime,
        isIdle: workerStats.lastJobTime === null || idleTime > 30000 // 30 seconds
    };
}

module.exports = {
    initializeWorker,
    startWorker,
    getWorkerStats
}; 