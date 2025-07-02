/**
 * Application-wide constants
 * This file centralizes all constants used throughout the application
 */

// Application metadata
const APP_NAME = 'Stremlist';
const ADDON_VERSION = '1.2.1';
const APP_DESCRIPTION = 'Your IMDb Watchlist in Stremio';
const APP_LOGO = 'https://stremlist.com/icon.png';
const APP_ID_PREFIX = 'com.stremlist';

// Configuration
const DEFAULT_SORT_OPTION = 'added_at-asc';
const DEFAULT_SORT_OPTIONS = { by: 'added_at', order: 'asc' };

// Sorting options for the UI and manifest
const SORT_OPTIONS = [
    { value: 'added_at-asc', label: 'Date Added (Oldest First) - (IMDb Order)' },
    { value: 'added_at-desc', label: 'Date Added (Newest First)' },
    { value: 'title-asc', label: 'Title (A-Z)' },
    { value: 'title-desc', label: 'Title (Z-A)' },
    { value: 'year-desc', label: 'Newest First' },
    { value: 'year-asc', label: 'Oldest First' },
    { value: 'rating-desc', label: 'Highest Rated' },
    { value: 'rating-asc', label: 'Lowest Rated' }
];

// Cache and sync settings (convert seconds to milliseconds for runtime use)
const CACHE_TTL = parseInt(process.env.CACHE_TTL || 360) * 60; // Default: 15 minutes in seconds
const CACHE_TTL_MS = CACHE_TTL * 1000;
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || 720) * 60; // Default: 30 minutes in seconds
const SYNC_INTERVAL_MS = SYNC_INTERVAL * 1000;

// Logging
const MAX_LOGS_BEFORE_ROTATION = parseInt(process.env.MAX_LOGS_BEFORE_ROTATION || 1000);
const VERBOSE_MODE = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1';
const VERBOSE_DB_LOGGING = process.env.VERBOSE_DB_LOGGING === 'true';

// Server
const DEFAULT_PORT = 7001;

// Redis settings
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_ENABLED = process.env.REDIS_ENABLED !== 'false';
const USE_MEMORY_FALLBACK = process.env.USE_MEMORY_FALLBACK !== 'false';

// Worker settings
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || 3);
const WORKER_ENABLED = process.env.WORKER_ENABLED !== 'false';

// Rate limiting settings
const RATE_LIMIT_REQUESTS = parseInt(process.env.RATE_LIMIT_REQUESTS || 5);
const RATE_LIMIT_INTERVAL = parseInt(process.env.RATE_LIMIT_INTERVAL || 120) * 1000; // Convert to milliseconds
const DISTRIBUTED_RATE_LIMITING = process.env.DISTRIBUTED_RATE_LIMITING === 'true';

// IMDb API settings
const IMDB_API_URL = 'https://api.graphql.imdb.com/';
const IMDB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// Crawl4AI Docker server settings
const CRAWL4AI_DOCKER_SERVER = 'http://129.151.250.86:11235';

// Base manifest
const BASE_MANIFEST = {
    id: APP_ID_PREFIX,
    version: ADDON_VERSION,
    name: APP_NAME,
    description: APP_DESCRIPTION,
    resources: [
        'catalog',
        {
            name: 'meta',
            types: ['movie', 'series'],
            idPrefixes: ['tt']  // IMDb IDs start with 'tt'
        }
    ],
    types: ['movie', 'series'],
    catalogs: [
        {
            id: 'stremlist-movies',
            name: 'Stremlist Movies',
            type: 'movie'
        },
        {
            id: 'stremlist-series',
            name: 'Stremlist Series', 
            type: 'series'
        }
    ],
    logo: APP_LOGO,
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },
    config: [
        {
            key: 'sortOption',
            type: 'select',
            title: 'Sort Watchlist By',
            options: SORT_OPTIONS.map(option => option.value),
            default: DEFAULT_SORT_OPTION
        }
    ]
};

module.exports = {
    // Application metadata
    APP_NAME,
    ADDON_VERSION,
    APP_DESCRIPTION,
    APP_LOGO,
    APP_ID_PREFIX,
    
    // Configuration
    DEFAULT_SORT_OPTION,
    DEFAULT_SORT_OPTIONS,
    SORT_OPTIONS,
    
    // Cache and sync settings
    CACHE_TTL,
    CACHE_TTL_MS,
    SYNC_INTERVAL,
    SYNC_INTERVAL_MS,
    
    // Logging
    MAX_LOGS_BEFORE_ROTATION,
    VERBOSE_MODE,
    VERBOSE_DB_LOGGING,
    
    // Server
    DEFAULT_PORT,
    
    // Redis settings
    REDIS_URL,
    REDIS_ENABLED,
    USE_MEMORY_FALLBACK,
    
    // Worker settings
    WORKER_CONCURRENCY,
    WORKER_ENABLED,
    
    // Rate limiting settings
    RATE_LIMIT_REQUESTS,
    RATE_LIMIT_INTERVAL,
    DISTRIBUTED_RATE_LIMITING,
    
    // IMDb API settings
    IMDB_API_URL,
    IMDB_USER_AGENT,
    
    // Crawl4AI Docker server settings
    CRAWL4AI_DOCKER_SERVER,
    
    // Base manifest
    BASE_MANIFEST
}; 