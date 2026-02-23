// 1. server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

const ACCOUNTS = {
    'qafilatalmithaq': { pass: 'Mithaq5566', title: 'قافلة الميثاق', logo: 'https://i.postimg.cc/h4Q0J4Bz/LOGO3_(2).png' },
    'mohso92': { pass: 'Mosh2468', title: 'لعبة محمد عبدالله', logo: 'https://i.postimg.cc/SQ6MLkcv/shʿar-mhmd-4.png' },
    'alsbtain.m': { pass: 'Ms22774411', title: 'مسجد السبطين', logo: 'https://i.postimg.cc/kMYdptNn/msjd-alsbtyn.png' }
};

const MONGO_URI = process.env.MONGO_URI;
let dbFallback = {};
for (let k in ACCOUNTS) dbFallback[k] = { quizzes: [], pastResults: [] };

const userSchema = new mongoose.Schema({ username: String, quizzes: Array, pastResults: Array });
const User = mongoose.models.User || mongoose.model('User', userSchema);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI).then(async () => {
        for (let uname of Object.keys(ACCOUNTS)) {
            let u = await User.findOne({ username: uname });
            if (!u) await User.create({ username: uname, quizzes: [], pastResults: [] });
        }
    }).catch(err => console.log(err));
}

async function getUserData(username) {
    if(MONGO_URI) {
        let u = await User.findOne({ username });
        return u ? { quizzes: u.quizzes, pastResults: u.pastResults } : { quizzes: [], pastResults: [] };
    }
    return dbFallback[username];
}

async function saveUserData(username, data) {
    if(MONGO_URI) await User.updateOne({ username }, { quizzes: data.quizzes, pastResults: data.pastResults });
    else dbFallback[username] = data;
}

let rooms = {}; 

io.on('connection', (socket) => {
    socket.on('adminLogin', async (data) => {
        const { username, password } = data;
        if (ACCOUNTS[username] && ACCOUNTS[username].pass === password) {
            socket.username = username;
            let userData = await getUserData(username);
            socket.emit('adminAuthSuccess', { quizzes: userData.quizzes, pastResults: userData.pastResults, settings: ACCOUNTS[username] });
        } else socket.emit('adminAuthFailed');
    });

    socket.on('saveNewQuiz', async (newQuiz) => {
        if(!socket.username) return;
        let userData = await getUserData(socket.username);
        newQuiz.id = "q" + Date.now(); userData.quizzes.push(newQuiz);
        await saveUserData(socket.username, userData);
        socket.emit('quizzesUpdated', userData.quizzes);
    });

    socket.on('deleteQuiz', async (quizId) => {
        if(!socket.username) return;
        let userData = await getUserData(socket.username);
        userData.quizzes = userData.quizzes.filter(q => q.id !== quizId);
        await saveUserData(socket.username, userData);
        socket.emit('quizzesUpdated', userData.quizzes);
    });

    socket.on('startQuiz', async (quizId) => {
        if(!socket.username) return;
        let userData = await getUserData(socket.username);
        let quiz = userData.quizzes.find(q => q.id === quizId);
        if(!quiz) return;

        let pin = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[pin] = { pin, hostId: socket.id, hostUser: socket.username, quiz, settings: ACCOUNTS[socket.username], phase: 'lobby', currentQuestionIndex: -1, players: {}, timeLeft: 15, isQuestionActive: false, highestStreakData: { name: '', streak: 0 } };
        socket.join(pin);
        socket.emit('quizStarted', { quiz, pin, settings: ACCOUNTS[socket.username] });
    });

    socket.on('joinGame', (data) => {
        let { pin, name } = data;
        let room = rooms[pin];
        if(!room) return socket.emit('joinError', 'Invalid PIN');
        if(room.phase !== 'lobby') return socket.emit('joinError', 'Game started');

        let existingId = Object.keys(room.players).find(id => room.players[id].name === name);
        if(existingId) { let p = room.players[existingId]; delete room.players[existingId]; p.id = socket.id; room.players[socket.id] = p; } 
        else room.players[socket.id] = { id: socket.id, name, score: 0, answered: false, pendingPoints: 0, lastAnswer: null, streak: 0, previousRank: 0, currentRank: 0, rankChange: 0 };

        socket.join(pin);
        io.to(room.hostId).emit('updateLobby', Object.values(room.players));
        socket.emit('joinSuccess', { quizName: room.quiz.title, settings: room.settings });
    });

    socket.on('kickPlayer', (data) => {
        let { pin, playerId } = data; let room = rooms[pin];
        if(room && room.hostId === socket.id && room.players[playerId]) { delete room.players[playerId]; io.to(playerId).emit('kicked'); socket.emit('updateLobby', Object.values(room.players)); }
    });

    socket.on('submitAnswer', (data) => {
        let { pin, answerIndex } = data; let room = rooms[pin];
        if (room && room.isQuestionActive && room.players[socket.id] && !room.players[socket.id].answered) {
            let p = room.players[socket.id]; p.answered = true; p.lastAnswer = answerIndex;
            let q = room.quiz.questions[room.currentQuestionIndex];
            p.pendingPoints = answerIndex === q.answer ? Math.round((500 + (500 * (room.timeLeft / 15))) * (q.isDouble ? 2 : 1)) : 0;
            let answeredCount = Object.values(room.players).filter(pl => pl.answered).length;
            let totalPlayers = Object.keys(room.players).length;
            io.to(room.hostId).emit('answerCountUpdated', answeredCount, totalPlayers);
            if(answeredCount >= totalPlayers && totalPlayers > 0) endQuestion(pin);
        }
    });

    socket.on('skipQuestion', (pin) => { if(rooms[pin] && rooms[pin].isQuestionActive) endQuestion(pin); });

    socket.on('nextPhase', async (data) => {
        let { pin, phase } = data; let room = rooms[pin];
        if(!room) return;
        if (phase === 'leaderboard') { room.phase = 'leaderboard'; io.to(room.hostId).emit('showIntermediateLeaderboard', { leaderboard: getLeaderboard(room).slice(0, 10), streakData: room.highestStreakData }); } 
        else if (phase === 'nextQuestion') {
            room.currentQuestionIndex++;
            if (room.currentQuestionIndex < room.quiz.questions.length) startQuestionSequence(pin);
            else {
                room.phase = 'finale'; let finalBoard = getLeaderboard(room); let userData = await getUserData(room.hostUser);
                userData.pastResults.push({ id: Date.now(), title: room.quiz.title, date: new Date().toLocaleString('ar-SA'), leaderboard: finalBoard });
                await saveUserData(room.hostUser, userData); io.to(room.hostId).emit('endGame', finalBoard); socket.emit('resultsUpdated', userData.pastResults);
            }
        }
    });

    socket.on('podiumFinished', (pin) => { let room = rooms[pin]; if(room) { for (let id in room.players) io.to(id).emit('showFinalRank', { rank: room.players[id].currentRank, score: room.players[id].score }); setTimeout(() => delete rooms[pin], 300000); } });
});

