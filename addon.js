const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchWatchlist } = require('./scripts/fetch_watchlist');
const db = require('./database');
const config = require('./database/config');

// Define the addon version in one place
const ADDON_VERSION = '1.1.1';

// Create addon server
const app = express();

// Configure logging
let logCount = 0;
const MAX_LOGS_BEFORE_ROTATION = parseInt(process.env.MAX_LOGS_BEFORE_ROTATION || 1000);
const VERBOSE_MODE = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Override console.log to add timestamps and handle log rotation
console.log = function() {
    logCount++;
    if (logCount > MAX_LOGS_BEFORE_ROTATION) {
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
    if (!VERBOSE_MODE) {
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
originalConsoleLog(`[${new Date().toISOString()}] Starting addon ${VERBOSE_MODE ? 'in verbose mode' : 'in default mode'}`);

// Use configuration from centralized config module (convert seconds to milliseconds)
const SYNC_INTERVAL = config.SYNC_INTERVAL * 1000;
const CACHE_TTL = config.CACHE_TTL * 1000;

// Track syncing state
let syncIntervalId = null;
const syncedUsers = new Set(); // Local reference for quick lookups, persisted to DB

// Base manifest without user data
const manifest = {
    id: 'com.stremlist',
    version: ADDON_VERSION,
    name: 'Stremlist',
    description: 'Your IMDb Watchlist in Stremio',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    catalogs: [
        {
            id: 'stremlist-movies',
            name: 'Stremlist Movies',
            type: 'movie'
        },
        {
            id: 'stremlist-series',
            name: 'Stremlist Series', 
            type: 'series'
        }
    ],
    logo: 'https://stremlist.com/icon.png',
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

// Helper function to determine the correct protocol for URLs
function getProtocol(req) {
    // Use HTTPS for production domains or if forwarded from HTTPS
    if (req.get('host').includes('stremlist.com') || 
        req.get('x-forwarded-proto') === 'https') {
        return 'https';
    }
    return req.protocol;
}

// Helper function to set CORS headers and respond with JSON
function respond(res, data) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    // Set cache control to no-cache for manifest endpoints to prevent stale configuration state
    if (res.req.path.endsWith('manifest.json')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    } else {
        res.setHeader('Cache-Control', 'max-age=86400'); // one day for non-manifest endpoints
    }
    res.send(data);
}

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

// Simple rate limiter middleware
const rateLimit = {};
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 100; // 100 requests per 15 minutes

function rateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();
    
    // Initialize or clear old rate limit data
    if (!rateLimit[ip] || rateLimit[ip].resetTime < now) {
        rateLimit[ip] = {
            count: 0,
            resetTime: now + RATE_LIMIT_WINDOW
        };
    }
    
    // Increment request count
    rateLimit[ip].count++;
    
    // If limit exceeded, return 429 Too Many Requests
    if (rateLimit[ip].count > MAX_REQUESTS_PER_WINDOW) {
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Rate limit exceeded. Please try again later.'
        });
    }
    
    next();
}

