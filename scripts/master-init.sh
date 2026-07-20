#!/bin/bash
set -e

# Create replication user on master
psql -U postgres <<EOF
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicator';
GRANT CONNECT ON DATABASE postgres TO replicator;
EOF

echo "Master database initialized with replication user 'replicator'"
