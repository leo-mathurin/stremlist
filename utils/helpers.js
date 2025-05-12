/**
 * Helper function to determine the correct protocol for URLs
 * @param {Object} req - Express request object
 * @returns {string} - Protocol ('http' or 'https')
 */
function getProtocol(req) {
    // Use HTTPS for production domains or if forwarded from HTTPS
    if (req.get('host').includes('stremlist.com') || 
        req.get('x-forwarded-proto') === 'https') {
        return 'https';
    }
    return req.protocol;
}

/**
 * Helper function to set CORS headers and respond with JSON
 * @param {Object} res - Express response object
 * @param {any} data - Data to send in the response
 * @param {number} [statusCode=200] - HTTP status code (optional)
 */
function respond(res, data, statusCode = 200) {
    // Check if response has already been sent
    if (res.headersSent) {
        console.warn('Attempted to respond multiple times to the same request');
        return;
    }

    // Set status code first
    res.status(statusCode);
    
    try {
        // Try to set headers
        if (typeof res.setHeader === 'function') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Content-Type', 'application/json');
            
            // Set cache control to no-cache for manifest endpoints to prevent stale configuration state
            if (res.req && res.req.path && res.req.path.endsWith('manifest.json')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            } else {
                res.setHeader('Cache-Control', 'max-age=86400'); // one day for non-manifest endpoints
            }
        } else {
            // Use header method if setHeader is not available
            if (typeof res.header === 'function') {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Headers', '*');
                res.header('Content-Type', 'application/json');
                
                // Set cache control
                if (res.req && res.req.path && res.req.path.endsWith('manifest.json')) {
                    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.header('Pragma', 'no-cache');
                    res.header('Expires', '0');
                } else {
                    res.header('Cache-Control', 'max-age=86400');
                }
            }
        }
    } catch (err) {
        console.error('Error setting headers:', err.message);
    }
    
    // Send the response
    try {
        res.send(data);
    } catch (err) {
        console.error('Error sending response:', err.message);
        // Try with json method if send fails
        if (typeof res.json === 'function') {
            res.json(data);
        }
    }
}

/**
 * Helper function to activate a user ID for syncing
 * @param {string} userId - The IMDb user ID
 * @param {Set} syncedUsers - Set of synced user IDs
 * @param {Object} db - Database interface
 * @param {Function} startBackgroundSync - Function to start background sync
 * @param {Object} syncIntervalId - Interval ID for sync 
 * @returns {boolean} - Success status
 */
function activateUserForSync(userId, syncedUsers, db, startBackgroundSync, syncIntervalId) {
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

module.exports = {
    getProtocol,
    respond,
    activateUserForSync
}; 