// Apply rate limiter to all requests
app.use(rateLimiter);

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
    
    console.log(`Starting background sync with interval of ${SYNC_INTERVAL/60000} minutes`);
    console.log(`Cache TTL: ${CACHE_TTL/60000} minutes`);
    
    // Run an initial sync immediately
    console.log('Running initial sync...');
    syncAllWatchlists().then(() => {
        console.log('Initial sync completed');
    }).catch(err => {
        console.error('Error during initial sync:', err);
    });
    
    // Then set up the interval for future syncs
    syncIntervalId = setInterval(syncAllWatchlists, SYNC_INTERVAL);
    console.log(`Background sync scheduled for every ${SYNC_INTERVAL/60000} minutes`);
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
async function getWatchlist(userId, forceRefresh = false) {
    // Update user activity timestamp in the database
    await db.updateUserActivity(userId);
    
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
        console.log(`Cache for ${userId} is ${cacheAge} minutes old (TTL: ${CACHE_TTL/60000} minutes)`);
    }
    
    // Force refresh ignores cache, or check if cache doesn't exist or is older than TTL
    if (forceRefresh || !cachedData || cachedData.timestamp < Date.now() - CACHE_TTL) {
        console.log(`${forceRefresh ? 'Force refreshing' : 'Cache expired, refreshing'} watchlist for user ${userId}...`);
        
        try {
            // Use the rate limiter to fetch the watchlist
            const watchlistData = await db.makeRateLimitedRequest(async () => {
                return await fetchWatchlist(userId);
            });
            
            // Log the watchlist content details in verbose mode
            if (watchlistData && watchlistData.metas) {
                const movies = watchlistData.metas.filter(item => item.type === 'movie');
                const series = watchlistData.metas.filter(item => item.type === 'series');
                console.verbose(`Fetched ${watchlistData.metas.length} items (${movies.length} movies, ${series.length} series)`);
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

// Helper function to activate a user ID for syncing
function activateUserForSync(userId) {
    if (!userId || typeof userId !== 'string' || !userId.startsWith('ur')) {
        return false; // Invalid user ID
    }

    // Track this user for syncing
    if (!syncedUsers.has(userId)) {
        syncedUsers.add(userId);
        console.log(`Activated user ${userId} for syncing (total users: ${syncedUsers.size})`);
        
        // Persist to database
        db.storeActiveUsers(syncedUsers);
        db.updateUserActivity(userId);
        
        // Start background sync if it's not already running
        if (!syncIntervalId) {
            startBackgroundSync();
        }
        return true;
    }
    
    // Just update the timestamp for existing users
    db.updateUserActivity(userId);
    return true;
}

// ==========================================
// IMPORTANT: Order of routes matters in Express
// More specific routes should come first
// ==========================================

// User-specific manifest endpoint - MUST BE DEFINED BEFORE GENERIC ROUTES
app.get('/:userId/manifest.json', async (req, res) => {
    const userId = req.params.userId;
    console.log(`Serving user-specific manifest for: ${userId}`);
    
    try {
        // First validate if the user exists and has a watchlist
        await getWatchlist(userId);
        
        // Only proceed with manifest if user is valid
        // Clone the manifest and customize it for this user
        const userManifest = JSON.parse(JSON.stringify(manifest));
        userManifest.id = `com.stremlist.${userId}`;
        userManifest.version = ADDON_VERSION; // Use the same version constant
        
        // Set the name WITHOUT the user ID
        userManifest.name = 'Stremlist';
        
        // Put the user ID in the description instead and add changelog link
        userManifest.description = `Your IMDb Watchlist for user ${userId}. See changelog at https://stremlist.com/changelog`;
        
        // Update catalog IDs to be specific to this user
        userManifest.catalogs = userManifest.catalogs.map(catalog => {
            return {
                ...catalog,
                id: `${catalog.id}-${userId}`
            };
        });

        // Remove configuration hints since we have a valid user ID
        userManifest.behaviorHints = {
            configurable: false,
            configurationRequired: false
        };
        
        // Set the self URL to ensure it uses HTTPS for production
        const protocol = getProtocol(req);
        userManifest.selfUrl = `${protocol}://${req.get('host')}/${userId}/manifest.json`;
        
        // Activate this user for background syncing
        activateUserForSync(userId);
        
        respond(res, userManifest);
    } catch (err) {
        console.error(`Error serving manifest for ${userId}:`, err.message);
        // If user is invalid, serve the base manifest that requires configuration
        const baseManifest = JSON.parse(JSON.stringify(manifest));
        baseManifest.behaviorHints = {
            configurable: true,
            configurationRequired: true
        };
        // Set the self URL for the base manifest too
        const protocol = getProtocol(req);
        baseManifest.selfUrl = `${protocol}://${req.get('host')}/manifest.json`;
        
        respond(res, baseManifest);
    }
});

// User-specific catalog endpoint
app.get('/:userId/catalog/:type/:id.json', async (req, res) => {
    const userId = req.params.userId;
    const type = req.params.type;
    
    // Activate this user for background syncing
    activateUserForSync(userId);
    
    // Handle failures
    function fail(err) {
        console.error(err);
        res.status(500);
        respond(res, { err: 'handler error' });
    }

    try {
        // Get the watchlist data
        const watchlistData = await getWatchlist(userId);
        
        // Filter metas by type
        const metas = watchlistData.metas.filter(item => item.type === type);
        
        // Log what we're serving for debugging
        console.log(`Serving catalog for user ${userId}, type: ${type}, found: ${metas.length} items`);
        if (metas.length > 0 && typeof console.verbose === 'function') {
            console.verbose(`First catalog item example: ${JSON.stringify(metas[0], null, 2)}`);
        }
        
        // Respond with the filtered data
        respond(res, { metas });
    } catch (err) {
        fail(`Error serving catalog: ${err.message}`);
    }
});

// User-specific meta endpoint to fetch detailed metadata for an item
app.get('/:userId/meta/:type/:id.json', async (req, res) => {
    const userId = req.params.userId;
    const type = req.params.type;
    const id = req.params.id;
    
    // Activate this user for background syncing
    activateUserForSync(userId);
    
    // Handle failures
    function fail(err) {
        console.error(err);
        res.status(500);
        respond(res, { err: 'handler error' });
    }

    try {
        // Get the watchlist data
        const watchlistData = await getWatchlist(userId);
        
        // Find the specific item by ID
        const item = watchlistData.metas.find(item => item.id === id && item.type === type);
        
        if (!item) {
            // If item not found in watchlist
            console.error(`Meta not found for ${type}/${id} in user ${userId}'s watchlist`);
            return respond(res, { meta: null });
        }
        
        console.log(`Serving meta for ${userId}, type: ${type}, id: ${id}`);
        
        // Return the meta object
        respond(res, { meta: item });
    } catch (err) {
        fail(`Error serving meta: ${err.message}`);
    }
});

// Root endpoint returns the base manifest (without user data)
app.get('/manifest.json', (req, res) => {
    console.log(`Serving base manifest (requires configuration)`);
    
    // Create a copy of the manifest to modify
    const baseManifest = JSON.parse(JSON.stringify(manifest));
    
    // Set the self URL for the base manifest to ensure it uses HTTPS for production
    const protocol = getProtocol(req);
    baseManifest.selfUrl = `${protocol}://${req.get('host')}/manifest.json`;
    
    respond(res, baseManifest);
});

// Configure page - this will redirect to our web UI
app.get('/configure', (req, res) => {
    res.redirect('/');
});

// User-specific configure page - also redirects to our web UI
app.get('/:userId/configure', (req, res) => {
    // Activate this user for background syncing
    activateUserForSync(req.params.userId);
    
    // Pass the userId as a query parameter to pre-populate the form
    res.redirect(`/?userId=${req.params.userId}`);
});

// API endpoint to validate if an IMDb user ID exists and has a watchlist
app.get('/api/validate/:userId', async (req, res) => {
    const userId = req.params.userId;
    
    try {
        // Try to fetch the watchlist to validate the user ID
        await getWatchlist(userId);
        respond(res, { valid: true });
    } catch (err) {
        console.error(`Validation error for ${userId}: ${err.message}`);
        respond(res, { valid: false, error: err.message });
    }
});

// Debug endpoint to check if manifests are properly served
app.get('/api/debug/:userId', (req, res) => {
    const userId = req.params.userId;
    
    // Get the protocol, preferring HTTPS for production domains
    const protocol = (req.get('host').includes('stremlist.com') || 
                     req.get('x-forwarded-proto') === 'https') ? 'https' : req.protocol;
    
    // Return details about the URLs and their expected behavior
    respond(res, {
        userManifestUrl: `${protocol}://${req.get('host')}/${userId}/manifest.json`,
        baseManifestUrl: `${protocol}://${req.get('host')}/manifest.json`,
        stremioProtocolUrl: `stremio://${req.get('host')}/${userId}/manifest.json`,
        message: "Use these URLs to test different configurations. The userManifestUrl should work directly in Stremio."
    });
});

// API endpoint to get storage stats
app.get('/api/stats', async (req, res) => {
    try {
        // Get stats
        const activeUsers = await db.getActiveUsers();
        const cachedUserIds = await db.getCachedUserIds();
        const storageType = await db.checkHealth();
        const redisIsAvailable = await db.isRedisAvailable();
        const redisActiveConnections = redisIsAvailable ? await db.getActiveConnectionsCount() : 0;
        
        respond(res, {
            activeUsers: activeUsers.length,
            cachedUsers: cachedUserIds.length,
            storageType,
            syncActive: syncIntervalId !== null,
            syncInterval: SYNC_INTERVAL / 60000,
            cacheTTL: CACHE_TTL / 60000,
            redis: {
                available: redisIsAvailable,
                activeConnections: redisActiveConnections
            }
        });
    } catch (err) {
        console.error(`Error getting stats: ${err.message}`);
        respond(res, { error: err.message });
    }
});

// Route for the web interface homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add health check endpoint for monitoring and Docker health checks
app.get('/health', async (req, res) => {
    try {
        // Check database/Redis connectivity
        const dbBackend = await db.checkHealth();
        const isRedisActive = db.isRedisActive();
        
        if (isRedisActive) {
            // All systems operational with Redis
            return res.status(200).json({
                status: 'healthy',
                redis: 'connected',
                backend: dbBackend,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        } else {
            // Redis is down, but memory fallback is working
            return res.status(207).json({
                status: 'degraded',
                redis: 'disconnected',
                backend: 'memory',
                message: 'Redis unavailable, using memory fallback',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        // Critical system failure
        return res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    }
});

// Add Redis monitoring endpoint
app.get('/api/redis-stats', async (req, res) => {
    try {
        const redisIsAvailable = await db.isRedisAvailable();
        
        if (!redisIsAvailable) {
            return respond(res, {
                available: false,
                error: 'Redis is not available'
            });
        }
        
        // Get Redis info
        const activeConnections = await db.getActiveConnectionsCount();
        const activeUsers = await db.getActiveUsers();
        const cachedUserIds = await db.getCachedUserIds();
        const activityTimestamps = await db.getUserActivityTimestamps();
        
        // Calculate active users in the last hour
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);
        const activeInLastHour = Object.values(activityTimestamps).filter(
            timestamp => timestamp > oneHourAgo
        ).length;
        
        respond(res, {
            available: true,
            activeConnections,
            userStats: {
                total: cachedUserIds.length,
                activeUsers: activeUsers.length,
                activeInLastHour
            },
            timestamp: now
        });
    } catch (err) {
        console.error(`Error getting Redis stats: ${err.message}`);
        respond(res, { error: err.message });
    }
});

// Start the server
const PORT = process.env.PORT || 7001;

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