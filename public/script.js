const socket = io();

// UI Elements
const loginOverlay = document.getElementById('login-overlay');
const nicknameInput = document.getElementById('nickname-input');
const joinBtn = document.getElementById('join-btn');
const styleBtns = document.querySelectorAll('.style-btn');
const bgSourcePortrait = document.getElementById('bg-source-portrait');
const bgImgLandscape = document.getElementById('bg-img-landscape');
const toggleStyleBtn = document.getElementById('toggle-style-btn');
const toastContainer = document.getElementById('toast-container');
const namesContainer = document.getElementById('names-container');

// Canvas Setup
const canvas = document.getElementById('fireworks-canvas');
const ctx = canvas.getContext('2d');

let currentStyle = 'anime';
let myNickname = '';
let isJoined = false;
let userList = {};

// Resize Canvas
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => {
    resizeCanvas();
    renderNames(); // Re-calculate positions on orientation change
});
resizeCanvas();

// --- UI Logic ---

styleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        styleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStyle = btn.dataset.style;
    });
});

joinBtn.addEventListener('click', join);
nicknameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') join();
});

function join() {
    const name = nicknameInput.value.trim();
    if (!name) return alert('請輸入暱稱喔！');
    
    myNickname = name;
    isJoined = true;
    
    updateStyle(currentStyle);
    
    loginOverlay.style.opacity = '0';
    setTimeout(() => {
        loginOverlay.style.display = 'none';
    }, 500);

    socket.emit('user_join', myNickname);
    showToast(`歡迎進入星空，${myNickname}！`);
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

function renderNames() {
    namesContainer.innerHTML = '';
    const isPortrait = window.innerHeight > window.innerWidth;
    
    // Position logic strictly tied to portrait/landscape mode images
    // The exact visual positions in the newly generated images:
    const positions = isPortrait ? [
        { left: 'calc(50% - 12vw)', bottom: '15vh' }, // Capybara
        { left: 'calc(50% + 15vw)', bottom: '12vh' }  // Hamster
    ] : [
        { left: 'calc(50% - 6vw)', bottom: '18vh' }, // Hamster
        { left: 'calc(50% + 8vw)', bottom: '22vh' }  // Capybara
    ];

    Object.values(userList).forEach(user => {
        const nameEl = document.createElement('div');
        nameEl.className = 'floating-name';
        if (currentStyle === 'pixel') nameEl.classList.add('pixel-font');
        
        const posIndex = user.index % 2; 
        const pos = positions[posIndex];
        
        nameEl.style.left = pos.left;
        nameEl.style.bottom = pos.bottom;
        nameEl.textContent = user.nickname;
        
        nameEl.style.animationDelay = `${posIndex * 1.5}s`;
        
        namesContainer.appendChild(nameEl);
    });
}

// --- Socket Events ---

socket.on('init_users', (users) => {
    users.forEach(u => { userList[u.id] = u; });
    renderNames();
});

socket.on('user_joined', (user) => {
    userList[user.id] = user;
    renderNames();
    if (user.nickname !== myNickname) {
        showToast(`${user.nickname} 來了！💕`);
    }
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

// --- Fireworks Canvas Logic ---

const particles = [];
const colors = ['#ff7bac', '#ff4d85', '#a2d2ff', '#ffd166', '#06d6a0', '#fff'];

class Particle {
    constructor(x, y, color, isPixel, isAuto) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.isPixel = isPixel;
        this.isAuto = isAuto;
        
        const angle = Math.random() * Math.PI * 2;
        const speedBase = isAuto ? 3 : 6;
        const speed = Math.random() * speedBase + 1;
        
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        
        if (isPixel) {
            this.vx = Math.round(this.vx * 2) / 2;
            this.vy = Math.round(this.vy * 2) / 2;
        }
        
        this.life = 1.0;
        this.decay = Math.random() * 0.02 + (isAuto ? 0.02 : 0.015);
        this.size = Math.random() * (isAuto ? 2 : 3) + 1;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        
        if (this.isPixel) {
             this.vy += 0.08;
        } else {
             this.vy += 0.05; 
        }
        
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
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
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
            x: x / canvas.width, 
            y: y / canvas.height, 
            color,
            isPixel
        });
    }
}

canvas.addEventListener('click', (e) => {
    if (!isJoined) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Limit fireworks height so they don't block characters at bottom
    // Mobile characters take up more relative height
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
        if (p.life <= 0) {
            particles.splice(i, 1);
        } else {
            p.draw(ctx);
        }
    }
}

animate();
