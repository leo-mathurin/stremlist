const express = require('express');
const router = express.Router();
const constants = require('../constants');

module.exports = function(db, getWatchlist, respond, getProtocol, options = {}) {
    // Get sync interval ID from options
    const { syncIntervalId } = options;
    
    // API endpoint to validate if an IMDb user ID exists and has a watchlist
    router.get('/api/validate/:userId', async (req, res) => {
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

    // API endpoint to force refresh a user's watchlist
    router.get('/api/refresh/:userId', async (req, res) => {
        const userId = req.params.userId;
        
        try {
            // Extract sort options from configuration parameter if provided
            let sortOption = null;
            if (req.query.configuration) {
                try {
                    const config = JSON.parse(decodeURIComponent(req.query.configuration));
                    sortOption = config.sortOption;
                    console.log(`Refreshing with sort option: ${sortOption}`);
                } catch (e) {
                    console.error(`Error parsing configuration for refresh: ${e.message}`);
                }
            }
            
            // Force refresh the watchlist with forceRefresh=true and pass the sort option
            await getWatchlist(userId, true, sortOption);
            
            respond(res, { 
                success: true, 
                message: 'Watchlist refreshed successfully',
                sortApplied: sortOption || 'default'
            });
        } catch (err) {
            console.error(`Refresh error for ${userId}: ${err.message}`);
            respond(res, { 
                success: false, 
                error: err.message 
            });
        }
    });

    // Debug endpoint to check if manifests are properly served
    router.get('/api/debug/:userId', (req, res) => {
        const userId = req.params.userId;
        
        // Get the protocol, preferring HTTPS for production domains
        const protocol = getProtocol(req);
        
        // Return details about the URLs and their expected behavior
        respond(res, {
            userManifestUrl: `${protocol}://${req.get('host')}/${userId}/manifest.json`,
            baseManifestUrl: `${protocol}://${req.get('host')}/manifest.json`,
            stremioProtocolUrl: `stremio://${req.get('host')}/${userId}/manifest.json`,
            message: "Use these URLs to test different configurations. The userManifestUrl should work directly in Stremio."
        });
    });

    // API endpoint to get storage stats
    router.get('/api/stats', async (req, res) => {
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
                syncInterval: constants.SYNC_INTERVAL / 60, // Convert to minutes
                cacheTTL: constants.CACHE_TTL / 60, // Convert to minutes
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

    // API endpoint to save user configuration
    router.post('/api/config/:userId', express.json(), async (req, res) => {
        const userId = req.params.userId;
        const config = req.body;
        
        try {
            // Validate configuration
            if (!config || typeof config !== 'object') {
                return respond(res, { success: false, error: 'Invalid configuration format' }, 400);
            }
            
            // Make sure the sortOption is valid
            if (config.sortOption && !config.sortOption.match(/^(title|year|rating)-(asc|desc)$/)) {
                return respond(res, { success: false, error: 'Invalid sort option format' }, 400);
            }
            
            // Save the configuration
            const saved = await db.saveUserConfig(userId, config);
            
            if (saved) {
                // Also trigger a refresh with the new configuration
                const sortOption = config.sortOption;
                await getWatchlist(userId, true, sortOption);
                
                respond(res, { 
                    success: true, 
                    message: 'Configuration saved and watchlist refreshed',
                    config
                });
            } else {
                respond(res, { 
                    success: false, 
                    error: 'Failed to save configuration'
                }, 500);
            }
        } catch (err) {
            console.error(`Error saving config for ${userId}: ${err.message}`);
            respond(res, { success: false, error: err.message }, 500);
        }
    });

    // Add health check endpoint for monitoring and Docker health checks
    router.get('/health', async (req, res) => {
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
    router.get('/api/redis-stats', async (req, res) => {
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

    return router;
}; 