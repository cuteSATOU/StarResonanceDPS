// 全局变量
let isPaused = false;
let currentSortMode = 'hp';
let currentPlayers = [];
let playerCards = []; // 预生成的卡片数组
const MAX_CARDS = 20; // 最大卡片数量
let isAlwaysOnTop = true; // 默认置顶

// 职业映射
const professionMap = {
    雷影剑士: { type: 'damage', color: '#e74c3c', short_name: '太刀' },
    冰魔导师: { type: 'damage', color: '#e74c3c', short_name: '冰法' },
    青岚骑士: { type: 'damage', color: '#e74c3c', short_name: '长枪' },
    神射手: { type: 'damage', color: '#e74c3c', short_name: '弓箭' },
    '涤罪恶火·战斧': { type: 'damage', color: '#e74c3c', short_name: '战斧' },
    '雷霆一闪·手炮': { type: 'damage', color: '#e74c3c', short_name: '手炮' },
    '暗灵祈舞·仪刀/仪仗': { type: 'damage', color: '#e74c3c', short_name: '仪刀' },
    森语者: { type: 'heal', color: '#27ae60', short_name: '森语' },
    灵魂乐手: { type: 'heal', color: '#27ae60', short_name: '吉他' },
    巨刃守护者: { type: 'tank', color: '#2980b9', short_name: '巨刃' },
    神盾骑士: { type: 'tank', color: '#2980b9', short_name: '剑盾' },
};

// 初始化Electron IPC通信
function initializeIPC() {
    if (window.electronAPI) {
        // 监听玩家数据更新
        window.electronAPI.onPlayerDataUpdate((data) => {
            if (!isPaused && data && data.user) {
                processData(data.user);
            }
        });



        // 请求初始数据
        window.electronAPI.requestPlayerData();
    }
}

// 窗口控制功能
function initializeWindowControls() {
    const minimizeBtn = document.getElementById('minimizeBtn');
    const pinBtn = document.getElementById('pinBtn');

    // 设置初始置顶按钮状态
    pinBtn.classList.toggle('active', isAlwaysOnTop);

    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) {
            window.electronAPI.minimizeHpWindow();
        }
    });

    pinBtn.addEventListener('click', () => {
        if (window.electronAPI) {
            isAlwaysOnTop = !isAlwaysOnTop;
            window.electronAPI.setHpWindowAlwaysOnTop(isAlwaysOnTop);
            pinBtn.classList.toggle('active', isAlwaysOnTop);
        }
    });


}



// 判断角色是否未参与战斗
function isUserInactive(user) {
    // 检查总伤害、总DPS、总HPS是否都为0
    const totalDamage = user.total_damage?.total || 0;
    const totalDps = user.total_dps || 0;
    const totalHps = user.total_hps || 0;

    // 检查暴击率和幸运率是否为NaN
    const critRate = user.total_count?.critical / user.total_count?.total;
    const luckyRate = user.total_count?.lucky / user.total_count?.total;

    return (totalDamage === 0 && totalDps === 0 && totalHps === 0) || (isNaN(critRate) && isNaN(luckyRate));
}

// 处理数据
function processData(users) {
    users = Object.entries(users)
        .map(([id, user]) => ({ ...user, id }))
        .filter((user) => !isUserInactive(user));
    if (!Array.isArray(users)) return;

    // 过滤出有血量数据的用户，最多20个
    let validUsers = users.filter((user) => user.hp !== undefined && user.max_hp !== undefined && user.max_hp > 0).slice(0, 20);

    // 排序
    validUsers = sortPlayers(validUsers);

    currentPlayers = validUsers;
    updateUI();
}

// 排序玩家
function sortPlayers(players) {
    switch (currentSortMode) {
        case 'hp':
            return players.sort((a, b) => {
                const hpPercentA = (a.hp / a.max_hp) * 100;
                const hpPercentB = (b.hp / b.max_hp) * 100;
                return hpPercentA - hpPercentB; // 血量低的在前
            });
        case 'name':
            return players.sort((a, b) => {
                const nameA = (a.name || `UID:${a.id}`).toLowerCase();
                const nameB = (b.name || `UID:${b.id}`).toLowerCase();
                return nameA.localeCompare(nameB);
            });
        case 'dps':
            return players.sort((a, b) => (b.total_dps || 0) - (a.total_dps || 0));
        case 'hps':
            return players.sort((a, b) => (b.total_hps || 0) - (a.total_hps || 0));
        default:
            return players;
    }
}

