# PGSync Setup Guide

This guide covers setting up [PGSync](https://github.com/toluaina/pgsync) for real-time PostgreSQL to Elasticsearch synchronization in the opencouncil-tasks infrastructure.

## Overview

PGSync uses PostgreSQL's logical replication (WAL) to sync data to Elasticsearch in real-time. It runs as a Docker service with Redis-based checkpointing for fault tolerance.

**Key Features:**
- Real-time change data capture via logical decoding
- Automatic handling of INSERT, UPDATE, DELETE, TRUNCATE
- Redis checkpointing for resumable sync
- Complex relationship mapping with nested documents

## Prerequisites

### 1. PostgreSQL Configuration

Enable logical decoding (for managed databases like DigitalOcean, AWS RDS, this is typically enabled by default or via a parameter group):

```sql
-- Verify settings
SHOW wal_level;  -- Should return 'logical'
SHOW max_replication_slots;  -- Should be >= 1
```

See [PostgreSQL Logical Replication docs](https://www.postgresql.org/docs/current/logical-replication.html) for detailed setup.

### 2. PostgreSQL Views

Create the required helper views defined in the [main opencouncil repository](https://github.com/schemalabz/opencouncil/blob/main/docs/elasticsearch.md#configure-postgresql-views):

```bash
psql "$DATABASE_URL" < path/to/views.sql
```

### 3. PGSync Schema

The PGSync schema defines table relationships, field mappings, and transformations. Host it remotely (e.g., GitHub Gist) and reference via `SCHEMA_URL`.

- [PGSync Schema Documentation](https://pgsync.com/schema/)
- [Example Schemas](https://github.com/toluaina/pgsync/tree/main/examples)

> **Note**: Schema changes require re-indexing Elasticsearch (see [Re-indexing](#re-indexing)).

## Environment Variables

Configure in your `.env` file:

```bash
# PostgreSQL
PG_URL=postgres://user:password@host:port/database

# Elasticsearch
ELASTICSEARCH_URL=https://your-cluster.es.region.aws.elastic.cloud:443
ELASTICSEARCH_API_KEY_ID=<api_key_id>
ELASTICSEARCH_API_KEY=<api_key_secret>

# PGSync Schema
SCHEMA_URL=https://gist.githubusercontent.com/user/gist-id/raw/schema.json
```

> **Note**: Redis runs internally in the Docker network and doesn't require configuration.

### Extracting Elasticsearch API Key

Elasticsearch provides a base64-encoded API key by default. Decode it to get the ID and secret:

```bash
# Decode the base64 key
echo 'YOUR_BASE64_API_KEY' | base64 -d
# Output: <id>:<secret>
```

Use the parts:
- `ELASTICSEARCH_API_KEY_ID=<id>` (before the colon)
- `ELASTICSEARCH_API_KEY=<secret>` (after the colon)

## Running PGSync

PGSync runs automatically as part of the `docker-compose.yml` stack:

```bash
# Start all services (includes pgsync)
docker compose up -d app

# View logs
docker compose logs -f pgsync

# Restart pgsync only
docker compose restart pgsync
```

The service configuration:
- Runs in daemon mode (`-d`)
- Depends on Redis for checkpointing
- Automatically restarts on failure
- Stores state in Redis (no filesystem checkpoints)

For detailed usage, troubleshooting, and advanced configuration, see the [PGSync Documentation](https://pgsync.com/).
