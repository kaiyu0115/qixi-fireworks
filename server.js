const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let connectedUsers = 0;
// Track users to assign positions (0: left character, 1: right character, etc)
const users = {};
const colors = ['#ff7bac', '#ff4d85', '#a2d2ff', '#ffd166', '#06d6a0', '#ffffff'];

io.on('connection', (socket) => {
  connectedUsers++;
  console.log(`User connected. Total: ${connectedUsers}`);

  socket.on('user_join', (nickname) => {
    const existingIndices = Object.values(users).map(u => u.index);
    let assignedIndex = 0;
    while (existingIndices.includes(assignedIndex)) {
        assignedIndex++;
    }

    users[socket.id] = { id: socket.id, nickname, index: assignedIndex };
    
    // Send all existing users to the new user
    socket.emit('init_users', Object.values(users));
    
    // Broadcast the new user to others
    socket.broadcast.emit('user_joined', users[socket.id]);
  });

  socket.on('firework_click', (data) => {
    socket.broadcast.emit('firework_trigger', data);
  });
  
  socket.on('style_change', (style) => {
      socket.broadcast.emit('style_change', style);
  });

  socket.on('disconnect', () => {
    connectedUsers--;
    console.log(`User disconnected. Total: ${connectedUsers}`);
    if (users[socket.id]) {
        const leftUser = users[socket.id];
        delete users[socket.id];
        io.emit('user_left', leftUser.id);
    }
  });
});

// Auto fireworks loop
setInterval(() => {
    if (Object.keys(users).length > 0) {
        io.emit('auto_firework', {
            x: Math.random() * 0.8 + 0.1, // 0.1 to 0.9 width
            y: Math.random() * 0.4 + 0.1, // upper area 0.1 to 0.5 height
            color: colors[Math.floor(Math.random() * colors.length)],
            isAuto: true
        });
    }
}, 2500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});
