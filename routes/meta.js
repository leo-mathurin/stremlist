const express = require('express');
const router = express.Router();

module.exports = function(manifest, db, respond, getWatchlist = null, activateUser = null, getUserConfig = null) {
    // Default getUserConfig function if not provided
    if (!getUserConfig) {
        getUserConfig = async (userId, req) => {
            try {
                return await global.db.getUserConfig(userId) || {}; 
            } catch (e) {
                return {};
            }
        };
    }
    
    // Default getWatchlist function if not provided
    if (!getWatchlist) {
        getWatchlist = async (userId, forceRefresh = false, sortOption = null) => {
            try {
                const data = await global.db.getCachedWatchlist(userId);
                return data ? data.data : { metas: [] };
            } catch (e) {
                return { metas: [] };
            }
        };
    }
    
    // Default activateUser function if not provided
    if (!activateUser) {
        activateUser = () => true;
    }

    // User-specific meta endpoint to fetch detailed metadata for an item
    router.get('/:userId/meta/:type/:id.json', async (req, res) => {
        const userId = req.params.userId;
        const type = req.params.type;
        const id = req.params.id;
        
        // Activate this user for background syncing
        if (activateUser) {
            activateUser(userId);
        }
        
        // Handle failures
        function fail(err) {
            console.error(err);
            res.status(500);
            respond(res, { err: 'handler error' });
        }

        try {
            // Get user configuration
            const userConfig = await getUserConfig(userId, req);
            
            // Get the watchlist data with the user's sorting preference
            const watchlistData = await getWatchlist(userId, false, userConfig.sortOption);
            
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

    return router;
}; 