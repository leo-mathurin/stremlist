# Stremlist

A Stremio addon that creates a catalog from your IMDb watchlist, allowing you to browse your saved movies and TV shows directly in Stremio.

## Features

- Seamlessly integrates your IMDb watchlist with Stremio
- Automatically updates when your watchlist changes
- Supports both movies and TV shows
- Easy to install through the configuration interface
- No persistent storage of your watchlist data (privacy-focused)
- Short-term in-memory caching to improve performance
- Public deployment option via Vercel or Render
- **Automatic background syncing** of your watchlist while Stremio is running

## Using the Public Addon

You can use the publicly hosted version of this addon without setting up your own server.

1. Open Stremio and go to the Addons section
2. Click "Add Addon URL" and enter: `[YOUR_DEPLOYED_URL]/manifest.json`
3. You'll be prompted to configure the addon
4. Enter your IMDb User ID and click "Install Addon"
5. Choose one of the installation methods provided

## Self-Hosted Installation

### Using the Web Interface (Recommended)

1. Start the addon server:
   ```
   npm install
   npm start
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:7001
   ```

3. Enter your IMDb User ID and click "Install Addon"
4. Choose one of the installation methods presented

### Direct Installation in Stremio

1. Start the addon server:
   ```
   npm install
   npm start
   ```

2. In Stremio, go to the Addons section
3. Click "Add Addon URL" and enter:
   ```
   http://localhost:7001/manifest.json
   ```

4. You'll be directed to the configuration page where you can enter your IMDb User ID

### Quick Installation Commands

This addon supports Stremio's quick installation methods:

1. To install in Stremio Desktop app:
   ```
   npm run stremio-desktop
   ```

2. To install in Stremio Web version:
   ```
   npm run stremio-web
   ```

## How to Find Your IMDb User ID

Your IMDb User ID starts with "ur" and can be found in your IMDb profile URL.

For example, if your watchlist URL is:
```
https://www.imdb.com/user/ur12345678/watchlist
```

Then your IMDb User ID is `ur12345678`.

## Deploying Your Own Public Instance

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions on deploying your own public instance of this addon.

## Development

### Prerequisites

- Node.js (v16 or later)

### Setup

1. Clone the repository:
   ```
   git clone https://github.com/leo-mathurin/imdb-watchlist-stremio.git
   cd imdb-watchlist-stremio
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the development server:
   ```
   npm run dev
   ```

This will start the server with nodemon, which automatically restarts when files are changed.

## How It Works

1. The addon uses a JavaScript scraper to fetch your IMDb watchlist
2. The watchlist data is processed and converted to a Stremio-compatible format
3. The data is temporarily cached in memory (not on disk) to improve performance
4. The addon serves this data as a catalog that Stremio can browse
5. **While Stremio is running, the addon automatically syncs your watchlist in the background**

## Advanced Configuration

The addon supports the following environment variables for advanced configuration:

- `SYNC_INTERVAL`: Background sync interval in minutes (default: 30)
- `CACHE_TTL`: Cache time-to-live in minutes (default: 15)
- `NODE_ENV`: Set to 'production' to prevent log rotation clearing (default: development)
- `MAX_LOGS_BEFORE_ROTATION`: Number of log entries before rotation occurs (default: 1000)
- `VERBOSE`: Enable verbose logging, set to 'true' or '1' (default: disabled)

Example for local development:
```
SYNC_INTERVAL=60 CACHE_TTL=30 VERBOSE=true npm start
```

Example for hosted deployment:
```
SYNC_INTERVAL=30 CACHE_TTL=15 npm start
```

### Automatic Syncing

The addon automatically keeps watchlists up-to-date:

1. When a user installs the addon or accesses their catalog, they're added to the users list
2. The addon syncs watchlists for ALL users based on the configured interval
3. Once added, users are never removed from the sync list, ensuring continuous updates

All users receive equal syncing priority, and the addon will continuously sync all watchlists regardless of user activity.

### Logging

The addon includes built-in logging with two modes:

- **Default Mode**: Shows essential information like sync status and errors
- **Verbose Mode**: Shows detailed logs including watchlist contents and performance metrics

All logs include timestamps for easier debugging. In development mode, logs will automatically rotate after 1000 entries to prevent console overflow.

With default logging, you'll see:
- When sync operations start and finish
- Basic connection and error information
- User activity tracking

With verbose logging, you'll additionally see:
- Detailed content of each watchlist
- Sample entries of movies and TV shows
- Performance metrics and timing information

## Troubleshooting

If your addon is not working correctly:

1. Make sure your IMDb watchlist is public
2. Try using different installation methods (HTTP URL, Stremio Web, Stremio Desktop)
3. Restart Stremio after adding the addon
4. Check that your IMDb User ID starts with "ur" and is entered correctly
5. If using Windows, try running as Administrator

## Privacy

This addon is designed with privacy in mind:
- Your watchlist data is only stored in memory during runtime
- No persistent storage of user data on the server
- The in-memory cache is cleared when the server restarts

## License

ISC

## Disclaimer

This addon is not affiliated with IMDb or Stremio. It's a community project.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port on which the addon server will run | `7001` |
| `SYNC_INTERVAL` | Interval in minutes for background syncing of all users | `30` |
| `CACHE_TTL` | Time-to-live in minutes for cached watchlists | `15` |
| `VERBOSE` | Enable verbose logging mode | `false` |
| `MAX_LOGS_BEFORE_ROTATION` | Maximum number of log entries before rotating | `1000` |
| `REDIS_ENABLED` | Enable Redis for persistent storage | `true` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `USE_MEMORY_FALLBACK` | Use in-memory storage when Redis is unavailable | `true` |
| `VERBOSE_DB_LOGGING` | Enable verbose logging for database operations | `false` |

## Database Configuration

The addon now supports persistent storage using Redis, which helps maintain user data across server restarts and enables horizontal scaling for high-availability deployments.

### Redis Setup

1. Make sure you have Redis installed and running:
   - **Local development**: Install Redis locally or use Docker
   - **Production**: Use a Redis service like Redis Cloud, AWS ElastiCache, or similar

2. Configure the Redis connection in `.env`:
   ```
   REDIS_ENABLED=true
   REDIS_URL=redis://localhost:6379
   ```

3. For production with authentication:
   ```
   REDIS_URL=redis://username:password@host:port
   ```

### Docker Support

The addon includes Docker support for both development and production:

1. **Development with Redis in Docker**:
   ```bash
   # Start Redis only
   npm run docker:redis
   
   # Then run the application locally
   npm run dev
   ```

2. **Full Docker deployment**:
   ```bash
   # Start both Redis and the application in Docker
   npm run docker:all
   ```

3. **View Docker logs**:
   ```bash
   npm run docker:logs
   ```

For more details, see [DOCKER.md](DOCKER.md)

### Fallback Mechanism

If Redis becomes unavailable, the addon will automatically fall back to in-memory storage (configurable via `USE_MEMORY_FALLBACK`). This ensures uninterrupted service, but watchlist data and user records will be lost when the server restarts.

### Data Stored in Redis

The addon stores the following data in Redis:

1. **Watchlist Cache**: User watchlists with expiration based on `CACHE_TTL`
2. **Active Users**: List of users that should be synchronized
3. **User Activity**: Timestamps of user activity for logging purposes