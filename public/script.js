const socket = io();

const loginOverlay = document.getElementById('login-overlay');
const nicknameInput = document.getElementById('nickname-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const styleBtns = document.querySelectorAll('.style-btn');
const roleBtns = document.querySelectorAll('.role-btn');
const bgSourcePortrait = document.getElementById('bg-source-portrait');
const bgImgLandscape = document.getElementById('bg-img-landscape');
const toggleStyleBtn = document.getElementById('toggle-style-btn');
const toastContainer = document.getElementById('toast-container');
const namesContainer = document.getElementById('names-container');
const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');

const canvas = document.getElementById('fireworks-canvas');
const ctx = canvas.getContext('2d');

let currentStyle = 'anime';
let currentRole = 'hamster';
let myNickname = '';
let myUserId = null;
let isJoined = false;
let userList = {};

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => {
    resizeCanvas();
    renderNames();
});
resizeCanvas();

// UI Events
styleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        styleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStyle = btn.dataset.style;
    });
});

roleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        roleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRole = btn.dataset.role;
    });
});

joinBtn.addEventListener('click', join);
nicknameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') join();
});

function join() {
    const room = roomInput.value.trim();
    const name = nicknameInput.value.trim();
    if (!room) return alert('請輸入房間密碼！');
    if (!name) return alert('請輸入暱稱喔！');
    
    myNickname = name;
    
    socket.emit('join_room', { roomCode: room, nickname: name, role: currentRole, style: currentStyle }, (res) => {
        if (!res.success) {
            alert(res.message);
            return;
        }
        
        myUserId = socket.id;
        isJoined = true;
        
        if (res.assignedRole !== currentRole) {
            alert(`你選擇的角色已經被佔用了，系統自動為你分配：${res.assignedRole === 'hamster' ? '倉鼠' : '卡皮巴拉'}！`);
            currentRole = res.assignedRole;
        }
        
        updateStyle(res.style);
        
        userList = {}; // Clear old list
        res.users.forEach(u => { userList[u.id] = u; });
        renderNames();
        
        loginOverlay.style.opacity = '0';
        setTimeout(() => {
            loginOverlay.style.display = 'none';
        }, 500);

        chatContainer.style.display = 'block';
        showToast(`成功進入房間 [${room}]！`);
    });
}

function updateStyle(styleName) {
    currentStyle = styleName;
    bgImgLandscape.style.opacity = '0.8';
    setTimeout(() => {
        bgSourcePortrait.srcset = `assets/${styleName}_9x16.jpg`;
        bgImgLandscape.src = `assets/${styleName}_16x9.jpg`;
        bgImgLandscape.style.opacity = '1';
    }, 150);
    renderNames();
}

toggleStyleBtn.addEventListener('click', () => {
    const newStyle = currentStyle === 'anime' ? 'pixel' : 'anime';
    updateStyle(newStyle);
    socket.emit('style_change', newStyle);
    showToast(`已切換至${newStyle === 'anime' ? '動畫' : '像素'}風格`);
});

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// Coordinate calculations
function getCharacterPositions() {
    const isPortrait = window.innerHeight > window.innerWidth;
    return isPortrait ? [
        { left: 'calc(50% - 12vw)', bottom: '15vh' }, // Hamster (Index 0)
        { left: 'calc(50% + 15vw)', bottom: '12vh' }  // Capybara (Index 1)
    ] : [
        { left: 'calc(50% - 6vw)', bottom: '18vh' }, // Hamster (Index 0)
        { left: 'calc(50% + 8vw)', bottom: '22vh' }  // Capybara (Index 1)
    ];
}

function renderNames() {
    namesContainer.innerHTML = '';
    const positions = getCharacterPositions();

    Object.values(userList).forEach(user => {
        const nameEl = document.createElement('div');
        nameEl.className = 'floating-name';
        if (currentStyle === 'pixel') nameEl.classList.add('pixel-font');
        
        const pos = positions[user.index];
        nameEl.style.left = pos.left;
        nameEl.style.bottom = pos.bottom;
        nameEl.textContent = user.nickname;
        nameEl.style.animationDelay = `${user.index * 1.5}s`;
        
        namesContainer.appendChild(nameEl);
    });
}

// Chat logic
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg) {
            socket.emit('chat_msg', msg);
            chatInput.value = '';
            
            // Show my own bubble immediately
            showSpeechBubble(myUserId, msg);
        }
    }
});

