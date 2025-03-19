@echo off
setlocal enabledelayedexpansion

:: Development script for Stremlist

:: Print banner
echo.
echo =======================================
echo           Stremlist Dev Tool
echo =======================================
echo.

:: Initialize variables
set REBUILD=false
set CLEAN=false
set REDIS_ONLY=false
set NODE_ONLY=false
set VERBOSE=false

:: Parse command line arguments
:parse_args
if "%~1"=="" goto :end_parse_args
if "%~1"=="--rebuild" (
    set REBUILD=true
    shift
    goto :parse_args
)
if "%~1"=="-r" (
    set REBUILD=true
    shift
    goto :parse_args
)
if "%~1"=="--clean" (
    set CLEAN=true
    shift
    goto :parse_args
)
if "%~1"=="-c" (
    set CLEAN=true
    shift
    goto :parse_args
)
if "%~1"=="--redis-only" (
    set REDIS_ONLY=true
    shift
    goto :parse_args
)
if "%~1"=="--node-only" (
    set NODE_ONLY=true
    shift
    goto :parse_args
)
if "%~1"=="--verbose" (
    set VERBOSE=true
    shift
    goto :parse_args
)
if "%~1"=="-v" (
    set VERBOSE=true
    shift
    goto :parse_args
)
if "%~1"=="--help" (
    goto :show_help
)
if "%~1"=="-h" (
    goto :show_help
)
echo Unknown option: %~1
echo Use --help to see available options
exit /b 1

:show_help
echo Usage: dev.bat [options]
echo.
echo Options:
echo   --rebuild, -r       Force rebuild of containers
echo   --clean, -c         Remove volumes and perform clean rebuild
echo   --redis-only        Start only Redis container
echo   --node-only         Start only Node.js container
echo   --verbose, -v       Show verbose output
echo   --help, -h          Show this help message
exit /b 0

:end_parse_args

:: Create development docker-compose file
echo Creating development configuration files...
echo version: '3.8'> docker-compose.dev.yml
echo.>> docker-compose.dev.yml
echo services:>> docker-compose.dev.yml
echo   # Redis service>> docker-compose.dev.yml
echo   redis:>> docker-compose.dev.yml
echo     image: redis:7.0-alpine>> docker-compose.dev.yml
echo     container_name: stremlist-redis-dev>> docker-compose.dev.yml
echo     ports:>> docker-compose.dev.yml
echo       - "6379:6379">> docker-compose.dev.yml
echo     volumes:>> docker-compose.dev.yml
echo       - redis-data-dev:/data>> docker-compose.dev.yml
echo     command: redis-server --appendonly yes>> docker-compose.dev.yml
echo     restart: unless-stopped>> docker-compose.dev.yml
echo     healthcheck:>> docker-compose.dev.yml
echo       test: ["CMD", "redis-cli", "ping"]>> docker-compose.dev.yml
echo       interval: 5s>> docker-compose.dev.yml
echo       timeout: 5s>> docker-compose.dev.yml
echo       retries: 5>> docker-compose.dev.yml
echo     networks:>> docker-compose.dev.yml
echo       - stremlist-network-dev>> docker-compose.dev.yml
echo.>> docker-compose.dev.yml
echo   # Application service for development>> docker-compose.dev.yml
echo   app:>> docker-compose.dev.yml
echo     build:>> docker-compose.dev.yml
echo       context: .>> docker-compose.dev.yml
echo       dockerfile: Dockerfile.dev>> docker-compose.dev.yml
echo     container_name: stremlist-app-dev>> docker-compose.dev.yml
echo     volumes:>> docker-compose.dev.yml
echo       - .:/app>> docker-compose.dev.yml
echo       - /app/node_modules>> docker-compose.dev.yml
echo     environment:>> docker-compose.dev.yml
echo       - NODE_ENV=development>> docker-compose.dev.yml
echo       - REDIS_URL=redis://redis:6379>> docker-compose.dev.yml
echo       - REDIS_ENABLED=true>> docker-compose.dev.yml
echo       - USE_MEMORY_FALLBACK=true>> docker-compose.dev.yml
echo       - VERBOSE=true>> docker-compose.dev.yml
echo       - SYNC_INTERVAL=30>> docker-compose.dev.yml
echo       - CACHE_TTL=15>> docker-compose.dev.yml
echo       - WORKER_CONCURRENCY=2>> docker-compose.dev.yml
echo       - WORKER_ENABLED=true>> docker-compose.dev.yml
echo       - PORT=7001>> docker-compose.dev.yml
echo     ports:>> docker-compose.dev.yml
echo       - "7001:7001">> docker-compose.dev.yml
echo     depends_on:>> docker-compose.dev.yml
echo       redis:>> docker-compose.dev.yml
echo         condition: service_healthy>> docker-compose.dev.yml
echo     restart: unless-stopped>> docker-compose.dev.yml
echo     networks:>> docker-compose.dev.yml
echo       - stremlist-network-dev>> docker-compose.dev.yml
echo     command: npm run dev>> docker-compose.dev.yml
echo.>> docker-compose.dev.yml
echo networks:>> docker-compose.dev.yml
echo   stremlist-network-dev:>> docker-compose.dev.yml
echo     driver: bridge>> docker-compose.dev.yml
echo.>> docker-compose.dev.yml
echo volumes:>> docker-compose.dev.yml
echo   redis-data-dev:>> docker-compose.dev.yml
echo     driver: local>> docker-compose.dev.yml

