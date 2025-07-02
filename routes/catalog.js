const express = require('express');
const router = express.Router();

module.exports = function(manifest, db, getWatchlist, respond, activateUser = null, getUserConfig = null) {
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
    
    // Default activateUser function if not provided
    if (!activateUser) {
        activateUser = () => true;
    }

    // User-specific catalog endpoint
    router.get('/:userId/catalog/:type/:id.json', async (req, res) => {
        const userId = req.params.userId;
        const type = req.params.type;
        
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
            
            // Filter metas by type
            const metas = watchlistData.metas.filter(item => item.type === type);
            
            // Log what we're serving for debugging
            console.log(`Serving catalog for user ${userId}, type: ${type}, found: ${metas.length} items, sorted by: ${userConfig.sortOption || 'default'}`);
            if (metas.length > 0 && typeof console.verbose === 'function') {
                console.verbose(`First catalog item example: ${JSON.stringify(metas[0], null, 2)}`);
            }
            
            // Respond with the filtered data and Stremio caching headers
            respond(res, { 
                metas,
                cacheMaxAge: 6 * 60 * 60,        // 6 hours
                staleRevalidate: 2 * 60 * 60,    // 2 hours  
                staleError: 24 * 60 * 60         // 24 hours
            });
        } catch (err) {
            fail(`Error serving catalog: ${err.message}`);
        }
    });

    return router;
}; 