socket.on('chat_msg', (data) => {
    // Only show if it's someone else (own bubble already shown)
    if (data.userId !== myUserId) {
        showSpeechBubble(data.userId, data.msg);
    }
});

function showSpeechBubble(userId, msg) {
    const user = userList[userId];
    if (!user) return;
    
    const positions = getCharacterPositions();
    const pos = positions[user.index];
    
    const bubble = document.createElement('div');
    bubble.className = 'speech-bubble';
    if (currentStyle === 'pixel') bubble.classList.add('pixel-bubble');
    bubble.textContent = msg;
    
    bubble.style.left = pos.left;
    bubble.style.bottom = `calc(${pos.bottom} + 40px)`;
    
    namesContainer.appendChild(bubble);
    setTimeout(() => bubble.remove(), 5000);
}

// Socket Events
socket.on('user_joined', (user) => {
    userList[user.id] = user;
    renderNames();
    showToast(`${user.nickname} 來了！💕`);
});

socket.on('user_left', (userId) => {
    if (userList[userId]) {
        delete userList[userId];
        renderNames();
    }
});

socket.on('style_change', (style) => {
    updateStyle(style);
    showToast(`另一半將風格切換為${style === 'anime' ? '動畫' : '像素'}風格了`);
});

socket.on('firework_trigger', (data) => {
    const x = data.x * canvas.width;
    const y = data.y * canvas.height;
    createFirework(x, y, data.color, false, data.isPixel);
});

socket.on('auto_firework', (data) => {
    const x = data.x * canvas.width;
    const y = data.y * canvas.height;
    createFirework(x, y, data.color, false, currentStyle === 'pixel', true);
});

// Fireworks Canvas Logic
const particles = [];
const colors = ['#ff7bac', '#ff4d85', '#a2d2ff', '#ffd166', '#06d6a0', '#fff'];

class Particle {
    constructor(x, y, color, isPixel, isAuto) {
        this.x = x; this.y = y; this.color = color;
        this.isPixel = isPixel; this.isAuto = isAuto;
        
        const angle = Math.random() * Math.PI * 2;
        const speedBase = isAuto ? 3 : 6;
        const speed = Math.random() * speedBase + 1;
        
        this.vx = Math.cos(angle) * speed; this.vy = Math.sin(angle) * speed;
        
        if (isPixel) {
            this.vx = Math.round(this.vx * 2) / 2; this.vy = Math.round(this.vy * 2) / 2;
        }
        
        this.life = 1.0;
        this.decay = Math.random() * 0.02 + (isAuto ? 0.02 : 0.015);
        this.size = Math.random() * (isAuto ? 2 : 3) + 1;
    }

    update() {
        this.x += this.vx; this.y += this.vy;
        this.vy += this.isPixel ? 0.08 : 0.05; 
        this.life -= this.decay;
    }

    draw(ctx) {
        ctx.globalAlpha = this.isAuto ? this.life * 0.5 : this.life;
        ctx.fillStyle = this.color;
        
        if (this.isPixel) {
            const pSize = Math.max(3, Math.floor(this.size * 1.5));
            const px = Math.floor(this.x / pSize) * pSize;
            const py = Math.floor(this.y / pSize) * pSize;
            ctx.fillRect(px, py, pSize, pSize);
        } else {
            ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); ctx.fill();
        }
    }
}

function createFirework(x, y, color, emit = true, isPixel = false, isAuto = false) {
    const pCount = isAuto ? 30 : 80;
    for (let i = 0; i < pCount; i++) {
        particles.push(new Particle(x, y, color, isPixel, isAuto));
    }
    
    if (emit) {
        socket.emit('firework_click', { 
            x: x / canvas.width, y: y / canvas.height, color, isPixel
        });
    }
}

canvas.addEventListener('click', (e) => {
    if (!isJoined) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const isPortrait = window.innerHeight > window.innerWidth;
    const safeZoneRatio = isPortrait ? 0.5 : 0.6;
    const limitY = canvas.height * safeZoneRatio; 
    const finalY = y > limitY ? limitY : y;
    
    const color = colors[Math.floor(Math.random() * colors.length)];
    createFirework(x, finalY, color, true, currentStyle === 'pixel');
});

function animate() {
    requestAnimationFrame(animate);
    
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = currentStyle === 'pixel' ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.globalCompositeOperation = 'lighter';
    
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.update();
        if (p.life <= 0) particles.splice(i, 1);
        else p.draw(ctx);
    }
}
animate();
