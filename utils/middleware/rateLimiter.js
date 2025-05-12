/**
 * Simple rate limiter middleware
 * @param {number} windowMs - Rate limit window in milliseconds (default: 15 minutes)
 * @param {number} maxRequests - Maximum requests per window (default: 100 requests)
 * @returns {Function} - Express middleware function
 */
function createRateLimiter(windowMs = 15 * 60 * 1000, maxRequests = 100) {
    // Storage for rate limit data
    const rateLimit = {};
    
    // Return middleware function
    return function rateLimiter(req, res, next) {
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const now = Date.now();
        
        // Initialize or clear old rate limit data
        if (!rateLimit[ip] || rateLimit[ip].resetTime < now) {
            rateLimit[ip] = {
                count: 0,
                resetTime: now + windowMs
            };
        }
        
        // Increment request count
        rateLimit[ip].count++;
        
        // If limit exceeded, return 429 Too Many Requests
        if (rateLimit[ip].count > maxRequests) {
            return res.status(429).json({
                error: 'Too many requests',
                message: 'Rate limit exceeded. Please try again later.'
            });
        }
        
        next();
    };
}

module.exports = createRateLimiter; 