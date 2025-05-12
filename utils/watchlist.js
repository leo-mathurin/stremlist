const constants = require('../constants');

/**
 * Function to parse a sort option string into sort parameters
 * @param {string} sortOption - Sort option in the format "field-order"
 * @returns {Object} - Sort options object with by and order properties
 */
function parseSortOption(sortOption) {
    if (!sortOption) return constants.DEFAULT_SORT_OPTIONS;
    
    const [by, order] = sortOption.split('-');
    if (!by || !['title', 'year', 'rating'].includes(by)) {
        return constants.DEFAULT_SORT_OPTIONS;
    }
    
    if (!order || !['asc', 'desc'].includes(order)) {
        return { by, order: 'asc' };
    }
    
    return { by, order };
}

/**
 * Helper function to get user's configuration, with persistence
 * @param {string} userId - The IMDb user ID
 * @param {Object} req - Express request object
 * @returns {Promise<Object>} - User configuration object
 */
async function getUserConfig(userId, req) {
    // First check if configuration is provided in request
    let sortOption = null;
    let configUpdated = false;
    
    // Check if the request comes with configuration in the query params
    if (req.query && req.query.configuration) {
        try {
            const config = JSON.parse(decodeURIComponent(req.query.configuration));
            sortOption = config.sortOption;
            configUpdated = true;
            console.log(`Retrieved configuration from request for ${userId}: sortOption=${sortOption}`);
        } catch (e) {
            console.error(`Error parsing configuration from request: ${e.message}`);
        }
    }
    
    // If no configuration in request, try to get from database
    if (!sortOption) {
        try {
            // Get user config from database if exists (using db from module scope)
            if (global.db) {
                const userConfig = await global.db.getUserConfig(userId);
                if (userConfig && userConfig.sortOption) {
                    sortOption = userConfig.sortOption;
                    console.log(`Retrieved saved configuration for ${userId}: sortOption=${sortOption}`);
                }
            }
        } catch (e) {
            console.error(`Error retrieving user config from database: ${e.message}`);
        }
    }
    
    // Save the config to database if it was provided in request
    if (configUpdated && sortOption && global.db) {
        try {
            await global.db.saveUserConfig(userId, { sortOption });
            console.log(`Saved configuration for ${userId}: sortOption=${sortOption}`);
        } catch (e) {
            console.error(`Error saving user config to database: ${e.message}`);
        }
    }
    
    // If still nothing, use default
    if (!sortOption) {
        sortOption = constants.DEFAULT_SORT_OPTION;
    }
    
    return { sortOption };
}

module.exports = {
    parseSortOption,
    getUserConfig
}; 