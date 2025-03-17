/**
 * Adaptive rate limiter for IMDb API requests
 * Helps prevent rate limiting by self-regulating request rate
 */

const Redis = require('ioredis');
const config = require('./config');

// Default rate limits
const DEFAULT_LIMITS = {
    tokensPerInterval: 30,  // Number of requests
    interval: 60 * 1000,    // 1 minute in milliseconds
    maxTokens: 30           // Maximum number of tokens that can be accumulated
};

// Redis client for distributed rate limiting
let redisClient;
let isDistributed = false;

// In-memory rate limiter state (fallback)
const memoryState = {
    tokens: DEFAULT_LIMITS.maxTokens,
    lastRefill: Date.now(),
    inProgress: 0
};

/**
 * Initialize the rate limiter
 * @param {Object} options - Configuration options
 * @param {boolean} options.useRedis - Whether to use Redis for distributed rate limiting
 * @param {number} options.tokensPerInterval - Tokens per interval
 * @param {number} options.interval - Interval in milliseconds
 * @param {number} options.maxTokens - Maximum tokens
 * @returns {Promise<boolean>} - Whether initialization was successful
 */
async function initialize(options = {}) {
    // Set rate limiting parameters
    const limits = {
        tokensPerInterval: options.tokensPerInterval || DEFAULT_LIMITS.tokensPerInterval,
        interval: options.interval || DEFAULT_LIMITS.interval,
        maxTokens: options.maxTokens || DEFAULT_LIMITS.maxTokens
    };
    
    Object.assign(DEFAULT_LIMITS, limits);
    
    // Reset memory state
    memoryState.tokens = DEFAULT_LIMITS.maxTokens;
    memoryState.lastRefill = Date.now();
    memoryState.inProgress = 0;
    
    // Set up Redis if requested and available
    if (options.useRedis && config.REDIS_ENABLED) {
        try {
            redisClient = new Redis(config.REDIS_URL);
            
            // Test connection
            await redisClient.ping();
            
            // Initialize counter in Redis if it doesn't exist
            const exists = await redisClient.exists('rate_limiter:tokens');
            if (!exists) {
                await redisClient.set('rate_limiter:tokens', DEFAULT_LIMITS.maxTokens);
                await redisClient.set('rate_limiter:lastRefill', Date.now());
                await redisClient.set('rate_limiter:inProgress', 0);
            }
            
            isDistributed = true;
            console.log('Rate limiter initialized with Redis (distributed mode)');
        } catch (error) {
            console.error('Failed to initialize Redis for rate limiter:', error);
            isDistributed = false;
            
            // Close the client if it was created
            if (redisClient) {
                redisClient.disconnect();
                redisClient = null;
            }
        }
    }
    
    if (!isDistributed) {
        console.log('Rate limiter initialized in memory (local mode)');
    }
    
    return true;
}

/**
 * Acquire a token for making a request
 * @returns {Promise<boolean>} - Whether a token was acquired
 */
async function acquireToken() {
    return isDistributed ? acquireDistributedToken() : acquireLocalToken();
}

/**
 * Acquire a token using Redis for distributed rate limiting
 * @returns {Promise<boolean>} - Whether a token was acquired
 */
async function acquireDistributedToken() {
    if (!redisClient) return false;
    
    // Use Redis scripting for atomic operations
    const luaScript = `
        local tokens = tonumber(redis.call('get', 'rate_limiter:tokens') or '0')
        local lastRefill = tonumber(redis.call('get', 'rate_limiter:lastRefill') or '0')
        local now = tonumber(ARGV[1])
        local interval = tonumber(ARGV[2])
        local tokensPerInterval = tonumber(ARGV[3])
        local maxTokens = tonumber(ARGV[4])
        
        -- Calculate token refill
        local elapsedTime = now - lastRefill
        local refill = math.floor(elapsedTime / interval * tokensPerInterval)
        
        if refill > 0 then
            tokens = math.min(tokens + refill, maxTokens)
            redis.call('set', 'rate_limiter:lastRefill', now)
        end
        
        -- Try to acquire a token
        if tokens >= 1 then
            redis.call('set', 'rate_limiter:tokens', tokens - 1)
            redis.call('incr', 'rate_limiter:inProgress')
            return 1
        else
            return 0
        end
    `;
    
    try {
        const result = await redisClient.eval(
            luaScript,
            0,
            Date.now(),
            DEFAULT_LIMITS.interval,
            DEFAULT_LIMITS.tokensPerInterval,
            DEFAULT_LIMITS.maxTokens
        );
        
        return result === 1;
    } catch (error) {
        console.error('Error acquiring distributed token:', error);
        return false;
    }
}

