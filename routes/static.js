const express = require('express');
const path = require('path');
const router = express.Router();

module.exports = function(manifest = null, sortOptions = null, respond = null) {
    // Route for the web interface homepage
    router.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    });
    
    // Route for getting sort options
    if (respond && sortOptions) {
        router.get('/api/sort-options', (req, res) => {
            respond(res, { options: sortOptions });
        });
    }

    return router;
}; 