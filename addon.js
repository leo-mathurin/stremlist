const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchWatchlist } = require('./scripts/fetch_watchlist');
const db = require('./database');
const constants = require('./constants');

// Make db available globally for the getUserConfig function
global.db = db;

// Import utilities
const { getProtocol, respond, activateUserForSync } = require('./utils/helpers');
const { parseSortOption, getUserConfig } = require('./utils/watchlist');
const createRateLimiter = require('./utils/middleware/rateLimiter');

// Import route handlers
const manifestRoutes = require('./routes/manifest');
const catalogRoutes = require('./routes/catalog');
const metaRoutes = require('./routes/meta');
const apiRoutes = require('./routes/api');
const staticRoutes = require('./routes/static');

// Create addon server
const app = express();

// Configure logging
let logCount = 0;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Override console.log to add timestamps and handle log rotation
console.log = function() {
    logCount++;
    if (logCount > constants.MAX_LOGS_BEFORE_ROTATION) {
        // Clear console and reset counter on rotation (only on non-production environments)
        if (process.env.NODE_ENV !== 'production') {
            console.clear();
            originalConsoleLog('Log rotated due to high volume. Previous logs cleared.');
        }
        logCount = 0;
    }
    
    const timestamp = new Date().toISOString();
    originalConsoleLog.apply(console, [`[${timestamp}]`, ...arguments]);
};

// Add verbose logging function
console.verbose = function() {
    // Only log if verbose mode is enabled
    if (!constants.VERBOSE_MODE) {
        return;
    }
    
    const timestamp = new Date().toISOString();
    originalConsoleLog.apply(console, [`[${timestamp}] VERBOSE:`, ...arguments]);
};

// Override console.error to add timestamps
console.error = function() {
    const timestamp = new Date().toISOString();
    originalConsoleError.apply(console, [`[${timestamp}] ERROR:`, ...arguments]);
};

// Log configuration at startup
originalConsoleLog(`[${new Date().toISOString()}] Starting addon ${constants.VERBOSE_MODE ? 'in verbose mode' : 'in default mode'}`);

// Track syncing state
let syncIntervalId = null;
const syncedUsers = new Set(); // Local reference for quick lookups, persisted to DB

// Initialize database connection
(async function() {
    try {
        const success = await db.initialize();
        if (success) {
            console.log('Database initialized successfully');
            
            // Restore active users from database
            const activeUsers = await db.getActiveUsers();
            console.log(`Loaded ${activeUsers.length} active users from database`);
            
            // Populate local Set for quick access
            activeUsers.forEach(userId => syncedUsers.add(userId));
            
            // Start background sync if we have users
            if (syncedUsers.size > 0) {
                startBackgroundSync();
            }
        } else {
            console.error('Failed to initialize database');
        }
    } catch (error) {
        console.error('Error during database initialization:', error);
    }
})();

// Setup CORS middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Origin', 'Accept']
}));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Add OPTIONS handler for all routes to support CORS preflight
app.options('*', cors());

// Apply rate limiter to all requests
app.use(createRateLimiter());

// Background syncing function
async function syncAllWatchlists() {
    // Check health of database connection
    await db.checkHealth();
    
    // Get all user IDs that have been accessing the addon from recent requests
    const users = [...syncedUsers];
    
    if (users.length === 0) {
        console.log('No known users to sync. Waiting for user connections...');
        return;
    }

    console.log(`===== SYNC STARTED: ${new Date().toISOString()} =====`);
    console.log(`Scheduling sync jobs for ${users.length} users`);
    
    // Persist active users to database
    await db.storeActiveUsers(syncedUsers);
    
    // Calculate user priorities based on activity timestamps
    const userActivityTimestamps = await db.getUserActivityTimestamps();
    
    // Calculate priority for each user based on activity recency
    const priorityCalculator = (userId) => {
        const lastActivity = userActivityTimestamps[userId] || 0;
        const hoursSinceLastActivity = (Date.now() - lastActivity) / (1000 * 60 * 60);
        
        // High priority for recently active users (last 2 hours)
        if (hoursSinceLastActivity <= 2) {
            return 'high';
        }
        // Normal priority for users active in the last 24 hours
        else if (hoursSinceLastActivity <= 24) {
            return 'normal';
        }
        // Low priority for everyone else
        else {
            return 'low';
        }
    };
    
    // Schedule jobs for all users with appropriate priorities
    const result = await db.scheduleBulkSync(users, priorityCalculator);
    
    console.log(`Job scheduling results: ${result.message}`);
    console.log(`===== SYNC SCHEDULED: ${new Date().toISOString()} =====`);
}

// Start the background sync process
function startBackgroundSync() {
    if (syncIntervalId) {
        console.log('Background sync already running');
        return; // Already running
    }
    
    console.log(`Starting background sync with interval of ${constants.SYNC_INTERVAL_MS/60000} minutes`);
    console.log(`Cache TTL: ${constants.CACHE_TTL_MS/60000} minutes`);
    
    // Run an initial sync immediately
    console.log('Running initial sync...');
    syncAllWatchlists().then(() => {
        console.log('Initial sync completed');
    }).catch(err => {
        console.error('Error during initial sync:', err);
    });
    
    // Then set up the interval for future syncs
    syncIntervalId = setInterval(syncAllWatchlists, constants.SYNC_INTERVAL_MS);
    console.log(`Background sync scheduled for every ${constants.SYNC_INTERVAL_MS/60000} minutes`);
}

// Stop the background sync process
function stopBackgroundSync() {
    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
        console.log('Background sync stopped');
    }
}

