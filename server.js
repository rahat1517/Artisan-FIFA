const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); 

const pool = new Pool({
    user: 'postgres',          
    host: 'localhost',
    database: 'GoalTracker', 
    password: 'iit123', 
    port: 5432,
});

app.get('/api/matches', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM view_match_history;');
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


app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM view_leaderboard;');
        res.json(result.rows);
    } catch (err) {
        console.error("GET Leaderboard Error:", err.message);
        res.status(500).send('Server Error');
    }
});

app.listen(5000, '0.0.0.0', () => {
    console.log('Backend Server running on port 5000');
});