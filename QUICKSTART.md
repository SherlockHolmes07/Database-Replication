# Quick Start Guide - Master-Replica Replication with Node.js

## What You Have

```
┌─────────────────────┐
│  Node.js Express    │  Separates reads/writes
├─────────────────────┤
│  Master DB (Write)  │◄──────┐
├─────────────────────┤       │
│  Replica DB (Read)  │◄──────┘ WAL Streaming
└─────────────────────┘
```

## Setup Steps

### 1. Start Containers
```bash
docker-compose up -d
```

Wait for both containers to be healthy (~10-15 seconds):
```bash
docker-compose ps
# Both should show "healthy"
```

### 2. Install Node.js Dependencies
```bash
npm install
```

### 3. Start the Express Server
```bash
npm start
```

You should see:
```
Server is running on http://localhost:3000
POST   /api/users              - Create user (writes to MASTER)
GET    /api/users              - Get all users (reads from REPLICA)
...
```

## Testing the Replication

### Test 1: Write to Master
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'
```

Response (data written to MASTER):
```json
{
  "message": "User created on MASTER",
  "user": {
    "id": 1,
    "name": "Alice",
    "email": "alice@example.com",
    "created_at": "2026-07-20T10:30:00.000Z"
  }
}
```

### Test 2: Read from Replica (almost immediately)
```bash
curl http://localhost:3000/api/users
```

You should see Alice in the response! The replica synced automatically.

```json
{
  "message": "Data read from REPLICA (may be slightly behind master)",
  "count": 1,
  "users": [
    {
      "id": 1,
      "name": "Alice",
      "email": "alice@example.com",
      "created_at": "2026-07-20T10:30:00.000Z"
    }
  ]
}
```

### Test 3: Add More Users
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Bob", "email": "bob@example.com"}'

curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Charlie", "email": "charlie@example.com"}'
```

### Test 4: Read All Users from Replica
```bash
curl http://localhost:3000/api/users
```

All 3 users should appear in replica.

### Test 5: Check Replication Status (see the lag!)
```bash
curl http://localhost:3000/api/replication-status
```

Response shows:
```json
{
  "master": {
    "wal_position": "0/3000000"  ◄── Master's WAL position
  },
  "replica": {
    "last_received": "0/3000000",  ◄── What replica received
    "last_replayed": "0/3000000",  ◄── What replica applied
    "is_replica": true              ◄── Replica mode confirmed
  }
}
```

### Test 6: Simulate Read-Only Replica (try to write)
Try writing directly to replica (should fail):
```bash
# This will fail because replica is read-only
psql -h localhost -p 5433 -U postgres -d myapp -c \
  "INSERT INTO users (name, email) VALUES ('Direct', 'direct@example.com');"
```

Error: `ERROR: cannot execute INSERT in a read-only transaction`

## HTTP API Reference

### Create User (MASTER)
```
POST /api/users
Content-Type: application/json

{
  "name": "John",
  "email": "john@example.com"
}
```

### Get All Users (REPLICA)
```
GET /api/users
```

### Get User by ID (REPLICA)
```
GET /api/users/:id
```

### Update User (MASTER)
```
PUT /api/users/:id
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john.doe@example.com"
}
```

### Delete User (MASTER)
```
DELETE /api/users/:id
```

### Check Replication Status (INFO)
```
GET /api/replication-status
```

## Understanding What's Happening

### Write Flow (to Master)
```
Your App Request
    ↓
Express Server
    ↓
Master Database (5432)
    ↓
WAL Log (Write-Ahead Log)
    ↓
Response sent to client
    ↓
[Master doesn't wait for replica confirmation]
```

### Read Flow (from Replica)
```
Your App Request
    ↓
Express Server
    ↓
Replica Database (5433)
    ↓
Data returned
```

### Asynchronous Sync (happens automatically)
```
Master's WAL changes
    ↓
Network Stream
    ↓
Replica Receives WAL
    ↓
Replica Applies Changes
    ↓
[Small lag: usually milliseconds to seconds]
```

## Observing Replication Lag

The replica might be **slightly behind** the master (usually <1 second). To observe:

1. Insert a user on master
2. Immediately read from replica
3. Check `/api/replication-status` to see WAL positions

The `last_replayed` (replica) will be slightly behind `wal_position` (master).

## Common Questions

**Q: Why write to master and read from replica?**
A: This is a common pattern for scaling read-heavy applications. Master handles all writes (bottleneck), replicas handle all reads (can scale horizontally).

**Q: Can I have multiple replicas?**
A: Yes! Add more replicas in docker-compose.yml. All stream from the same master.

**Q: What if master crashes?**
A: Replica has the data but it's read-only. You'd promote it to master (production setups use automatic failover).

**Q: How much lag is acceptable?**
A: Depends on use case. Most setups have <100ms lag. You can check with replication-status endpoint.

**Q: Can I make it synchronous?**
A: Yes, change `synchronous_commit = on` in master's postgresql.conf. But it's slower.

## Clean Up

Stop containers:
```bash
docker-compose down
```

Remove volumes (reset databases):
```bash
docker-compose down -v
```

## Next Steps

1. **Monitor replication** - keep checking `/api/replication-status`
2. **Test failover** - stop master, see replica still serves reads
3. **Add connection pooling** - use pgBouncer for production
4. **Test with load** - insert many users, observe lag
5. **Study the code** - understand master/replica pool separation in server.js

See `REPLICATION_GUIDE.md` for deeper technical details!