function startQuestionSequence(pin) {
    let room = rooms[pin]; room.phase = 'question';
    for (let id in room.players) { room.players[id].answered = false; room.players[id].pendingPoints = 0; room.players[id].lastAnswer = null; }
    let q = room.quiz.questions[room.currentQuestionIndex];
    io.to(room.hostId).emit('prepareQuestion', { question: q.question, options: q.options, isDouble: q.isDouble, totalPlayers: Object.keys(room.players).length, pin });
    io.to(pin).emit('playerPrepareQuestion', { question: q.question, options: q.options });
    setTimeout(() => {
        room.isQuestionActive = true; room.timeLeft = 15;
        io.to(room.hostId).emit('startQuestion', room.timeLeft); io.to(pin).emit('playerStartQuestion'); 
        clearInterval(room.timer);
        room.timer = setInterval(() => { room.timeLeft--; io.to(room.hostId).emit('timerUpdate', room.timeLeft); if (room.timeLeft <= 0) endQuestion(pin); }, 1000);
    }, 3000);
}

function endQuestion(pin) {
    let room = rooms[pin]; if(!room || !room.isQuestionActive) return;
    clearInterval(room.timer); room.isQuestionActive = false; room.phase = 'answer';
    let q = room.quiz.questions[room.currentQuestionIndex];
    let oldLeaderboard = getLeaderboard(room); oldLeaderboard.forEach((p, index) => p.previousRank = index + 1);
    let stats = [0, 0, 0, 0]; let totalAnswers = 0;
    for (let id in room.players) {
        let p = room.players[id];
        if (p.answered && p.lastAnswer !== null) { stats[p.lastAnswer]++; totalAnswers++; }
        if (p.lastAnswer === q.answer && p.answered) { p.score += p.pendingPoints; p.streak++; if (p.streak > room.highestStreakData.streak) room.highestStreakData = { name: p.name, streak: p.streak }; } else p.streak = 0;
    }
    let newLeaderboard = getLeaderboard(room); newLeaderboard.forEach((p, index) => { p.currentRank = index + 1; p.rankChange = p.previousRank === 0 ? 0 : p.previousRank - p.currentRank; });
    io.to(room.hostId).emit('showCorrectAnswer', { answer: q.answer, stats, totalAnswers });
    for (let id in room.players) { let p = room.players[id]; let isCorrect = (p.lastAnswer === q.answer && p.answered); io.to(id).emit('questionResult', { correct: isCorrect, pointsGained: isCorrect ? p.pendingPoints : 0, rank: p.currentRank, score: p.score, answered: p.answered }); }
}
function getLeaderboard(room) { return Object.values(room.players).sort((a, b) => b.score - a.score); }
server.listen(3000);
