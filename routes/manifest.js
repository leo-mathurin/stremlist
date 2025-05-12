const express = require('express');
const router = express.Router();

module.exports = function(manifest, db, respond, getProtocol, getWatchlist = null, activateUser = null, getUserConfig = null, ADDON_VERSION = null) {
    // Get the addon version from the manifest if not provided
    ADDON_VERSION = ADDON_VERSION || manifest.version;

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

    // User-specific manifest endpoint
    router.get('/:userId/manifest.json', async (req, res) => {
        const userId = req.params.userId;
        console.log(`Serving user-specific manifest for: ${userId}`);
        
        try {
            // First validate if the user exists and has a watchlist
            if (getWatchlist) {
                await getWatchlist(userId);
            }
            
            // Get user configuration
            const userConfig = await getUserConfig(userId, req);
            
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

            // Update configuration with user's current choices
            if (userManifest.config) {
                userManifest.config.forEach(configItem => {
                    if (configItem.key === 'sortOption') {
                        // Make sure we have a valid sort option from user config
                        if (userConfig && userConfig.sortOption) {
                            console.log(`Setting default sort option in manifest to: ${userConfig.sortOption}`);
                            configItem.default = userConfig.sortOption;
                        } else {
                            console.log(`No user sort preference found, using default: ${configItem.default}`);
                        }
                    }
                });
            }
            
            // Configurable but not required
            userManifest.behaviorHints = {
                configurable: true,
                configurationRequired: false
            };
            
            // Set the self URL to ensure it uses HTTPS for production
            // BUT remove any configuration parameters to ensure consistent addon ID
            const protocol = getProtocol(req);
            
            // Important: always use a clean URL without query parameters as selfUrl
            // This ensures Stremio sees this as the same addon regardless of configuration
            userManifest.selfUrl = `${protocol}://${req.get('host')}/${userId}/manifest.json`;
            
            // Activate this user for background syncing
            if (activateUser) {
                activateUser(userId);
            }
            
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

    // Root endpoint returns the base manifest (without user data)
    router.get('/manifest.json', (req, res) => {
        console.log(`Serving base manifest (requires configuration)`);
        
        // Create a copy of the manifest to modify
        const baseManifest = JSON.parse(JSON.stringify(manifest));
        
        // Set the self URL for the base manifest to ensure it uses HTTPS for production
        const protocol = getProtocol(req);
        baseManifest.selfUrl = `${protocol}://${req.get('host')}/manifest.json`;
        
        // For basic manifest, we want configuration to be required
        baseManifest.behaviorHints = {
            configurable: true,
            configurationRequired: true
        };
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(baseManifest);
    });

    // Configure page - this will redirect to our web UI
    router.get('/configure', (req, res) => {
        res.redirect('/');
    });

    // User-specific configure page - also redirects to our web UI
    router.get('/:userId/configure', (req, res) => {
        // Activate this user for background syncing
        if (activateUser) {
            activateUser(req.params.userId);
        }
        
        // Pass the userId as a query parameter to pre-populate the form
        res.redirect(`/?userId=${req.params.userId}`);
    });

    return router;
}; 