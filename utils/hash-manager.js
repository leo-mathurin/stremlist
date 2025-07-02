const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Hash Manager for IMDb GraphQL API
 * 
 * This module manages the dynamic extraction and caching of IMDb's GraphQL 
 * persisted query hash using a Python crawler script.
 */

// Cache for the hash with timestamp
let hashCache = {
    hash: null,
    timestamp: null,
    ttl: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

/**
 * Executes the Python hash extraction script
 * @returns {Promise<string>} The extracted GraphQL hash
 * @throws {Error} If hash extraction fails
 */
async function extractHashFromPython() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '..', 'scripts', 'imdb_hash_extractor.py');
        const venvPython = path.join(__dirname, '..', 'scripts', 'venv', 'bin', 'python');
        
        // Check if Python script exists
        if (!fs.existsSync(scriptPath)) {
            reject(new Error('Python hash extraction script not found. Please run setup_python_env.sh first.'));
            return;
        }
        
        // Use virtual environment Python if available, otherwise system Python
        const pythonCommand = fs.existsSync(venvPython) ? venvPython : 'python3';
        
        console.log('Extracting fresh IMDb GraphQL hash...');
        
        const pythonProcess = spawn(pythonCommand, [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            // Log stderr for debugging, but don't fail immediately
            // as the script might output debug info to stderr
            console.log('Python script output:', data.toString().trim());
        });
        
        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                console.error('Python script stderr:', stderr);
                reject(new Error(`Hash extraction failed with exit code ${code}: ${stderr}`));
                return;
            }
            
            try {
                // Parse the last line of stdout as JSON (the actual result)
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const result = JSON.parse(lastLine);
                
                if (result.success && result.hash) {
                    console.log('✓ Successfully extracted GraphQL hash:', result.hash);
                    resolve(result.hash);
                } else {
                    reject(new Error(`Hash extraction failed: ${result.error || 'Unknown error'}`));
                }
            } catch (parseError) {
                console.error('Failed to parse Python script output:', stdout);
                reject(new Error(`Failed to parse hash extraction result: ${parseError.message}`));
            }
        });
        
        pythonProcess.on('error', (error) => {
            reject(new Error(`Failed to start Python script: ${error.message}`));
        });
        
        // Set a timeout for the extraction process
        setTimeout(() => {
            if (!pythonProcess.killed) {
                pythonProcess.kill();
                reject(new Error('Hash extraction timed out after 60 seconds'));
            }
        }, 60000);
    });
}

/**
 * Gets the current GraphQL hash, extracting a fresh one if needed
 * @param {boolean} forceRefresh - Force refresh even if cache is valid
 * @returns {Promise<string>} The GraphQL hash
 * @throws {Error} If hash extraction fails
 */
async function getGraphQLHash(forceRefresh = false) {
    const now = Date.now();
    
    // Check if we have a valid cached hash
    if (!forceRefresh && 
        hashCache.hash && 
        hashCache.timestamp && 
        (now - hashCache.timestamp) < hashCache.ttl) {
        console.log('Using cached GraphQL hash');
        return hashCache.hash;
    }
    
    try {
        // Extract fresh hash
        const hash = await extractHashFromPython();
        
        // Update cache
        hashCache.hash = hash;
        hashCache.timestamp = now;
        
        return hash;
    } catch (error) {
        console.error('Failed to extract GraphQL hash:', error.message);
        throw new Error(`IMDb GraphQL hash extraction failed: ${error.message}`);
    }
}

/**
 * Clears the hash cache, forcing a refresh on next request
 */
function clearHashCache() {
    hashCache.hash = null;
    hashCache.timestamp = null;
    console.log('GraphQL hash cache cleared');
}

/**
 * Gets cache status for debugging/monitoring
 * @returns {Object} Cache status information
 */
function getCacheStatus() {
    const now = Date.now();
    const isValid = hashCache.hash && 
                   hashCache.timestamp && 
                   (now - hashCache.timestamp) < hashCache.ttl;
    
    return {
        hasHash: !!hashCache.hash,
        timestamp: hashCache.timestamp,
        age: hashCache.timestamp ? now - hashCache.timestamp : null,
        ttl: hashCache.ttl,
        isValid,
        hash: hashCache.hash ? hashCache.hash.substring(0, 8) + '...' : null // Only show first 8 chars for security
    };
}

module.exports = {
    getGraphQLHash,
    clearHashCache,
    getCacheStatus,
    extractHashFromPython
}; 