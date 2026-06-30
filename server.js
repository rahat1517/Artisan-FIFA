const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config({ quiet: true });

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(express.static(__dirname));

function shouldUseDatabaseSsl(connectionString) {
    if (process.env.DATABASE_SSL === 'true') return true;
    if (process.env.DATABASE_SSL === 'false') return false;
    if (!connectionString) return false;

    return !/localhost|127\.0\.0\.1/i.test(connectionString);
}

function getDatabaseConfig() {
    if (process.env.DATABASE_URL) {
        return {
            connectionString: process.env.DATABASE_URL,
            ssl: shouldUseDatabaseSsl(process.env.DATABASE_URL)
                ? { rejectUnauthorized: false }
                : false,
        };
    }

    return {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'GoalTracker',
        password: process.env.PGPASSWORD || 'iit123',
        port: Number(process.env.PGPORT || 5432),
        ssl: false,
    };
}

const pool = new Pool(getDatabaseConfig());

let databaseReadyPromise;

function ensureDatabaseReady() {
    if (!databaseReadyPromise) {
        databaseReadyPromise = ensureTournamentTables().catch(err => {
            databaseReadyPromise = null;
            throw err;
        });
    }

    return databaseReadyPromise;
}

app.use('/api', async (req, res, next) => {
    try {
        await ensureDatabaseReady();
        next();
    } catch (err) {
        console.error('Failed to initialize tournament database tables:', err.message);
        res.status(500).json({ error: 'Database initialization failed.' });
    }
});

async function ensureTournamentTables() {
    await pool.query(`
        DROP VIEW IF EXISTS view_match_history;
        DROP VIEW IF EXISTS view_leaderboard;

        CREATE TABLE IF NOT EXISTS matches (
            match_id SERIAL PRIMARY KEY,
            player1_name TEXT NOT NULL,
            player1_score INTEGER NOT NULL,
            player2_name TEXT NOT NULL,
            player2_score INTEGER NOT NULL,
            match_date DATE NOT NULL DEFAULT CURRENT_DATE
        );

        CREATE TABLE IF NOT EXISTS tournaments (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            format TEXT NOT NULL CHECK (format IN ('round_robin', 'knockout')),
            start_date DATE,
            end_date DATE,
            status TEXT NOT NULL DEFAULT 'Draft',
            champion TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tournament_participants (
            id TEXT PRIMARY KEY,
            tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tournament_matches (
            id TEXT PRIMARY KEY,
            tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            round_no INTEGER NOT NULL,
            p1_id TEXT,
            p2_id TEXT,
            p1_score INTEGER,
            p2_score INTEGER,
            winner_id TEXT,
            status TEXT NOT NULL DEFAULT 'Pending',
            is_bye BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS archive_logs (
            id SERIAL PRIMARY KEY,
            timestamp_text TEXT NOT NULL,
            match_ref TEXT NOT NULL,
            changes_record TEXT NOT NULL,
            cause TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE OR REPLACE VIEW view_match_history AS
        SELECT
            match_id,
            player1_name,
            player1_score,
            player2_name,
            player2_score,
            match_date
        FROM matches
        ORDER BY match_date DESC, match_id DESC;

        CREATE OR REPLACE VIEW view_leaderboard AS
        SELECT
            player_name,
            SUM(goals) AS total_goals,
            SUM(wins) AS total_wins,
            COUNT(*) AS total_matches,
            ROUND(AVG(goals)::numeric, 2) AS goals_per_match
        FROM (
            SELECT
                player1_name AS player_name,
                player1_score AS goals,
                CASE WHEN player1_score > player2_score THEN 1 ELSE 0 END AS wins
            FROM matches
            UNION ALL
            SELECT
                player2_name AS player_name,
                player2_score AS goals,
                CASE WHEN player2_score > player1_score THEN 1 ELSE 0 END AS wins
            FROM matches
        ) player_rows
        GROUP BY player_name
        ORDER BY total_goals DESC, total_wins DESC, player_name ASC;
    `);
}

app.get('/api/matches', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                match_id,
                player1_name,
                player1_score,
                player2_name,
                player2_score,
                to_char(match_date, 'YYYY-MM-DD') AS match_date
            FROM view_match_history
            ORDER BY match_id DESC;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("GET Matches Error:", err.message);
        res.status(500).send('Server Error');
    }
});


app.post('/api/matches', async (req, res) => {
    try {
        const { player1_name, player1_score, player2_name, player2_score, match_date } = req.body;
        
        const newMatch = await pool.query(
            'INSERT INTO matches (player1_name, player1_score, player2_name, player2_score, match_date) VALUES($1, $2, $3, $4, $5) RETURNING *',
            [player1_name, player1_score, player2_name, player2_score, match_date]
        );
        res.json(newMatch.rows[0]);
    } catch (err) {
        console.error("POST Match Error:", err.message);
        res.status(500).send('Server Error');
    }
});


