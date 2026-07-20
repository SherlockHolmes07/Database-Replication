// Freezes the replica container, writes to master while it's frozen, then
// unpauses and polls pg_wal_lsn_diff() until the replica fully catches up.
// Usage: node scripts/lag-demo.js [numRows] [pauseMs]
const { Pool } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const NUM_ROWS = parseInt(process.argv[2], 10) || 20000;
const PAUSE_MS = parseInt(process.argv[3], 10) || 5000;
const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 30000;

const masterPool = new Pool({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'myapp' });
const replicaPool = new Pool({ host: 'localhost', port: 5433, user: 'postgres', password: 'postgres', database: 'myapp' });

const logDir = path.join(PROJECT_ROOT, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `lag-demo-${Date.now()}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTable() {
  await masterPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// Multi-row INSERT per batch instead of one round-trip per row — mirrors how
// real bulk writes happen and builds up a WAL backlog fast enough to observe.
async function insertRows(pool, total, batchSize) {
  let inserted = 0;
  while (inserted < total) {
    const count = Math.min(batchSize, total - inserted);
    const params = [];
    const placeholders = [];
    for (let i = 1; i <= count; i++) {
      const rowIndex = inserted + i;
      params.push(`LagTest-${Date.now()}-${rowIndex}`, `lagtest${rowIndex}@example.com`);
      placeholders.push(`($${params.length - 1}, $${params.length})`);
    }
    await pool.query(`INSERT INTO users (name, email) VALUES ${placeholders.join(', ')}`, params);
    inserted += count;
  }
}

async function getMasterWalPosition() {
  const res = await masterPool.query('SELECT pg_current_wal_lsn() AS pos');
  return res.rows[0].pos;
}

async function getReplicaStatus(masterPos) {
  const res = await replicaPool.query(
    `SELECT
       pg_last_wal_receive_lsn() AS received,
       pg_last_wal_replay_lsn() AS replayed,
       pg_wal_lsn_diff($1::pg_lsn, pg_last_wal_replay_lsn()) AS lag_bytes`,
    [masterPos]
  );
  return res.rows[0];
}

async function main() {
  log('=== Replication Lag Demo starting ===');
  log(`Rows to insert while replica is frozen: ${NUM_ROWS}`);
  log(`Freeze duration: ${PAUSE_MS}ms`);
  log(`Log file: ${logFile}`);

  await ensureTable();

  log('Pausing replica container: docker-compose pause postgres-replica');
  execSync('docker-compose pause postgres-replica', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  log('Replica is frozen — it will not respond to ANY query, including its own status, until unpaused.');

  log(`Writing ${NUM_ROWS} rows to MASTER in batches of ${BATCH_SIZE}...`);
  const writeStart = Date.now();
  await insertRows(masterPool, NUM_ROWS, BATCH_SIZE);
  log(`Writes complete in ${Date.now() - writeStart}ms.`);
  const masterPosAfterWrites = await getMasterWalPosition();
  log(`Writes complete. Master WAL position is now: ${masterPosAfterWrites}`);

  log(`Holding replica frozen for ${PAUSE_MS}ms (simulating a stalled/slow replica)...`);
  await sleep(PAUSE_MS);

  log('Unpausing replica: docker-compose unpause postgres-replica');
  execSync('docker-compose unpause postgres-replica', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  log('Replica resumed. Polling until it catches up to master...');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;
  let caughtUp = false;

  while (Date.now() < deadline) {
    pollCount++;
    try {
      const currentMasterPos = await getMasterWalPosition();
      const status = await getReplicaStatus(currentMasterPos);
      log(`poll #${pollCount} | master=${currentMasterPos} | replica_replayed=${status.replayed} | lag_bytes=${status.lag_bytes}`);
      if (Number(status.lag_bytes) <= 0) {
        caughtUp = true;
        log(`Replica fully caught up after ~${pollCount * POLL_INTERVAL_MS}ms of polling since unpause.`);
        break;
      }
    } catch (err) {
      log(`poll #${pollCount} error (replica likely still resuming): ${err.message}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!caughtUp) {
    log('WARNING: replica did not report zero lag within the timeout window.');
  }

  const masterCount = await masterPool.query('SELECT COUNT(*) FROM users');
  const replicaCount = await replicaPool.query('SELECT COUNT(*) FROM users');
  log(`Final row count -> master: ${masterCount.rows[0].count}, replica: ${replicaCount.rows[0].count}`);
  log(`=== Demo complete. Full log saved to: ${logFile} ===`);

  await masterPool.end();
  await replicaPool.end();
  logStream.end();
}

main().catch((err) => {
  log(`FATAL ERROR: ${err.stack || err.message}`);
  process.exitCode = 1;
});
