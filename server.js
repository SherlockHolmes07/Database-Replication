const express = require('express');
const db = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Create users table on startup
async function initializeDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database table initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

initializeDatabase();

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Async Read Replication Server', status: 'running' });
});

// WRITE endpoint - uses MASTER
app.post('/api/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await db.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json({
      message: 'User created on MASTER',
      user: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ endpoint - uses REPLICA
app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json({
      message: 'Data read from REPLICA (may be slightly behind master)',
      count: result.rows.length,
      users: result.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ specific user - uses REPLICA
app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      message: 'Data read from REPLICA',
      user: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE endpoint - uses MASTER
app.put('/api/users/:id', async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await db.query(
      'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING *',
      [name, email, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      message: 'User updated on MASTER',
      user: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE endpoint - uses MASTER
app.delete('/api/users/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      message: 'User deleted from MASTER',
      user: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHECK replication status
app.get('/api/replication-status', async (req, res) => {
  try {
    const masterStatus = await db.masterPool.query('SELECT pg_current_wal_lsn() as wal_position;');
    const replicaStatus = await db.replicaPool.query(`
      SELECT
        pg_last_wal_receive_lsn() as last_received,
        pg_last_wal_replay_lsn() as last_replayed,
        pg_is_in_recovery() as is_replica;
    `);

    res.json({
      master: masterStatus.rows[0],
      replica: replicaStatus.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`POST   /api/users              - Create user (writes to MASTER)`);
  console.log(`GET    /api/users              - Get all users (reads from REPLICA)`);
  console.log(`GET    /api/users/:id          - Get user (reads from REPLICA)`);
  console.log(`PUT    /api/users/:id          - Update user (writes to MASTER)`);
  console.log(`DELETE /api/users/:id          - Delete user (writes to MASTER)`);
  console.log(`GET    /api/replication-status - Check replication lag`);
});