app.put('/api/matches/:id', async (req, res) => {
    try {
        const { id } = req.params; 
        const { player1_name, player1_score, player2_name, player2_score, match_date } = req.body;

        console.log(`Attempting to update match with ID: ${id}`);


        const updateMatch = await pool.query(
            'UPDATE matches SET player1_name = $1, player1_score = $2, player2_name = $3, player2_score = $4, match_date = $5 WHERE match_id = $6 RETURNING *',
            [player1_name, player1_score, player2_name, player2_score, match_date, id]
        );

        if (updateMatch.rows.length === 0) {
            console.log(`⚠️ No row found in 'matches' table for ID: ${id}. Please check if the column name is 'match_id' or 'id'.`);
            return res.status(404).json({ message: "Match record not found in database table." });
        }

        console.log("Match updated successfully in database!");
        res.json(updateMatch.rows[0]);
    } catch (err) {
        console.error("PUT Match Error Details:", err.message);
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/tournament-data', async (req, res) => {
    try {
        const tournamentsResult = await pool.query(`
            SELECT
                id,
                name,
                format,
                to_char(start_date, 'YYYY-MM-DD') AS "startDate",
                to_char(end_date, 'YYYY-MM-DD') AS "endDate",
                status,
                champion,
                created_at AS "createdAt"
            FROM tournaments
            ORDER BY created_at ASC;
        `);

        const participantsResult = await pool.query(`
            SELECT
                id,
                tournament_id AS "tournamentId",
                name,
                created_at AS "createdAt"
            FROM tournament_participants
            ORDER BY created_at ASC;
        `);

        const matchesResult = await pool.query(`
            SELECT
                id,
                tournament_id AS "tournamentId",
                round_no AS "roundNo",
                p1_id AS "p1Id",
                p2_id AS "p2Id",
                p1_score AS "p1Score",
                p2_score AS "p2Score",
                winner_id AS "winnerId",
                status,
                is_bye AS "isBye",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
            FROM tournament_matches
            ORDER BY created_at ASC;
        `);

        res.json({
            tournaments: tournamentsResult.rows,
            participants: participantsResult.rows,
            matches: matchesResult.rows
        });
    } catch (err) {
        console.error("GET Tournament Data Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});


app.put('/api/tournament-data', async (req, res) => {
    const client = await pool.connect();

    try {
        const { tournaments = [], participants = [], matches = [] } = req.body;

        await client.query('BEGIN');
        await client.query('DELETE FROM tournament_matches;');
        await client.query('DELETE FROM tournament_participants;');
        await client.query('DELETE FROM tournaments;');

        for (const tournament of tournaments) {
            await client.query(
                `INSERT INTO tournaments (id, name, format, start_date, end_date, status, champion, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamp, CURRENT_TIMESTAMP));`,
                [
                    tournament.id,
                    tournament.name,
                    tournament.format,
                    tournament.startDate || null,
                    tournament.endDate || null,
                    tournament.status || 'Draft',
                    tournament.champion || '',
                    tournament.createdAt || null
                ]
            );
        }

        for (const participant of participants) {
            await client.query(
                `INSERT INTO tournament_participants (id, tournament_id, name, created_at)
                 VALUES ($1, $2, $3, COALESCE($4::timestamp, CURRENT_TIMESTAMP));`,
                [
                    participant.id,
                    participant.tournamentId,
                    participant.name,
                    participant.createdAt || null
                ]
            );
        }

        for (const match of matches) {
            await client.query(
                `INSERT INTO tournament_matches (
                    id, tournament_id, round_no, p1_id, p2_id, p1_score, p2_score,
                    winner_id, status, is_bye, created_at, updated_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamp, CURRENT_TIMESTAMP), $12);`,
                [
                    match.id,
                    match.tournamentId,
                    match.roundNo,
                    match.p1Id || null,
                    match.p2Id || null,
                    match.p1Score ?? null,
                    match.p2Score ?? null,
                    match.winnerId || null,
                    match.status || 'Pending',
                    Boolean(match.isBye),
                    match.createdAt || null,
                    match.updatedAt || null
                ]
            );
        }

        await client.query('COMMIT');
        res.json({ message: 'Tournament data saved to database.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("PUT Tournament Data Error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/tournaments/:id', async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        await client.query('BEGIN');
        await client.query('DELETE FROM tournament_matches WHERE tournament_id = $1;', [id]);
        await client.query('DELETE FROM tournament_participants WHERE tournament_id = $1;', [id]);

        const result = await client.query(
            'DELETE FROM tournaments WHERE id = $1 RETURNING id;',
            [id]
        );

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Tournament not found.' });
        }

        await client.query('COMMIT');
        res.json({ message: 'Tournament deleted from database.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DELETE Tournament Error:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});


app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM view_leaderboard;');
        res.json(result.rows);
    } catch (err) {
        console.error("GET Leaderboard Error:", err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/archive', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                timestamp_text AS "timestamp",
                match_ref AS "matchRef",
                changes_record AS "changes",
                cause,
                created_at AS "createdAt"
            FROM archive_logs
            ORDER BY id ASC;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("GET Archive Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/archive', async (req, res) => {
    try {
        const { timestamp, matchRef, changes, cause } = req.body;

        if (!timestamp || !matchRef || !changes || !cause) {
            return res.status(400).json({ error: 'timestamp, matchRef, changes, and cause are required.' });
        }

        const result = await pool.query(
            `INSERT INTO archive_logs (timestamp_text, match_ref, changes_record, cause)
             VALUES ($1, $2, $3, $4)
             RETURNING
                id,
                timestamp_text AS "timestamp",
                match_ref AS "matchRef",
                changes_record AS "changes",
                cause,
                created_at AS "createdAt";`,
            [timestamp, matchRef, changes, cause]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error("POST Archive Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

if (require.main === module) {
    ensureDatabaseReady()
        .then(() => {
            app.listen(5000, '0.0.0.0', () => {
                console.log('Backend Server running on port 5000');
                console.log('Tournament database tables are ready.');
            });
        })
        .catch(err => {
            console.error('Failed to initialize tournament database tables:', err.message);
            process.exit(1);
        });
}

module.exports = app;
