const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomCode -> { users: { socketId: { nickname, role, index } }, currentStyle }
const rooms = {};
const colors = ['#ff7bac', '#ff4d85', '#a2d2ff', '#ffd166', '#06d6a0', '#ffffff'];

io.on('connection', (socket) => {
  socket.on('join_room', (data, callback) => {
      const { roomCode, nickname, role, style } = data;
      
      if (!rooms[roomCode]) {
          rooms[roomCode] = { users: {}, currentStyle: style };
      }
      
      const room = rooms[roomCode];
      const existingUsersCount = Object.keys(room.users).length;
      
      if (existingUsersCount >= 2) {
          return callback({ success: false, message: '此房間已滿 (最多兩人)！' });
      }
      
      // Prevent role collision
      const rolesTaken = Object.values(room.users).map(u => u.role);
      let assignedRole = role;
      if (rolesTaken.includes(role)) {
          assignedRole = role === 'hamster' ? 'capybara' : 'hamster';
      }
      
      // Index mapping: Hamster = 0, Capybara = 1 (to align with the frontend position logic)
      const index = assignedRole === 'hamster' ? 0 : 1;
      
      room.users[socket.id] = { id: socket.id, nickname, role: assignedRole, index };
      socket.join(roomCode);
      socket.roomCode = roomCode;
      
      // Pass back initial state
      callback({ 
          success: true, 
          users: Object.values(room.users), 
          style: room.currentStyle, 
          assignedRole 
      });
      
      socket.to(roomCode).emit('user_joined', room.users[socket.id]);
  });

  socket.on('firework_click', (data) => {
    if (socket.roomCode) {
        socket.to(socket.roomCode).emit('firework_trigger', data);
    }
  });
  
  socket.on('style_change', (style) => {
      if (socket.roomCode && rooms[socket.roomCode]) {
          rooms[socket.roomCode].currentStyle = style;
          socket.to(socket.roomCode).emit('style_change', style);
      }
  });
  
  socket.on('chat_msg', (msg) => {
      if (socket.roomCode) {
          io.to(socket.roomCode).emit('chat_msg', { userId: socket.id, msg });
      }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
        const room = rooms[socket.roomCode];
        delete room.users[socket.id];
        io.to(socket.roomCode).emit('user_left', socket.id);
        
        // Clean up empty rooms
        if (Object.keys(room.users).length === 0) {
            delete rooms[socket.roomCode];
        }
    }
  });
});

// Auto fireworks loop
setInterval(() => {
    Object.keys(rooms).forEach(roomCode => {
        if (Object.keys(rooms[roomCode].users).length > 0) {
            io.to(roomCode).emit('auto_firework', {
                x: Math.random() * 0.8 + 0.1,
                y: Math.random() * 0.4 + 0.1,
                color: colors[Math.floor(Math.random() * colors.length)],
                isAuto: true
            });
        }
    });
}, 2500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});