// Function to get watchlist for an IMDb user
async function getWatchlist(userId, forceRefresh = false, sortOption = null) {
    // Update user activity timestamp in the database
    await db.updateUserActivity(userId);
    
    // If no sort option was provided, try to get it from user config
    if (!sortOption) {
        try {
            const userConfig = await db.getUserConfig(userId);
            if (userConfig && userConfig.sortOption) {
                sortOption = userConfig.sortOption;
                console.log(`Using saved sort option from database: ${sortOption}`);
            }
        } catch (error) {
            console.error(`Error retrieving user sort option: ${error.message}`);
        }
    } else {
        console.log(`Using provided sort option: ${sortOption}`);
    }
    
    // Parse sort option if provided
    const sortOptions = parseSortOption(sortOption);
    
    // Track this user for syncing in local memory for quick access
    if (!syncedUsers.has(userId)) {
        syncedUsers.add(userId);
        console.log(`Added user ${userId} to syncing list (total users: ${syncedUsers.size})`);
        
        // Persist to database
        await db.storeActiveUsers(syncedUsers);
        
        // Start background sync if it's not already running
        if (!syncIntervalId) {
            startBackgroundSync();
        }
        
        // Schedule an immediate sync job for this new user with high priority
        await db.scheduleSyncForUser(userId, 'high');
    }

    // Check if we have a cached watchlist
    const cachedData = await db.getCachedWatchlist(userId);
    
    // Log time since last cache update
    if (cachedData) {
        const cacheAge = Math.round((Date.now() - cachedData.timestamp)/1000/60);
        console.log(`Cache for ${userId} is ${cacheAge} minutes old (TTL: ${constants.CACHE_TTL_MS/60000} minutes)`);
    }
    
    // Force refresh ignores cache, or check if cache doesn't exist or is older than TTL
    if (forceRefresh || !cachedData || cachedData.timestamp < Date.now() - constants.CACHE_TTL_MS) {
        console.log(`${forceRefresh ? 'Force refreshing' : 'Cache expired, refreshing'} watchlist for user ${userId}...`);
        
        try {
            // Use the rate limiter to fetch the watchlist with sorting options
            const watchlistData = await db.makeRateLimitedRequest(async () => {
                return await fetchWatchlist(userId, sortOptions);
            });
            
            // Log the watchlist content details in verbose mode
            if (watchlistData && watchlistData.metas) {
                const movies = watchlistData.metas.filter(item => item.type === 'movie');
                const series = watchlistData.metas.filter(item => item.type === 'series');
                console.verbose(`Fetched ${watchlistData.metas.length} items (${movies.length} movies, ${series.length} series)`);
                console.verbose(`Applied sorting: ${sortOptions.by} - ${sortOptions.order}`);
            }
            
            // Cache the watchlist
            await db.cacheWatchlist(userId, watchlistData);
            
            return watchlistData;
        } catch (error) {
            console.error(`Error fetching watchlist for user ${userId}:`, error);
            
            // If we have a cached version, use it despite being outdated
            if (cachedData) {
                console.log(`Using outdated cache for user ${userId} due to fetch error`);
                return cachedData.data;
            }
            
            // No cache, propagate the error
            throw error;
        }
    } else {
        // Use cached data
        console.log(`Using cached watchlist for user ${userId}`);
        return cachedData.data;
    }
}

// Wrap activateUserForSync for route modules
function activateUser(userId) {
    return activateUserForSync(userId, syncedUsers, db, startBackgroundSync, syncIntervalId);
}

// Register route handlers
app.use(manifestRoutes(constants.BASE_MANIFEST, db, respond, getProtocol));
app.use(catalogRoutes(constants.BASE_MANIFEST, db, getWatchlist, respond));
app.use(metaRoutes(constants.BASE_MANIFEST, db, respond));
app.use(apiRoutes(db, getWatchlist, respond, getProtocol, { syncIntervalId }));
app.use(staticRoutes(constants.BASE_MANIFEST, constants.SORT_OPTIONS, respond));

// Start the server
const PORT = process.env.PORT || constants.DEFAULT_PORT;

// For serverless environments like Vercel
if (process.env.VERCEL || process.env.RENDER) {
    // Export the Express app directly for serverless use
    module.exports = app;
} else {
    // Traditional server startup
    app.listen(PORT, () => {
        console.log(`\nAddon server running at http://127.0.0.1:${PORT}`);
        console.log(`\nTo manually install in Stremio:`);
        console.log(`1. Open Stremio`);
        console.log(`2. Go to the Addons section`);
        console.log(`3. Click "Add Addon URL"`);
        
        // Use HTTPS for production domains
        const isProduction = process.env.NODE_ENV === 'production';
        const protocol = isProduction ? 'https' : 'http';
        const host = isProduction ? 'stremlist.com' : `127.0.0.1:${PORT}`;
        console.log(`4. Enter: ${protocol}://${host}/manifest.json`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    stopBackgroundSync();
    console.log('Background sync stopped.');
    
    // Close database connections
    db.closeConnections().then(() => {
        console.log('Database connections closed.');
        // Give time for any pending operations to complete
        setTimeout(() => {
            console.log('Exiting process...');
            process.exit(0);
        }, 1000);
    }).catch(err => {
        console.error('Error closing database connections:', err);
        process.exit(1);
    });
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    stopBackgroundSync();
    console.log('Background sync stopped.');
    
    // Close database connections
    db.closeConnections().then(() => {
        console.log('Database connections closed.');
        // Give time for any pending operations to complete
        setTimeout(() => {
            console.log('Exiting process...');
            process.exit(0);
        }, 1000);
    }).catch(err => {
        console.error('Error closing database connections:', err);
        process.exit(1);
    });
}); 