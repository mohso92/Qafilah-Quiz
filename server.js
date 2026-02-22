const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // أضفنا هذه الأداة لتوجيه الروابط إجبارياً

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// توجيه إجباري لصفحات الموقع
app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

let quizzes = []; 
let pastResults = []; 
let players = {};
let currentQuiz = null;
let currentQuestionIndex = -1;
let timer;
let timeLeft = 15;
let isQuestionActive = false;
let highestStreakData = { name: '', streak: 0 };

io.on('connection', (socket) => {
    
    // الإدارة
    socket.on('adminLogin', (password) => {
        if(password === "1234") socket.emit('adminAuthSuccess', { quizzes, pastResults });
        else socket.emit('adminAuthFailed');
    });

    socket.on('saveNewQuiz', (newQuiz) => {
        newQuiz.id = "q" + Date.now();
        quizzes.push(newQuiz);
        socket.emit('quizzesUpdated', quizzes);
    });

    socket.on('deleteQuiz', (quizId) => {
        quizzes = quizzes.filter(q => q.id !== quizId);
        socket.emit('quizzesUpdated', quizzes);
    });

    // اللاعبين
    socket.on('joinGame', (playerName) => {
        players[socket.id] = { 
            id: socket.id, name: playerName, score: 0, answered: false, 
            pendingPoints: 0, lastAnswer: null, streak: 0,
            previousRank: 0, currentRank: 0, rankChange: 0
        };
        io.emit('updateLobby', Object.values(players));
    });

    socket.on('submitAnswer', (answerIndex) => {
        if (isQuestionActive && players[socket.id] && !players[socket.id].answered) {
            let p = players[socket.id];
            p.answered = true;
            p.lastAnswer = answerIndex;
            
            let q = currentQuiz.questions[currentQuestionIndex];
            let multiplier = q.isDouble ? 2 : 1;
            
            if (answerIndex === q.answer) {
                p.pendingPoints = Math.round((500 + (500 * (timeLeft / 15))) * multiplier);
            } else {
                p.pendingPoints = 0;
            }

            let answeredCount = Object.values(players).filter(pl => pl.answered).length;
            let totalPlayers = Object.keys(players).length;
            io.emit('answerCountUpdated', answeredCount, totalPlayers);

            if(answeredCount >= totalPlayers && totalPlayers > 0) {
                endCurrentQuestion();
            }
        }
    });

    socket.on('skipQuestion', () => {
        if(isQuestionActive) endCurrentQuestion();
    });

    socket.on('startQuiz', (quizId) => {
        currentQuiz = quizzes.find(q => q.id === quizId);
        currentQuestionIndex = -1;
        highestStreakData = { name: '', streak: 0 };
        for (let id in players) {
            players[id].score = 0; players[id].streak = 0;
            players[id].previousRank = 0; players[id].currentRank = 0;
        }
        io.emit('quizStarted', currentQuiz);
    });

    socket.on('nextPhase', (phase) => {
        if (phase === 'leaderboard') {
            io.emit('showIntermediateLeaderboard', {
                leaderboard: getLeaderboard().slice(0, 10),
                streakData: highestStreakData
            }); 
        } 
        else if (phase === 'nextQuestion') {
            currentQuestionIndex++;
            if (currentQuestionIndex < currentQuiz.questions.length) {
                startQuestionSequence();
            } else {
                let finalBoard = getLeaderboard();
                pastResults.push({
                    id: Date.now(),
                    title: currentQuiz.title,
                    date: new Date().toLocaleString('ar-SA'),
                    leaderboard: finalBoard
                });
                io.emit('endGame', finalBoard);
                io.emit('resultsUpdated', pastResults); 
            }
        }
    });

    socket.on('podiumFinished', () => {
        for (let id in players) {
            io.to(id).emit('showFinalRank', { rank: players[id].currentRank, score: players[id].score });
        }
    });
});

function startQuestionSequence() {
    for (let id in players) {
        players[id].answered = false; players[id].pendingPoints = 0; players[id].lastAnswer = null;
    }
    let q = currentQuiz.questions[currentQuestionIndex];
    io.emit('prepareQuestion', { question: q.question, options: q.options, isDouble: q.isDouble, totalPlayers: Object.keys(players).length });
    
    setTimeout(() => {
        isQuestionActive = true; timeLeft = 15;
        io.emit('startQuestion', timeLeft);
        clearInterval(timer);
        timer = setInterval(() => {
            timeLeft--;
            io.emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) endCurrentQuestion();
        }, 1000);
    }, 3000);
}

function endCurrentQuestion() {
    if(!isQuestionActive) return; 
    clearInterval(timer); isQuestionActive = false;
    
    let q = currentQuiz.questions[currentQuestionIndex];
    let oldLeaderboard = getLeaderboard();
    oldLeaderboard.forEach((p, index) => { p.previousRank = index + 1; });

    let stats = [0, 0, 0, 0]; let totalAnswers = 0;
    
    for (let id in players) {
        let p = players[id];
        if (p.answered && p.lastAnswer !== null) { stats[p.lastAnswer]++; totalAnswers++; }
        if (p.lastAnswer === q.answer && p.answered) {
            p.score += p.pendingPoints; p.streak++;
            if (p.streak > highestStreakData.streak) highestStreakData = { name: p.name, streak: p.streak };
        } else { p.streak = 0; }
    }

    let newLeaderboard = getLeaderboard();
    newLeaderboard.forEach((p, index) => {
        p.currentRank = index + 1;
        p.rankChange = p.previousRank === 0 ? 0 : p.previousRank - p.currentRank; 
    });

    io.emit('showCorrectAnswer', { answer: q.answer, stats: stats, totalAnswers: totalAnswers });
    
    for (let id in players) {
        let p = players[id];
        let isCorrect = (p.lastAnswer === q.answer && p.answered);
        io.to(id).emit('questionResult', { correct: isCorrect, pointsGained: isCorrect ? p.pendingPoints : 0, rank: p.currentRank, score: p.score, answered: p.answered });
    }
}

function getLeaderboard() { return Object.values(players).sort((a, b) => b.score - a.score); }

server.listen(3000, () => console.log('Server is running on port 3000'));
