const { Pool } = require('pg');

const masterPool = new Pool({
  user: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'myapp',
});

const replicaPool = new Pool({
  user: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5433,
  database: 'myapp',
});

// SELECT/WITH go to the replica; everything else (INSERT/UPDATE/DELETE/DDL) goes to master.
// A WITH ... INSERT/UPDATE/DELETE CTE would misclassify as read-only — pass { forceMaster: true } for those.
const READ_ONLY_PATTERN = /^\s*(SELECT|WITH)\b/i;

function query(sql, params = [], options = {}) {
  const useMaster = options.forceMaster || !READ_ONLY_PATTERN.test(sql);
  const pool = useMaster ? masterPool : replicaPool;
  return pool.query(sql, params);
}

module.exports = { query, masterPool, replicaPool };