// 更新UI
function updateUI() {
    updatePlayerCount();
    renderPlayerCards();
}

// 更新玩家数量显示
function updatePlayerCount() {
    const playerCountElement = document.getElementById('playerCount');
    const count = currentPlayers.length;
    playerCountElement.textContent = `监控中: ${count}/20 名玩家`;
}

// 渲染玩家卡片
function renderPlayerCards() {
    const grid = document.getElementById('playerGrid');
    const noDataElement = grid.querySelector('.no-data');

    if (currentPlayers.length === 0) {
        // 隐藏所有卡片
        playerCards.forEach((card, index) => {
            setTimeout(() => {
                card.style.display = 'none';
            }, index * 20);
        });

        // 显示无数据提示
        if (noDataElement) {
            setTimeout(
                () => {
                    noDataElement.style.display = 'block';
                },
                playerCards.length * 20 + 100,
            );
        }
        return;
    }

    // 隐藏无数据提示
    if (noDataElement) {
        noDataElement.style.display = 'none';
    }

    // 更新现有卡片内容并显示
    currentPlayers.forEach((player, index) => {
        if (index < playerCards.length) {
            const card = playerCards[index];

            // 如果卡片当前隐藏，先显示再更新内容
            if (card.style.display === 'none') {
                card.style.display = 'flex';
                card.style.opacity = '0';
                card.style.transform = 'translateY(20px)';

                // 延迟显示动画
                setTimeout(() => {
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                }, index * 50);
            }

            updatePlayerCard(card, player, index);
        }
    });

    // 隐藏多余的卡片
    for (let i = currentPlayers.length; i < playerCards.length; i++) {
        const card = playerCards[i];
        if (card.style.display !== 'none') {
            card.style.opacity = '0';
            card.style.transform = 'translateY(-10px)';

            setTimeout(() => {
                card.style.display = 'none';
            }, 200);
        }
    }
}

// 预生成玩家卡片
function preGeneratePlayerCards() {
    const grid = document.getElementById('playerGrid');

    // 清空现有内容
    grid.innerHTML = '';
    playerCards = [];

    // 创建最大数量的卡片
    for (let i = 0; i < MAX_CARDS; i++) {
        const card = createEmptyPlayerCard(i);
        playerCards.push(card);
        grid.appendChild(card);
    }

    // 添加无数据提示元素
    const noDataElement = document.createElement('div');
    noDataElement.className = 'no-data';
    noDataElement.innerHTML = '<div>📭 暂无参战玩家数据</div>';
    noDataElement.style.display = 'block';
    grid.appendChild(noDataElement);
}

// 创建空的玩家卡片
function createEmptyPlayerCard(index) {
    const div = document.createElement('div');
    div.className = 'player-card';
    div.style.animationDelay = `${index * 0.05}s`;
    div.style.display = 'none';
    div.style.opacity = '0';
    div.style.transform = 'translateY(20px)';

    div.innerHTML = `
                    <div class="player-info">
                        <div class="player-basic">
                            <div class="player-name" title="">等待数据...</div>
                            <div class="player-profession">-</div>
                        </div>
                        <div class="player-stats">
                            <div class="stat-item" title="总DPS">
                                <span class="stat-icon">⚔️</span>
                                <span class="stat-value">0</span>
                            </div>
                            <div class="stat-item" title="总HPS">
                                <span class="stat-icon">🩹</span>
                                <span class="stat-value">0</span>
                            </div>
                            <div class="stat-item" title="总伤害">
                                <span class="stat-icon">💥</span>
                                <span class="stat-value">0</span>
                            </div>
                            <div class="stat-item" title="总治疗">
                                <span class="stat-icon">❤️</span>
                                <span class="stat-value">0</span>
                            </div>
                        </div>
                    </div>
                    <div class="hp-container">
                        <div class="hp-bar">
                            <div class="hp-fill" style="width: 0%"></div>
                        </div>
                        <div class="hp-text">
                            <span class="hp-current">0</span>
                            <span class="hp-percentage">0%</span>
                            <span class="hp-max">0</span>
                        </div>
                    </div>
                `;

    return div;
}