/**
 * Acquire a token using local memory for rate limiting
 * @returns {Promise<boolean>} - Whether a token was acquired
 */
function acquireLocalToken() {
    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsedTime = now - memoryState.lastRefill;
    const refill = Math.floor(elapsedTime / DEFAULT_LIMITS.interval * DEFAULT_LIMITS.tokensPerInterval);
    
    if (refill > 0) {
        memoryState.tokens = Math.min(memoryState.tokens + refill, DEFAULT_LIMITS.maxTokens);
        memoryState.lastRefill = now;
    }
    
    // Try to acquire a token
    if (memoryState.tokens >= 1) {
        memoryState.tokens -= 1;
        memoryState.inProgress += 1;
        return true;
    }
    
    return false;
}

/**
 * Release a token after a request completes
 * @param {boolean} wasSuccessful - Whether the request was successful
 * @returns {Promise<void>}
 */
async function releaseToken(wasSuccessful = true) {
    if (isDistributed) {
        await releaseDistributedToken(wasSuccessful);
    } else {
        releaseLocalToken(wasSuccessful);
    }
}

/**
 * Release a token in distributed mode
 * @param {boolean} wasSuccessful - Whether the request was successful
 * @returns {Promise<void>}
 */
async function releaseDistributedToken(wasSuccessful) {
    if (!redisClient) return;
    
    try {
        // Decrement in-progress counter
        await redisClient.decr('rate_limiter:inProgress');
        
        // If request failed, return the token
        if (!wasSuccessful) {
            await redisClient.incr('rate_limiter:tokens');
        }
    } catch (error) {
        console.error('Error releasing distributed token:', error);
    }
}

/**
 * Release a token in local mode
 * @param {boolean} wasSuccessful - Whether the request was successful
 */
function releaseLocalToken(wasSuccessful) {
    // Decrement in-progress counter
    memoryState.inProgress -= 1;
    
    // If request failed, return the token
    if (!wasSuccessful) {
        memoryState.tokens += 1;
    }
}

/**
 * Get rate limiter status
 * @returns {Promise<Object>} - Current rate limiter status
 */
async function getStatus() {
    if (isDistributed) {
        try {
            const [tokens, lastRefill, inProgress] = await Promise.all([
                redisClient.get('rate_limiter:tokens').then(Number),
                redisClient.get('rate_limiter:lastRefill').then(Number),
                redisClient.get('rate_limiter:inProgress').then(Number)
            ]);
            
            return {
                mode: 'distributed',
                tokens,
                lastRefill,
                inProgress,
                available: tokens > 0,
                nextRefill: lastRefill + DEFAULT_LIMITS.interval,
                settings: { ...DEFAULT_LIMITS }
            };
        } catch (error) {
            console.error('Error getting distributed rate limiter status:', error);
            return { mode: 'distributed', error: error.message };
        }
    } else {
        return {
            mode: 'local',
            tokens: memoryState.tokens,
            lastRefill: memoryState.lastRefill,
            inProgress: memoryState.inProgress,
            available: memoryState.tokens > 0,
            nextRefill: memoryState.lastRefill + DEFAULT_LIMITS.interval,
            settings: { ...DEFAULT_LIMITS }
        };
    }
}

/**
 * Update rate limit settings
 * @param {Object} newLimits - New rate limit settings
 * @returns {Promise<boolean>} - Whether update was successful
 */
async function updateLimits(newLimits) {
    if (!newLimits) return false;
    
    // Update local settings
    if (newLimits.tokensPerInterval) {
        DEFAULT_LIMITS.tokensPerInterval = newLimits.tokensPerInterval;
    }
    
    if (newLimits.interval) {
        DEFAULT_LIMITS.interval = newLimits.interval;
    }
    
    if (newLimits.maxTokens) {
        DEFAULT_LIMITS.maxTokens = newLimits.maxTokens;
    }
    
    return true;
}

/**
 * Close the rate limiter connections
 * @returns {Promise<void>}
 */
async function close() {
    if (redisClient) {
        try {
            await redisClient.quit();
            console.log('Rate limiter Redis connection closed');
        } catch (error) {
            console.error('Error closing rate limiter Redis connection:', error);
        }
    }
}

module.exports = {
    initialize,
    acquireToken,
    releaseToken,
    getStatus,
    updateLimits,
    close
}; 