:: Create development Dockerfile
echo FROM node:18-alpine> Dockerfile.dev
echo.>> Dockerfile.dev
echo WORKDIR /app>> Dockerfile.dev
echo.>> Dockerfile.dev
echo # Install development dependencies>> Dockerfile.dev
echo COPY package*.json ./>> Dockerfile.dev
echo RUN npm install>> Dockerfile.dev
echo.>> Dockerfile.dev
echo # Expose the port the app runs on>> Dockerfile.dev
echo EXPOSE 7001>> Dockerfile.dev
echo.>> Dockerfile.dev
echo # Command to run the application is specified in docker-compose>> Dockerfile.dev
echo CMD ["npm", "run", "dev"]>> Dockerfile.dev

:: Clean if requested
if "%CLEAN%"=="true" (
    echo Cleaning containers, images, and volumes...
    docker-compose -f docker-compose.dev.yml down -v
    
    if "%VERBOSE%"=="true" (
        echo Removing development volumes...
        docker volume rm stremlist-redis-data-dev 2>nul || echo Volume not found
    )
)

:: Build or start containers
if "%REBUILD%"=="true" (
    if "%REDIS_ONLY%"=="true" (
        echo Rebuilding Redis container only...
        docker-compose -f docker-compose.dev.yml up -d --build redis
    ) else if "%NODE_ONLY%"=="true" (
        echo Rebuilding Node.js container only...
        docker-compose -f docker-compose.dev.yml up -d --build app
    ) else (
        echo Rebuilding all containers...
        docker-compose -f docker-compose.dev.yml up -d --build
    )
) else (
    if "%REDIS_ONLY%"=="true" (
        echo Starting Redis container only...
        docker-compose -f docker-compose.dev.yml up -d redis
    ) else if "%NODE_ONLY%"=="true" (
        echo Starting Node.js container only...
        docker-compose -f docker-compose.dev.yml up -d app
    ) else (
        echo Starting all containers...
        docker-compose -f docker-compose.dev.yml up -d
    )
)

:: Display container status
echo Container status:
docker-compose -f docker-compose.dev.yml ps

:: Show logs if not in redis-only mode
if not "%REDIS_ONLY%"=="true" (
    echo Showing logs for Node.js container (Ctrl+C to exit):
    docker-compose -f docker-compose.dev.yml logs -f app
)

endlocal 