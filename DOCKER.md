# Docker Setup for IMDb Watchlist Stremio Addon

This document describes how to run the IMDb Watchlist Stremio addon using Docker.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Running Redis Only (for Development)

If you want to run the Node.js application locally but use Redis in Docker:

```bash
# Start Redis container
docker-compose -f docker-compose.dev.yml up -d

# Verify Redis is running
docker ps

# To stop Redis
docker-compose -f docker-compose.dev.yml down
```

With this setup, your local application should connect to Redis at `localhost:6379`.

## Running the Complete Application in Docker

To run both the application and Redis in Docker:

```bash
# Build and start all containers
docker-compose up -d

# View logs
docker-compose logs -f

# To stop all containers
docker-compose down
```

The application will be available at `http://localhost:7001`.

## Environment Variables

You can customize the Docker environment by editing the `docker.env` file.

## Data Persistence

Redis data is persisted using Docker volumes. The data will be preserved even if you restart or remove the containers:

- Production: `redis-data` volume
- Development: `redis-data-dev` volume

To completely remove the volumes (this will delete all stored data):

```bash
# For production setup
docker-compose down -v

# For development setup
docker-compose -f docker-compose.dev.yml down -v
```

## Accessing Redis CLI

You can access the Redis command-line interface for debugging:

```bash
# For production Redis
docker exec -it imdb-watchlist-redis redis-cli

# For development Redis
docker exec -it imdb-watchlist-redis-dev redis-cli
```

## Useful Commands

```bash
# View all containers
docker ps

# View logs for a specific container
docker logs imdb-watchlist-app
docker logs imdb-watchlist-redis

# Restart a specific container
docker restart imdb-watchlist-app
docker restart imdb-watchlist-redis

# Stop all containers and remove volumes
docker-compose down -v
```

## Security Notes

The default configuration exposes Redis on port 6379. For production use:

1. Configure Redis password authentication
2. Use a private network for Redis
3. Don't expose Redis port to the host machine unless necessary 