
const path = require('path');
require('dotenv').config(); // Charge le .env automatiquement

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

// --- CONFIGURATION GEMINI ---
// Ajout d'une vérification pour éviter que le serveur crash si la clé est absente
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("ERREUR : GEMINI_API_KEY manquante dans le fichier .env");
    process.exit(1); 
}

const genAI = new GoogleGenerativeAI(apiKey);
const modelIA = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- CONFIGURATION SOCKET.IO (AMÉLIORÉE) ---
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"] 
    },
    connectionStateRecovery: {} // Permet de récupérer la session en cas de micro-coupure réseau
});

// --- BASE DE DONNÉES (PERSISTANTE SUR RENDER) ---
// Note: Sur Render, utilisez un "Disk" pour que ce fichier ne disparaisse pas au redémarrage
const dbPath = path.join(__dirname, 'data_cloud.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS mesures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        vitesse REAL, altitude REAL, latitude REAL, longitude REAL, temperature REAL, batterie TEXT
    )`);
});

// --- LOGIQUE SERVEUR ---

io.on('connection', (socket) => {
    console.log(`[Connecté] ID: ${socket.id}`);

    // Réception données Robot (avec validation simple)
    socket.on('donnees_pi', (data) => {
        if(!data) return;
        
        const query = `INSERT INTO mesures (vitesse, altitude, latitude, longitude, temperature, batterie) VALUES (?, ?, ?, ?, ?, ?)`;
        const params = [data.vitesse, data.altitude, data.latitude, data.longitude, data.temperature, data.batterie];
        
        db.run(query, params, (err) => {
            if (err) return console.error("Erreur DB:", err.message);
            io.emit('affichage_app', data); 
        });
    });

    // Chatbot Gemini avec Promesses propres
    socket.on('message_web', async (msg) => {
        if (!msg || msg.trim() === "") return;

        console.log(`[IA Request] ${socket.id}: ${msg}`);

        // Utilisation de db.all enveloppé pour plus de stabilité
        db.all("SELECT altitude, vitesse FROM mesures ORDER BY id DESC LIMIT 3", async (err, rows) => {
            try {
                if (err) throw err;

                const contexte = (rows && rows.length > 0) 
                    ? rows.map(r => `Alt: ${r.altitude}m, Vit: ${r.vitesse}km/h`).join(" | ")
                    : "Aucune donnée actuelle.";

                const prompt = `Tu es un ingénieur de vol. Données : ${contexte}. Question : "${msg}". Réponds en 2 phrases max, technique et français.`;

                const result = await modelIA.generateContent(prompt);
                const text = result.response.text();

                socket.emit('reponse_bot', text);

            } catch (error) {
                console.error("Erreur Gemini/DB:", error.message);
                socket.emit('reponse_bot', "IA indisponible (vérifiez quota ou connexion).");
            }
        });
    });

    socket.on('disconnect', () => console.log(`[Déconnecté] ID: ${socket.id}`));
});

// --- GESTION DU PORT (IMPORTANT POUR RENDER) ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ Serveur actif sur le port ${PORT}`);
});