// 更新现有玩家卡片
function updatePlayerCard(cardElement, player, index) {
    const hp = player.hp || 0;
    const maxHp = player.max_hp || 1;
    const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));
    const name = player.name || `UID:${player.id}`;
    const profession = player.profession || '未知';

    // 获取职业信息
    const professionParts = profession.split('-');
    const mainProfession = professionParts[0];
    const subProfession = professionParts[1] || '';
    const professionInfo = professionMap[mainProfession] || { type: '未知', color: '#9E9E9E' };

    // 确定血量状态
    let hpClass = '';
    if (hpPercent <= 25) hpClass = 'hp-critical';
    else if (hpPercent <= 50) hpClass = 'hp-warning';
    else if (hpPercent >= 99) hpClass = 'hp-full';
    else hpClass = 'hp-healthy';

    // 更新卡片类名和样式
    cardElement.className = `player-card profession-${professionInfo.type} ${hpClass}`;
    cardElement.style.setProperty('--profession-color', professionInfo.color);

    // 更新卡片内容
    const playerNameEl = cardElement.querySelector('.player-name');
    const playerProfessionEl = cardElement.querySelector('.player-profession');
    const hpCurrentEl = cardElement.querySelector('.hp-current');
    const hpPercentageEl = cardElement.querySelector('.hp-percentage');
    const hpMaxEl = cardElement.querySelector('.hp-max');
    const hpFillEl = cardElement.querySelector('.hp-fill');
    const statValues = cardElement.querySelectorAll('.stat-value');

    playerNameEl.textContent = name;
    playerNameEl.title = name;

    playerProfessionEl.textContent = subProfession || professionInfo.short_name || '未知';
    playerProfessionEl.style.backgroundColor = professionInfo.color;

    hpCurrentEl.textContent = hp;
    hpPercentageEl.textContent = `${hpPercent.toFixed(0)}%`;
    hpMaxEl.textContent = maxHp;
    hpFillEl.style.width = `${hpPercent}%`;

    // 更新统计数据
    if (statValues.length >= 3) {
        statValues[0].textContent = formatNumber(player.total_dps || 0, 1);
        statValues[1].textContent = formatNumber(player.total_hps || 0, 1);
        statValues[2].textContent = formatNumber(player.total_damage?.total || 0);
        statValues[3].textContent = formatNumber(player.total_healing?.total || 0);
    }
}

// 格式化数字
function formatNumber(num, decimals = 0) {
    if (num === undefined || num === null) return '0';

    const number = parseFloat(num);
    if (isNaN(number)) return '0';

    if (number >= 1000000) {
        return (number / 1000000).toFixed(decimals) + 'M';
    } else if (number >= 1000) {
        return (number / 1000).toFixed(decimals) + 'K';
    } else {
        return number.toFixed(decimals);
    }
}

// 设置排序模式
function setSortMode(mode) {
    currentSortMode = mode;

    // 更新按钮状态
    document.querySelectorAll('.controls .btn').forEach((btn) => {
        btn.classList.remove('active');
    });
    const targetBtn = document.getElementById(`sort${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
    if (targetBtn) {
        targetBtn.classList.add('active');
    }

    // 重新排序和渲染
    if (currentPlayers.length > 0) {
        currentPlayers = sortPlayers(currentPlayers);
        renderPlayerCards();
    }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', () => {
    // 预生成玩家卡片
    preGeneratePlayerCards();

    // 初始化IPC通信
    initializeIPC();

    // 初始化窗口控制
    initializeWindowControls();

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        switch (e.key.toLowerCase()) {
            case '1':
                setSortMode('hp');
                break;
            case '2':
                setSortMode('name');
                break;
            case '3':
                setSortMode('dps');
                break;
            case '4':
                setSortMode('hps');
                break;
        }
    });
});