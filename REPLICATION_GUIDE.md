# PostgreSQL Master-Replica Replication Setup Guide

## How PostgreSQL Streaming Replication Works

### Overview
PostgreSQL replication is **asynchronous** by default, meaning:
1. **Master (Primary)** handles all writes
2. **Replica (Standby)** streams changes from master asynchronously
3. **Read operations** can happen on replica (read-only)
4. **Small lag** exists between master and replica (eventual consistency)

### The Replication Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    MASTER DATABASE                          │
│                                                              │
│  1. Write transaction happens                              │
│  2. Changes written to WAL (Write-Ahead Log)               │
│  3. Commits acknowledged to client                         │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ WAL Streaming
                          │ (asynchronous)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   REPLICA DATABASE                          │
│                                                              │
│  1. Receives WAL segments from master                       │
│  2. Applies changes to local database                       │
│  3. Data eventually consistent with master                 │
│  4. Can serve read queries (read-only)                     │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. **WAL (Write-Ahead Logging)**
- All database changes are first written to WAL (transaction log)
- WAL is the source of truth for replication
- Replica reads WAL segments to stay in sync

### 2. **Master Configuration** (postgresql.conf)
```ini
wal_level = replica              # Enable replication
max_wal_senders = 10             # Allow 10 concurrent replication connections
wal_keep_size = 1GB              # Keep 1GB of WAL for replicas to catch up
```

### 3. **Replication User** (pg_hba.conf)
```
host    replication     replicator      0.0.0.0/0               md5
```
- Special user with REPLICATION privilege
- Connects to master to stream WAL

### 4. **Replica Configuration**
- Connects to master via `primary_conninfo`
- Streams WAL segments continuously
- Applies changes asynchronously
- Standby mode = on (read-only)

## Setup Process

### Step 1: Start Containers
```bash
docker-compose up -d
```

### Step 2: How Replica Initializes

The replica uses `pg_basebackup`:
```bash
pg_basebackup -h postgres-master -D /var/lib/postgresql/data -U replicator -v -P -W
```

This:
1. Connects to master as `replicator` user
2. Copies entire master database to replica
3. Creates a consistent snapshot point
4. Replica then streams WAL changes from that point

### Step 3: Replica Connects to Master

The replica's `recovery.conf` contains:
```
standby_mode = 'on'
primary_conninfo = 'host=postgres-master port=5432 user=replicator password=replicator'
```

The replica:
- Enters standby mode (read-only)
- Continuously streams WAL from master
- Applies changes asynchronously
- Stays in sync (with small lag)

## Key Concepts

### Asynchronous Replication (Default)
- Master doesn't wait for replica confirmation
- Lower latency, possible data loss on master crash
- **Used in this setup**

### Synchronous Replication (Alternative)
- Master waits for replica to acknowledge
- Higher latency, no data loss
- Use `synchronous_commit = on`

### Replica Lag
- Time between master write and replica applying it
- Usually milliseconds to seconds
- Check with: `SELECT * FROM pg_stat_replication;`

### Read-Only Mode
- Replica cannot accept writes (enforced by `standby_mode`)
- Application must route writes to master
- Application can route reads to replica

## Testing the Setup

### Connect to Master (write operations)
```bash
psql -h localhost -p 5432 -U postgres -d myapp
```

### Connect to Replica (read operations)
```bash
psql -h localhost -p 5433 -U postgres -d myapp
```

### Test Replication

**On Master:**
```sql
CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));
INSERT INTO users (name) VALUES ('Alice');
INSERT INTO users (name) VALUES ('Bob');
SELECT * FROM users;
```

**On Replica (should see same data):**
```sql
SELECT * FROM users;  -- Should show Alice and Bob
```

### Check Replication Status

**On Master:**
```sql
SELECT * FROM pg_stat_replication;  -- Shows connected replicas
SELECT * FROM pg_current_wal_lsn();  -- Current WAL position
```

**On Replica:**
```sql
SELECT * FROM pg_last_wal_receive_lsn();  -- Last received WAL
SELECT * FROM pg_last_wal_replay_lsn();   -- Last replayed WAL
SELECT pg_is_in_recovery();  -- Should return true (standby mode)
```

## Common Issues & Solutions

### Issue: Replica won't start
**Solution:** Check if master is running and replicator user exists
```bash
docker logs postgres-master
docker logs postgres-replica
```

### Issue: Large replica lag
**Possible causes:**
- Network issues
- Master write load too high
- Replica hardware too slow
- Increase `wal_keep_size` on master

### Issue: Replica crashes after master crash
**Solution:** Either:
1. Promote replica to primary
2. Delete replica data and resync with pg_basebackup

## Failover Scenario

To promote replica to master (in real scenario):
```sql
-- On replica
SELECT pg_promote();
```

This:
1. Stops standby mode
2. Applies remaining WAL
3. Becomes independent master
4. Can now accept writes

## Next Steps

1. **Write a Node.js app** (already have server.js) to:
   - Write to master
   - Read from replica
   - Test eventual consistency

2. **Monitor replication** with queries above

3. **Experiment with:**
   - Stopping replica and restarting
   - Checking lag
   - Adding more replicas
   - Testing failover

4. **Production considerations:**
   - Set up monitoring/alerting for lag
   - Configure synchronous replication if needed
   - Set up automatic failover (e.g., with pg_auto_failover)
   - Regular backups
   - Connection pooling (pgBouncer)
