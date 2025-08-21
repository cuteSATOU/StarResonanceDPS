// 添加页面加载动画效果
document.addEventListener('DOMContentLoaded', function () {
    // 为页面添加加载完成的类
    document.body.classList.add('loaded');

    // 添加卡片的交错动画
    const cards = document.querySelectorAll('.card, .stats-card');
    cards.forEach((card, index) => {
        card.style.animationDelay = `${0.2 + index * 0.1}s`;
    });

    // 优化按钮点击反馈
    document.addEventListener('click', function (e) {
        if (e.target.classList.contains('btn') || e.target.closest('.btn')) {
            const btn = e.target.classList.contains('btn') ? e.target : e.target.closest('.btn');
            btn.style.transform = 'scale(0.95)';
            setTimeout(() => {
                btn.style.transform = '';
            }, 150);
        }
    });

    // 添加表格行的微妙动画
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                setTimeout(() => {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }, index * 50);
            }
        });
    }, { threshold: 0.1 });

    // 监听表格行
    const rows = document.querySelectorAll('tbody tr');
    rows.forEach(row => {
        row.style.opacity = '0';
        row.style.transform = 'translateY(20px)';
        row.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(row);
    });
});

let currentSortMode = 'uid'; // 默认按UID排序
let userNicknames = JSON.parse(localStorage.getItem('userNicknames') || '{}');
let visibleUsers = JSON.parse(localStorage.getItem('visibleUsers') || '{}');
let dpsHistory = {}; // 存储每个用户的DPS历史数据
let chart = null;
const HISTORY_DURATION_SECONDS = 60; // 历史记录时长（秒）
const HISTORY_FREQUENCY_PER_SECOND = 10; // 每秒记录次数
const MAX_HISTORY_LENGTH = HISTORY_DURATION_SECONDS * HISTORY_FREQUENCY_PER_SECOND; // 60秒 * 10次/秒
let chartDatasetMap = {}; // 缓存数据集索引，避免重建
let lastUpdateTime = 0;
let chartInitialized = false; // 标记图表是否已初始化
let userColorMap = {}; // 用户固定颜色映射
let isUpdatingFromLegend = false; // 防止图例事件和控制面板事件相互触发
let currentUserArray = []; // 缓存当前用户数组用于查找用户名

// y轴动态调整相关变量
const Y_AXIS_FLOOR_MIN = 10000;

// Electron IPC连接相关变量
let isElectronConnected = false;
let lastDataUpdate = Date.now();
let isCapturing = false;

// 暂停统计相关变量
let isPaused = false;

// 服务器状态提示相关变量
let serverStatusTimeout = null;

// 数据组显示控制相关变量
let currentDataGroup = 'damage';
let lastVisiableUserArray = [];

// 隐藏未参战角色相关变量
let hideInactiveUsers = false;



// 图表显示/隐藏控制相关变量
let isChartVisible = true;

// 从series数据中提取可见最大值
function getVisibleMaxFromSeries(seriesArray) {
    let m = 0;
    for (const series of seriesArray) {
        const arr = series.data || [];
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (typeof v === 'number') m = Math.max(m, v);
        }
    }
    return m;
}

// 将数值向上取整到好读的档位
function niceCeil(val) {
    if (val <= 0) return 1000;
    const exp = Math.pow(10, Math.floor(Math.log10(val)));
    const bases = [1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    for (const b of bases) {
        const candidate = b * exp;
        if (candidate >= val) return candidate;
    }
    return Math.ceil(val / exp) * exp;
}

// 复制用户数据
function copyUserData(userId) {
    const user = getUserFromArray(userId);
    if (!user) {
        console.error('未找到用户数据');
        return;
    }

    const hasValidName = user.name && user.name.trim() !== '';
    const nickname = userNicknames[userId] || (hasValidName ? user.name : '') || '';
    const copyText = `${nickname}#${userId} 伤害:${user.total_damage.total} 治疗:${user.total_healing.total} DPS:${user.total_dps.toFixed(2)} HPS:${user.total_hps.toFixed(2)}`;

    // 复制昵称到剪贴板
    navigator.clipboard
        .writeText(copyText)
        .then(() => {
            // 显示复制成功提示
            showCopySuccess();
        })
        .catch((err) => {
            console.error('复制失败:', err);
            // 降级方案：使用传统方法复制
            try {
                const textArea = document.createElement('textarea');
                textArea.value = copyText;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                showCopySuccess();
            } catch (e) {
                console.error('降级复制方案也失败:', e);
            }
        });
}

// 显示复制成功提示
function showCopySuccess() {
    // 创建临时提示元素
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 10px 20px;
        border-radius: 4px;
        z-index: 10000;
        font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        animation: slideIn 0.3s ease-out;
    `;
    toast.textContent = '✅ 已复制用户数据';
    document.body.appendChild(toast);

    // 3秒后移除提示
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 3000);
}

// 打开技能分析窗口
async function showSkillAnalysis(userId) {
    try {
        console.log('打开技能分析窗口, 用户ID:', userId);
        const result = await window.electronAPI.openSkillAnalysis(userId);
        if (result.code !== 0) {
            console.error('打开技能分析窗口失败:', result.msg);
            alert('打开技能分析窗口失败: ' + result.msg);
        }
    } catch (error) {
        console.error('打开技能分析窗口失败:', error);
        alert('打开技能分析窗口失败: ' + error.message);
    }
}





// 多用户性能优化配置
const CHART_CONFIG = {
    MAX_VISIBLE_USERS: 20, // 最多同时显示的用户数
    PERFORMANCE_MODE_THRESHOLD: 15, // 超过此数量启用性能模式
    UPDATE_INTERVAL_NORMAL: 33, // 正常模式更新间隔(30fps)
    UPDATE_INTERVAL_PERFORMANCE: 100, // 性能模式更新间隔(10fps)
    DATA_POINT_LIMIT: 300, // 性能模式下的数据点限制(30秒)
};

let performanceMode = false;
let userPriorityCache = {}; // 用户优先级缓存

// 优化的20色配色方案
const PALETTE_DARK_20 = [
    '#FF6B6B',
    '#4ECDC4',
    '#45B7D1',
    '#96CEB4',
    '#FFEAA7',
    '#DDA0DD',
    '#FF9F43',
    '#54A0FF',
    '#5F27CD',
    '#00D2D3',
    '#10AC84',
    '#EE5A24',
    '#0984E3',
    '#6C5CE7',
    '#FD79A8',
    '#FF7675',
    '#74B9FF',
    '#A29BFE',
    '#00B894',
    '#FDCB6E',
]; // 高饱和度版本，深色背景下区分度更高

const PALETTE_LIGHT_20 = [
    '#E74C3C',
    '#3498DB',
    '#2ECC71',
    '#F39C12',
    '#9B59B6',
    '#1ABC9C',
    '#E67E22',
    '#34495E',
    '#F1C40F',
    '#E91E63',
    '#8E44AD',
    '#16A085',
    '#27AE60',
    '#F39800',
    '#D35400',
    '#C0392B',
    '#2980B9',
    '#17A2B8',
    '#28A745',
    '#6F42C1',
]; // 强对比版本，浅色背景下清晰易辨

function pickPalette() {
    return document.body.classList.contains('dark-mode') ? PALETTE_DARK_20 : PALETTE_LIGHT_20;
}

// 为用户分配固定颜色
function getUserColor(userId) {
    const palette = pickPalette();
    const userIdStr = String(userId);

    if (!userColorMap[userIdStr]) {
        // 基于用户ID的哈希值分配颜色，确保同一个用户总是得到相同的颜色
        let hash = 0;
        for (let i = 0; i < userIdStr.length; i++) {
            hash = (hash << 5) - hash + userIdStr.charCodeAt(i);
            hash |= 0;
        }
        const idx = Math.abs(hash) % palette.length;
        userColorMap[userIdStr] = palette[idx];
    }
    return userColorMap[userIdStr];
}

// 抓包状态管理
function updateCaptureStatus(status, message, deviceName = '') {
    const statusElement = document.getElementById('captureStatus');
    const textElement = document.getElementById('captureStatusText');

    if (!statusElement || !textElement) return;

    // 更新状态样式
    statusElement.className = 'capture-status ' + status;

    // 更新显示文本
    let displayText = '';
    switch (status) {
        case 'connected':
            displayText = deviceName || message || '正在抓包';
            break;
        case 'disconnected':
            displayText = message || '未开始抓包';
            break;
        case 'reconnecting':
            displayText = message || '连接中...';
            break;
        default:
            displayText = message || '未开始抓包';
    }

    textElement.textContent = displayText;

    // 检查文本是否过长，如果过长则启用滚动
    setTimeout(() => {
        const containerWidth = statusElement.offsetWidth - 60; // 减去图标和内边距的宽度
        const textWidth = textElement.scrollWidth;

        if (textWidth > containerWidth) {
            // 计算需要滚动的距离
            const scrollDistance = textWidth - containerWidth + 20; // 额外20px边距
            textElement.style.setProperty('--scroll-distance', `-${scrollDistance}px`);
            textElement.classList.add('scrolling');
        } else {
            textElement.classList.remove('scrolling');
        }
    }, 100);
}

function hideServerStatus() {
    const statusElement = document.getElementById('serverStatus');
    if (statusElement) {
        statusElement.classList.remove('show');
    }
    if (serverStatusTimeout) {
        clearTimeout(serverStatusTimeout);
        serverStatusTimeout = null;
    }
}

// 用户优先级计算 - 基于DPS和活跃度
function calculateUserPriority(userId, userArray) {
    const user = userArray.find((u) => u.id.toString() === userId);
    if (!user) return 0;

    const dpsScore = user.realtime_dps_max || 0;
    const totalDamageScore = (user.total_damage?.total || 0) / 100000; // 归一化
    const activityScore = dpsHistory[userId] ? dpsHistory[userId].filter((p) => p.dps > 0).length : 0;

    // 手动设置昵称的用户优先级更高
    const nicknameBonus = userNicknames[userId] ? 1000 : 0;

    return dpsScore + totalDamageScore + activityScore + nicknameBonus;
}

// 获取优先显示的用户列表
function getTopPriorityUsers(userArray, maxCount) {
    const userIds = Object.keys(dpsHistory).filter(
        (userId) => visibleUsers[userId] !== false && dpsHistory[userId] && dpsHistory[userId].length > 0,
    );

    // 计算并缓存优先级
    userIds.forEach((userId) => {
        userPriorityCache[userId] = calculateUserPriority(userId, userArray);
    });

    // 按优先级排序并限制数量
    return userIds.sort((a, b) => userPriorityCache[b] - userPriorityCache[a]).slice(0, maxCount);
}

// Electron IPC初始化
function initElectronIPC() {
    try {
        updateCaptureStatus('reconnecting', '正在初始化应用...');

        // 监听主进程的数据更新
        window.electronAPI.onDataUpdate((data) => {
            lastDataUpdate = Date.now();
            // 暂停时不处理数据更新
            if (!isPaused) {
                processDataUpdate(data);
            }
        });

        // 监听主进程发送的菜单事件
        window.electronAPI.onShowDeviceSelection(() => {
            startCapture();
        });

        window.electronAPI.onClearAllData(() => {
            clearData();
        });

        window.electronAPI.onTogglePauseState(() => {
            togglePause();
        });

        // 监听设备列表数据
        window.electronAPI.onDeviceList((devices) => {
            loadDeviceList(devices);
        });

        // 监听血条窗口关闭事件
        window.electronAPI.onHpWindowClosed(() => {
            const hpButton = document.getElementById('hpMonitorBtn');
            if (hpButton) {
                const buttonText = hpButton.querySelector('span');
                if (buttonText) {
                    buttonText.textContent = '血条监控';
                }
            }
        });

        // 监听抓包开始成功事件
        window.electronAPI.onCaptureStarted((data) => {
            console.log('抓包开始成功:', data);
            updateCaptureStatus('connected', '正在抓包', data.deviceName || '抓包设备');
            
            // 恢复按钮状态
            const startBtn = document.getElementById('startCaptureButton');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<span class="btn-icon">⏹️</span>停止抓包';
                startBtn.onclick = () => stopCapture();
            }
        });

        // 监听抓包开始失败事件
        window.electronAPI.onCaptureFailed((error) => {
            console.error('抓包开始失败:', error);
            updateCaptureStatus('disconnected', error.message || '抓包启动失败');

            // 3秒后恢复到应用就绪状态
            setTimeout(() => {
                updateCaptureStatus('disconnected', '应用就绪');
            }, 3000);
        });

        // 监听抓包停止事件
        window.electronAPI.onCaptureStopped((data) => {
            console.log('抓包已停止:', data);
            updateCaptureStatus('disconnected', data.message || '抓包已停止');

            // 恢复按钮状态
            const startBtn = document.getElementById('startCaptureButton');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<span class="btn-icon">🎯</span>开始抓包';
                startBtn.onclick = () => startCapture();
            }

            // 2秒后恢复到应用就绪状态
            setTimeout(() => {
                updateCaptureStatus('disconnected', '应用就绪');
            }, 2000);
        });

        isElectronConnected = true;
        console.log('Electron IPC连接成功');
        updateCaptureStatus('disconnected', '应用就绪');
    } catch (error) {
        console.error('Electron IPC初始化失败:', error);
        updateCaptureStatus('disconnected', '初始化失败');
    }
}

// 加载设备列表
function loadDeviceList(devices) {
    const deviceSelect = document.getElementById('deviceSelect');
    if (!deviceSelect) return;
    
    // 保存自动检测选项
    const autoOption = deviceSelect.querySelector('option[value="auto"]');
    const autoOptionClone = autoOption ? autoOption.cloneNode(true) : null;
    
    // 清除所有选项
    deviceSelect.innerHTML = '';
    
    // 重新添加自动检测选项
    if (autoOptionClone) {
        deviceSelect.appendChild(autoOptionClone);
    }
    
    // 添加设备选项
    devices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = index.toString();
        option.textContent = `${index}. ${device.description || device.name || `设备${index}`}`;
        deviceSelect.appendChild(option);
    });
    
    console.log(`Loaded ${devices.length} network devices`);
}

// 开始抓包函数
async function startCapture() {
    try {
        // 获取用户选择的设备和日志级别
        const deviceValue = document.getElementById('deviceSelect').value;
        const logLevel = document.querySelector('input[name="logLevel"]:checked').value;
        
        console.log(`Starting capture with device: ${deviceValue}, log level: ${logLevel}`);
        
        // 更新状态为正在启动
        updateCaptureStatus('reconnecting', '正在启动抓包...');
        
        // 禁用开始按钮并显示加载状态
        const startBtn = document.getElementById('startCaptureButton');
        startBtn.disabled = true;
        startBtn.innerHTML = '<span class="btn-icon">⏳</span>启动中...';
        
        const result = await window.electronAPI.startCapture(deviceValue, logLevel);
        if (result.code === 0) {
            console.log('抓包启动成功:', result.msg);
            // 成功状态会通过事件监听器更新
        } else {
            console.error('启动抓包失败:', result.msg);
            updateCaptureStatus('disconnected', '启动失败');
            // 恢复按钮状态
            startBtn.disabled = false;
            startBtn.innerHTML = '<span class="btn-icon">🎯</span>开始抓包';
        }
    } catch (error) {
        console.error('启动抓包失败:', error);
        updateCaptureStatus('disconnected', '启动失败');
        // 恢复按钮状态
        const startBtn = document.getElementById('startCaptureButton');
        startBtn.disabled = false;
        startBtn.innerHTML = '<span class="btn-icon">🎯</span>开始抓包';
    }
}

// 停止抓包函数
async function stopCapture() {
    try {
        console.log('Stopping capture...');
        
        // 更新状态为正在停止
        updateCaptureStatus('reconnecting', '正在停止抓包...');
        
        // 禁用按钮并显示加载状态
        const startBtn = document.getElementById('startCaptureButton');
        startBtn.disabled = true;
        startBtn.innerHTML = '<span class="btn-icon">⏳</span>停止中...';
        
        const result = await window.electronAPI.stopCapture();
        if (result.code === 0) {
            console.log('抓包停止成功:', result.msg);
            // 成功状态会通过事件监听器更新
        } else {
            console.error('停止抓包失败:', result.msg);
            updateCaptureStatus('disconnected', '停止失败');
            // 恢复按钮状态
            startBtn.disabled = false;
            startBtn.innerHTML = '<span class="btn-icon">⏹️</span>停止抓包';
        }
    } catch (error) {
        console.error('停止抓包失败:', error);
        updateCaptureStatus('disconnected', '停止失败');
        // 恢复按钮状态
        const startBtn = document.getElementById('startCaptureButton');
        startBtn.disabled = false;
        startBtn.innerHTML = '<span class="btn-icon">⏹️</span>停止抓包';
    }
}

// 启动数据轮询
function startDataPolling() {
    // 每100ms轮询一次数据
    setInterval(() => {
        if (!isPaused && isElectronConnected) {
            fetchData();
        }
    }, 100);
}

// 获取用户数据的辅助函数
function getUserFromArray(userId) {
    return currentUserArray.find((user) => user.id.toString() === userId.toString());
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

    return (totalDamage === 0 && totalDps === 0 && totalHps === 0) ||
        (isNaN(critRate) && isNaN(luckyRate));
}

// 切换隐藏未参战角色功能
function toggleHideInactiveUsers() {
    hideInactiveUsers = !hideInactiveUsers;
    const btn = document.getElementById('hideInactiveBtn');
    if (hideInactiveUsers) {
        btn.classList.add('active');
        btn.innerHTML = '👀 显示全部';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '👀 隐藏未参战';
    }

    // 重新处理当前数据
    if (currentUserArray && currentUserArray.length > 0) {
        // 重新过滤并更新表格
        sortUserArray(currentUserArray);
        let visibleUserArray = currentUserArray.filter((user) => visibleUsers[user.id] !== false);

        // 如果启用了隐藏未参战角色，进一步过滤
        if (hideInactiveUsers) {
            visibleUserArray = visibleUserArray.filter((user) => !isUserInactive(user));
        }

        lastVisiableUserArray = visibleUserArray;
        updateTables(visibleUserArray);
    }
}

// 处理数据更新（WebSocket和API通用）
function processDataUpdate(data, updateHistory = true) {
    try {
        // 将数据转换为数组以便排序
        const userArray = Object.keys(data.user).map((id) => ({
            id: Number(id),
            ...data.user[id],
        }));

        // 缓存当前用户数组
        currentUserArray = userArray;

        // 更新DPS历史数据
        if (updateHistory) {
            updateDpsHistory(userArray);
        }

        // 更新用户控制列表
        updateUserControlsList(userArray);

        // 根据当前排序模式排序
        sortUserArray(userArray);

        // 过滤不可见的用户
        let visibleUserArray = userArray.filter((user) => visibleUsers[user.id] !== false);

        // 如果启用了隐藏未参战角色，进一步过滤
        if (hideInactiveUsers) {
            visibleUserArray = visibleUserArray.filter((user) => !isUserInactive(user));
        }

        lastVisiableUserArray = visibleUserArray;
        updateTables(visibleUserArray);

        // 检查是否需要启用性能模式
        const activeUserCount = Object.keys(dpsHistory).length;
        const shouldEnablePerformanceMode = activeUserCount > CHART_CONFIG.PERFORMANCE_MODE_THRESHOLD;

        if (shouldEnablePerformanceMode !== performanceMode) {
            performanceMode = shouldEnablePerformanceMode;
            console.log(`${performanceMode ? '启用' : '关闭'}性能模式 (用户数: ${activeUserCount})`);
        }

        // 更新图表
        if (updateHistory) {
            updateChart(userArray);
        }
    } catch (err) {
        console.error('处理数据更新失败：', err);
    }
}

// 生成表格行
function updateTables(visibleUserArray) {
    const damageTable = document.getElementById('damageTable').querySelector('tbody');
    //获取damageTable里的所有行
    let existingRows = damageTable.querySelectorAll('tr');
    if (existingRows.length > visibleUserArray.length) {
        // 移除多余的行
        for (let i = existingRows.length - 1; i >= visibleUserArray.length; i--) {
            damageTable.removeChild(existingRows[i]);
        }
    }
    if (existingRows.length < visibleUserArray.length) {
        // 添加新行
        for (let i = existingRows.length; i < visibleUserArray.length; i++) {
            const row = document.createElement('tr');
            damageTable.appendChild(row);
        }
    }
    existingRows = damageTable.querySelectorAll('tr');

    for (let i = 0; i < visibleUserArray.length; i++) {
        const user = visibleUserArray[i];
        const crit_rate = user.total_count.critical / user.total_count.total;
        const lucky_rate = user.total_count.lucky / user.total_count.total;

        const row = existingRows[i];

        const isSimpleMode = document.body.classList.contains('simple-mode');

        // 其他数据列
        const otherCells = [
            user.profession || '未知',
            Number(user.fightPoint).toLocaleString(),
            (user.hp ?? '未知').toLocaleString(),
            Number(user.taken_damage).toLocaleString(),
            `${(crit_rate * 100).toFixed(2)}%`,
            `${(lucky_rate * 100).toFixed(2)}%`,
        ];
        if (currentDataGroup === 'damage' || currentDataGroup === 'all') {
            otherCells.push(Number(user.total_damage.total).toLocaleString());
            if (!isSimpleMode) {
                otherCells.push(
                    Number(user.total_damage.critical).toLocaleString(),
                    Number(user.total_damage.lucky).toLocaleString(),
                    Number(user.total_damage.crit_lucky).toLocaleString(),
                );
            }
            otherCells.push(
                Number(user.realtime_dps).toLocaleString(),
                Number(user.realtime_dps_max).toLocaleString(),
                Number(user.total_dps.toFixed(2)).toLocaleString()
            );
        }
        if (currentDataGroup === 'healing' || currentDataGroup === 'all') {
            otherCells.push(Number(user.total_healing.total).toLocaleString());
            if (!isSimpleMode) {
                otherCells.push(
                    Number(user.total_healing.critical).toLocaleString(),
                    Number(user.total_healing.lucky).toLocaleString(),
                    Number(user.total_healing.crit_lucky).toLocaleString(),
                );
            }
            otherCells.push(
                Number(user.realtime_hps).toLocaleString(),
                Number(user.realtime_hps_max).toLocaleString(),
                Number(user.total_hps.toFixed(2)).toLocaleString()
            );
        }
        let existingCells = row.querySelectorAll('td');
        //所需展示的列数
        const requiredColumnCount = 3 + otherCells.length;
        if (existingCells.length > requiredColumnCount) {
            // 移除多余的单元格
            for (let j = existingCells.length - 1; j >= requiredColumnCount; j--) {
                row.removeChild(existingCells[j]);
            }
        }
        if (existingCells.length < requiredColumnCount) {
            // 添加新单元格
            for (let j = existingCells.length; j < requiredColumnCount; j++) {
                const cell = document.createElement('td');
                row.appendChild(cell);
            }
        }
        existingCells = row.querySelectorAll('td');
        // 更新单元格内容
        existingCells.forEach((cell, index) => {
            if (index < 2) return;
            if (otherCells[index - 2] !== undefined) {
                cell.textContent = otherCells[index - 2];
            }
        });

        // 角色ID列
        const uidCell = existingCells[0];
        uidCell.textContent = `${user.id}`;

        // 角色昵称列
        const nicknameCell = existingCells[1];
        // Check if user.name is a non-empty string
        const hasValidName = user.name && user.name.trim() !== '';
        const nickname = userNicknames[user.id] || (hasValidName ? user.name : '');

        nicknameCell.textContent = nickname;
        const operationCell = existingCells[existingCells.length - 1];
        if (operationCell.querySelector('.skill-btn')) {
            // 如果已经存在技能按钮，则只更新用户ID
            operationCell.querySelector('.skill-btn').setAttribute('data-user-id', user.id);
            operationCell.querySelector('.copy-btn').setAttribute('data-user-id', user.id);
        } else {
            operationCell.innerHTML = '';
            const operationDiv = document.createElement('div');
            operationDiv.className = 'operation-div';
            operationCell.appendChild(operationDiv);

            // 创建复制按钮
            const copyButton = document.createElement('button');
            copyButton.className = 'copy-btn';
            copyButton.innerHTML = '<i class="icon">📋</i> 复制数据';
            copyButton.setAttribute('data-user-id', user.id);
            operationDiv.appendChild(copyButton);

            // 创建技能按钮
            const skillButton = document.createElement('button');
            skillButton.className = 'skill-btn';
            skillButton.innerHTML = '<i class="icon">📊</i> 技能分析';
            skillButton.setAttribute('data-user-id', user.id);
            operationDiv.appendChild(skillButton);
        }
    }
    updateTableStickyHeader();
    // 应用列显示设置
    if (typeof applyColumnVisibility === 'function') {
        applyColumnVisibility();
    }
}

async function fetchData() {
    // 暂停时不获取数据
    if (isPaused) return;

    try {
        const data = await window.electronAPI.getData();
        if (data.code === 0) {
            processDataUpdate(data);

            // 检查抓包状态变化
            const wasCapturing = isCapturing;
            isCapturing = data.isCapturing;
            isPaused = data.isPaused;

            // 更新抓包状态显示
            if (isCapturing) {
                // 正在抓包：检查是否暂停统计
                const deviceInfo = data.deviceName || '正在抓包...';
                if (isPaused) {
                    updateCaptureStatus('reconnecting', '暂停抓包', deviceInfo);
                } else {
                    updateCaptureStatus('connected', '正在抓包', deviceInfo);
                }
            } else {
                // 没有抓包：根据之前状态判断显示什么
                if (wasCapturing) {
                    // 刚刚停止抓包
                    updateCaptureStatus('disconnected', '抓包已停止');
                } else {
                    // 一直没有抓包，检查当前状态是否为选择设备中
                    const statusElement = document.getElementById('captureStatus');
                    const textElement = document.getElementById('captureStatusText');

                    if (statusElement && textElement &&
                        (textElement.textContent.includes('选择') || textElement.textContent.includes('连接中'))) {
                        // 保持当前的选择/连接状态，不覆盖
                        return;
                    } else {
                        // 默认状态
                        updateCaptureStatus('disconnected', '未开始抓包');
                    }
                }
            }
        } else {
            throw new Error(data.msg || '获取数据失败');
        }
    } catch (err) {
        console.error('获取数据失败：', err);
        updateCaptureStatus('disconnected', '连接失败');
    }
}

function sortUserArray(userArray) {
    switch (currentSortMode) {
        case 'damage':
            userArray.sort((a, b) => b.total_damage.total - a.total_damage.total);
            break;
        case 'uid':
            userArray.sort((a, b) => a.id - b.id);
            break;
        case 'dps':
            userArray.sort((a, b) => b.total_dps - a.total_dps);
            break;
        case 'realtimeDpsMax':
            userArray.sort((a, b) => b.realtime_dps_max - a.realtime_dps_max);
            break;
        case 'takenDamage':
            userArray.sort((a, b) => b.taken_damage - a.taken_damage);
            break;
        case 'healing':
            userArray.sort((a, b) => b.total_healing.total - a.total_healing.total);
            break;
        case 'hps':
            userArray.sort((a, b) => b.total_hps - a.total_hps);
            break;
        case 'realtimeHpsMax':
            userArray.sort((a, b) => b.realtime_hps_max - a.realtime_hps_max);
            break;
        case 'fightPoint':
            userArray.sort((a, b) => b.fightPoint - a.fightPoint);
            break;
        case 'hp_min':
            userArray.sort((a, b) => a.hp - b.hp);
            break;
        default:
            userArray.sort((a, b) => a.id - b.id);
            break;
    }
}

function updateSortMode() {
    const select = document.getElementById('sortSelect');
    currentSortMode = select.value;
    localStorage.setItem('sortMode', currentSortMode);
    fetchData();
}

async function clearData() {
    const data = await window.electronAPI.clearData();

    // 清空历史数据和图表缓存
    dpsHistory = {};
    chartDatasetMap = {};
    userPriorityCache = {};
    userColorMap = {}; // 清空颜色映射
    currentUserArray = []; // 清空当前用户数组缓存
    lastUpdateTime = 0; // 重置图表更新时间
    performanceMode = false;

    // 清空ECharts图表 - 完全重新初始化
    if (chart) {
        // 销毁现有图表
        chart.dispose();
        chart = null;

        // 重置图表初始化状态
        chartInitialized = false;

        // 重新初始化空图表
        initChart();
    }

    // 清空控制面板中的用户控制项
    const userControlsList = document.getElementById('userControlsList');
    if (userControlsList) {
        userControlsList.innerHTML = '';
    }

    fetchData();
    // 清空表格显示
    const damageTable = document.getElementById('damageTable').querySelector('tbody');
    damageTable.innerHTML = '';

    // 即使在暂停状态下也要获取数据以显示清空后的结果
    // 临时保存暂停状态
    const wasPaused = isPaused;
    isPaused = false;

    // 获取并显示清空后的数据
    await fetchData();

    // 恢复暂停状态
    isPaused = wasPaused;
}

function toggleDarkMode() {
    const body = document.body;
    const isDarkMode = body.classList.contains('dark-mode');
    const button = event.target;

    if (isDarkMode) {
        body.classList.remove('dark-mode');
        button.textContent = '🌙 夜间模式';
        localStorage.setItem('darkMode', 'false');
    } else {
        body.classList.add('dark-mode');
        button.textContent = '☀️ 日间模式';
        localStorage.setItem('darkMode', 'true');
    }
}

function toggleSimpleMode() {
    const body = document.body;
    const isSimpleMode = body.classList.contains('simple-mode');
    const button = event.target;

    if (isSimpleMode) {
        body.classList.remove('simple-mode');
        button.textContent = '📋 简洁模式';
        localStorage.setItem('simpleMode', 'false');
    } else {
        body.classList.add('simple-mode');
        button.textContent = '📄 详细模式';
        localStorage.setItem('simpleMode', 'true');
    }

    // 切换模式后需要重新应用列显示设置
    if (typeof applyColumnVisibility === 'function') {
        applyColumnVisibility();
    }

    // 在暂停状态下，切换模式后需要重新渲染表格
    if (isPaused && lastVisiableUserArray.length > 0) {
        updateTables(lastVisiableUserArray);
    }
}

// 切换暂停/开始统计
async function togglePause() {
    isPaused = !isPaused;
    const button = document.getElementById('pauseButton');

    if (isPaused) {
        button.textContent = '▶️ 开始统计';
        console.log('统计已暂停');
    } else {
        button.textContent = '⏸️ 暂停统计';
        console.log('统计已开始');
    }

    // 保存暂停状态到本地存储
    localStorage.setItem('isPaused', isPaused.toString());

    // 立即更新抓包状态显示
    if (isCapturing) {
        try {
            const data = await window.electronAPI.getData();
            if (data.code === 0) {
                const deviceInfo = data.deviceName || '正在抓包...';
                if (isPaused) {
                    updateCaptureStatus('reconnecting', '暂停抓包', deviceInfo);
                } else {
                    updateCaptureStatus('connected', '正在抓包', deviceInfo);
                }
            }
        } catch (error) {
            console.error('更新抓包状态失败：', error);
        }
    }

    try {
        // 通知主进程暂停/开始状态
        const result = await window.electronAPI.togglePause(isPaused);
        if (result.code !== 0) {
            console.error('设置暂停状态失败：', result.msg);
        }
    } catch (err) {
        console.error('设置暂停状态失败：', err);
    }
}

// 切换图表显示/隐藏
function toggleChartVisibility() {
    isChartVisible = !isChartVisible;
    const chartContent = document.getElementById('dpsChartContent');
    const toggleBtn = document.getElementById('chartToggleBtn');

    if (isChartVisible) {
        // 展开动画
        chartContent.style.height = '350px';
        chartContent.style.opacity = '1';
        toggleBtn.classList.remove('collapsed');
        toggleBtn.title = '隐藏图表';

        // 重新初始化图表
        if (!chart) {
            // 等待动画完成后再初始化图表
            setTimeout(() => {
                initChart();
                setTimeout(() => {
                    if (chart) chart.resize();
                }, 350);
            }, 100);
        }
    } else {
        // 折叠动画
        chartContent.style.height = '0px';
        chartContent.style.opacity = '0';
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '显示图表';
    }

    localStorage.setItem('chartVisible', isChartVisible.toString());
}

// 页面加载时检查本地存储的主题偏好和排序偏好
function initTheme() {
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    const body = document.body;
    const button = document.querySelector('button[onclick="toggleDarkMode()"]');

    if (isDarkMode) {
        body.classList.add('dark-mode');
        button.textContent = '☀️ 日间模式';
    }
}

function initSimpleMode() {
    const isSimpleMode = localStorage.getItem('simpleMode') === 'true';
    const body = document.body;
    const button = document.querySelector('button[onclick="toggleSimpleMode()"]');

    if (isSimpleMode) {
        body.classList.add('simple-mode');
        button.textContent = '📄 详细模式';
    }
}

function initSortMode() {
    const savedSortMode = localStorage.getItem('sortMode');
    if (savedSortMode) {
        currentSortMode = savedSortMode;
        document.getElementById('sortSelect').value = savedSortMode;
    }
}

// 初始化数据组显示模式
function initDataGroup() {
    const savedDataGroup = localStorage.getItem('dataGroup') || 'damage';
    currentDataGroup = savedDataGroup;
    setDataGroup(savedDataGroup);
}

// 切换数据组显示
function toggleDataGroup(group) {
    currentDataGroup = group;
    setDataGroup(group);
    localStorage.setItem('dataGroup', group);
    if (isPaused) updateTables(lastVisiableUserArray);
}

// 设置数据组显示状态
function setDataGroup(group) {
    const body = document.body;
    const damageBtn = document.getElementById('damageGroupBtn');
    const healingBtn = document.getElementById('healingGroupBtn');
    const allBtn = document.getElementById('allGroupBtn');

    body.classList.remove('hide-damage', 'hide-healing');
    [damageBtn, healingBtn, allBtn].forEach((btn) => {
        if (btn) btn.classList.remove('active');
    });

    switch (group) {
        case 'damage':
            body.classList.add('hide-healing');
            if (damageBtn) damageBtn.classList.add('active');
            break;
        case 'healing':
            body.classList.add('hide-damage');
            if (healingBtn) healingBtn.classList.add('active');
            break;
        case 'all':
            if (allBtn) allBtn.classList.add('active');
            break;
        default:
            // 默认显示伤害&DPS
            body.classList.add('hide-healing');
            if (damageBtn) damageBtn.classList.add('active');
            break;
    }
}

// 初始化图表可见性状态
function initChartVisibility() {
    const savedChartVisible = localStorage.getItem('chartVisible');
    if (savedChartVisible !== null) {
        isChartVisible = savedChartVisible === 'true';
    }

    const chartContent = document.getElementById('dpsChartContent');
    const toggleBtn = document.getElementById('chartToggleBtn');

    if (!isChartVisible) {
        chartContent.style.height = '0px';
        chartContent.style.opacity = '0';
        toggleBtn.classList.add('collapsed');
        toggleBtn.title = '显示图表';
    } else {
        chartContent.style.height = '350px';
        chartContent.style.opacity = '1';
        toggleBtn.classList.remove('collapsed');
        toggleBtn.title = '隐藏图表';
    }
}

// 初始化暂停状态 - 优先从主进程获取状态
async function initPauseState() {
    try {
        // 从主进程获取当前状态
        const data = await window.electronAPI.getData();
        if (data.code === 0) {
            isPaused = data.isPaused;
            isCapturing = data.isCapturing;
        } else {
            // 如果获取失败，从本地存储获取
            const savedPauseState = localStorage.getItem('isPaused');
            isPaused = savedPauseState === 'true';
        }
    } catch (error) {
        // 如果获取失败，从本地存储获取
        console.warn('获取主进程状态失败，使用本地存储状态');
        const savedPauseState = localStorage.getItem('isPaused');
        isPaused = savedPauseState === 'true';
    }

    // 更新按钮状态
    const button = document.getElementById('pauseButton');
    if (isPaused) {
        button.textContent = '▶️ 开始统计';
    } else {
        button.textContent = '⏸️ 暂停统计';
    }
}

// DPS历史数据管理 - 保持数据真实性
function updateDpsHistory(userArray) {
    const currentTime = Date.now();

    for (const user of userArray) {
        if (!dpsHistory[user.id]) {
            dpsHistory[user.id] = [];
        }

        // 只记录真实的DPS数据，不进行人工平滑
        dpsHistory[user.id].push({
            time: currentTime,
            dps: user.realtime_dps,
            isActive: user.realtime_dps > 0, // 标记是否在活跃输出
        });

        // 保持最多60秒的数据
        const cutoffTime = currentTime - 60000; // 60秒前
        dpsHistory[user.id] = dpsHistory[user.id].filter((point) => point.time > cutoffTime);
    }
}

// 初始化ECharts图表
function initChart() {
    if (!isChartVisible) return;

    const chartDom = document.getElementById('dpsChart');
    chart = echarts.init(chartDom);

    const option = {
        backgroundColor: 'transparent',
        grid: {
            left: '3%',
            right: '4%',
            bottom: '8%',
            top: '15%',
            containLabel: true,
        },
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(50, 50, 50, 0.9)',
            borderColor: '#777',
            borderWidth: 1,
            textStyle: {
                color: '#fff',
                fontSize: 12,
            },
            axisPointer: {
                type: 'cross',
                crossStyle: {
                    color: '#999',
                },
            },
            formatter: function (params) {
                if (params.length === 0) return '';
                let result = `<div style="font-weight: bold; margin-bottom: 4px;">时间: ${params[0].name}</div>`;
                params.forEach((param) => {
                    if (param.value !== null && param.value !== undefined) {
                        result += `<div style="margin: 2px 0;">
                            <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 50%; margin-right: 6px;"></span>
                            ${param.seriesName}: <span style="font-weight: bold;">${param.value}</span>
                        </div>`;
                    }
                });
                return result;
            },
        },
        legend: {
            type: 'scroll',
            orient: 'horizontal',
            top: 10,
            textStyle: {
                fontSize: 12,
                color: '#666',
            },
            pageButtonItemGap: 10,
            pageButtonPosition: 'end',
            pageFormatter: '{current}/{total}',
            pageIconColor: '#666',
            pageIconInactiveColor: '#ccc',
            pageTextStyle: {
                color: '#666',
                fontSize: 12,
            },
        },
        xAxis: {
            type: 'category',
            data: [],
            axisLine: {
                lineStyle: {
                    color: '#ddd',
                },
            },
            axisTick: {
                lineStyle: {
                    color: '#ddd',
                },
            },
            axisLabel: {
                color: '#666',
                fontSize: 11,
                formatter: function (value, index) {
                    return index % 100 === 0 ? `${60 - Math.floor(index / 10)}s` : '';
                },
            },
            splitLine: {
                show: true,
                lineStyle: {
                    color: '#f0f0f0',
                    type: 'dashed',
                },
            },
        },
        yAxis: {
            type: 'value',
            name: 'DPS',
            nameTextStyle: {
                color: '#666',
                fontSize: 12,
            },
            axisLine: {
                lineStyle: {
                    color: '#ddd',
                },
            },
            axisTick: {
                lineStyle: {
                    color: '#ddd',
                },
            },
            axisLabel: {
                color: '#666',
                fontSize: 11,
                formatter: function (value) {
                    if (value >= 1000) {
                        return (value / 1000).toFixed(1) + 'K';
                    }
                    return value;
                },
            },
            splitLine: {
                lineStyle: {
                    color: '#f0f0f0',
                    type: 'dashed',
                },
            },
        },
        series: [],
    };

    chart.setOption(option);

    // 监听图例的选择变化事件，同步控制面板复选框状态
    chart.on('legendselectchanged', function (params) {
        // 防止从控制面板触发的事件再次处理
        if (isUpdatingFromLegend) return;

        const seriesName = params.name;
        const isSelected = params.selected[seriesName];

        // 查找对应的用户ID
        let userId = null;

        // 检查是否是UID格式的昵称
        const uidMatch = seriesName.match(/UID:(\d+)/);
        if (uidMatch) {
            userId = uidMatch[1];
        } else {
            // 查找自定义昵称对应的userId
            userId = Object.keys(userNicknames).find((id) => userNicknames[id] === seriesName);
        }

        if (userId) {
            const userIdStr = String(userId);

            // 同步visibleUsers状态
            if (isSelected) {
                delete visibleUsers[userIdStr];
            } else {
                visibleUsers[userIdStr] = false;
            }
            localStorage.setItem('visibleUsers', JSON.stringify(visibleUsers));

            // 同步控制面板复选框状态
            const controlElement = document.querySelector(`[data-user-id="${userIdStr}"]`);
            if (controlElement) {
                const checkbox = controlElement.querySelector('.visibility-checkbox');
                if (checkbox) {
                    checkbox.checked = isSelected;
                }
            }
        }
    });

    // 响应窗口大小变化
    window.addEventListener('resize', () => {
        chart.resize();
    });
}

// 更新图表 - 增量更新避免闪烁
function updateChart(userArray) {
    if (!isChartVisible) return updateChartStatus(0, Object.keys(dpsHistory).length);
    if (!chart) return;

    const currentTime = Date.now();

    // 动态更新频率控制
    const updateInterval = performanceMode ? CHART_CONFIG.UPDATE_INTERVAL_PERFORMANCE : CHART_CONFIG.UPDATE_INTERVAL_NORMAL;

    if (currentTime - lastUpdateTime < updateInterval) return;
    lastUpdateTime = currentTime;

    // 获取优先显示的用户
    const priorityUsers = getTopPriorityUsers(userArray, CHART_CONFIG.MAX_VISIBLE_USERS);
    const activeUserSet = new Set(priorityUsers);

    // 性能模式下的数据长度
    const dataLength = performanceMode ? CHART_CONFIG.DATA_POINT_LIMIT : MAX_HISTORY_LENGTH;

    // 获取当前图表配置
    const currentOption = chart.getOption();
    const currentSeries = currentOption.series || [];

    // 生成时间轴数据
    const xAxisChanged =
        !chartInitialized || !currentOption.xAxis || !currentOption.xAxis[0] || currentOption.xAxis[0].data.length !== dataLength;
    let xAxisData = [];
    if (xAxisChanged) {
        for (let i = 0; i < dataLength; i++) {
            xAxisData.push('');
        }
        chartInitialized = true;
    }

    // 更新series
    const updatedSeries = [];
    const existingSeriesMap = {};

    // 建立现有series映射
    currentSeries.forEach((series, index) => {
        existingSeriesMap[series.name] = { index, series };
    });

    // 处理每个优先用户
    priorityUsers.forEach((userId, index) => {
        const history = dpsHistory[userId];
        const user = getUserFromArray(userId);
        const hasValidName = user?.name && user.name.trim() !== '';
        const nickname = userNicknames[userId] || (hasValidName ? user.name : '') || `UID:${userId}`;
        const color = getUserColor(userId); // 使用固定颜色分配

        // 构建数据数组
        const data = new Array(dataLength).fill(null);

        // 填充真实数据点 - 稳定化时间映射
        const timeStep = performanceMode ? 200 : 100;

        // 使用固定时间基准，避免滚动时索引抖动
        const baseTime = Math.floor(currentTime / timeStep) * timeStep;

        history.forEach((point) => {
            const timeAgo = baseTime - point.time;
            const dataIndex = dataLength - 1 - Math.floor(timeAgo / timeStep);
            if (dataIndex >= 0 && dataIndex < dataLength) {
                // 如果该位置已有数据，取最大值避免覆盖峰值
                if (data[dataIndex] === null) {
                    data[dataIndex] = point.dps;
                } else {
                    data[dataIndex] = Math.max(data[dataIndex], point.dps);
                }
            }
        });

        // 数据稳定化处理 - 减少蠕动和跳跃
        if (!performanceMode) {
            // 1. 峰值保护：避免相邻点的峰值跳跃
            for (let i = 1; i < data.length - 1; i++) {
                if (data[i] !== null && data[i - 1] !== null && data[i + 1] !== null) {
                    // 如果当前点明显偏离趋势，平滑处理
                    const avg = (data[i - 1] + data[i + 1]) / 2;
                    if (Math.abs(data[i] - avg) > avg * 0.3 && data[i] < avg) {
                        data[i] = Math.max(data[i], avg * 0.8);
                    }
                }
            }

            // 2. 填充小间隔，保持连续性
            for (let i = 1; i < data.length; i++) {
                if (data[i] === null && data[i - 1] !== null) {
                    // 短间隔用渐变填充，避免突然断线
                    let nextIndex = -1;
                    for (let j = i + 1; j < Math.min(i + 3, data.length); j++) {
                        if (data[j] !== null) {
                            nextIndex = j;
                            break;
                        }
                    }
                    if (nextIndex !== -1 && nextIndex - i <= 2) {
                        // 线性插值填充
                        const step = (data[nextIndex] - data[i - 1]) / (nextIndex - i + 1);
                        data[i] = data[i - 1] + step;
                    } else {
                        // 保持前值
                        data[i] = data[i - 1];
                    }
                }
            }
        }

        // 重要程度分层样式（Top 5突出显示）
        const PRIMARY_COUNT = 5;
        const isPrimary = index < PRIMARY_COUNT;
        const lineWidth = isPrimary ? 3.0 : 1.2;
        const opacity = isPrimary ? 1.0 : 0.45;

        // 检查是否存在同名series
        if (existingSeriesMap[nickname]) {
            // 更新现有series数据 - 避免重建
            const existingSeries = existingSeriesMap[nickname].series;
            updatedSeries.push({
                ...existingSeries,
                data: data,
                lineStyle: {
                    ...existingSeries.lineStyle,
                    color: color,
                    width: lineWidth,
                    opacity: opacity,
                },
                itemStyle: {
                    color: color,
                    opacity: opacity,
                },
                z: isPrimary ? 3 : 1,
                zlevel: isPrimary ? 0 : -1,
            });
        } else {
            // 创建新series（分层显示）
            updatedSeries.push({
                name: nickname,
                type: 'line',
                data: data,
                symbol: 'none',
                smooth: false, // 完全关闭平滑避免形态抖动
                connectNulls: false,
                sampling: false, // 关闭采样避免峰值游移
                animation: false,
                silent: false,
                lineStyle: {
                    color: color,
                    width: lineWidth,
                    opacity: opacity,
                },
                itemStyle: {
                    color: color,
                    opacity: opacity,
                },
                emphasis: {
                    focus: 'series',
                    lineStyle: {
                        width: lineWidth + 0.7,
                        opacity: 1,
                    },
                    itemStyle: {
                        opacity: 1,
                    },
                },
                z: isPrimary ? 3 : 1,
                zlevel: isPrimary ? 0 : -1,
            });
        }
    });

    // 构建图例选中状态对象
    const legendSelected = {};
    updatedSeries.forEach((series) => {
        const seriesName = series.name;
        // 检查是否是UID格式的昵称
        const uidMatch = seriesName.match(/UID:(\d+)/);
        let userId = null;

        if (uidMatch) {
            userId = uidMatch[1];
        } else {
            // 查找自定义昵称对应的userId
            userId = Object.keys(userNicknames).find((id) => userNicknames[id] === seriesName);
        }

        // 确保userId是字符串类型进行比较
        const userIdStr = userId ? String(userId) : null;

        // 根据visibleUsers设置图例选中状态
        legendSelected[seriesName] = !(userIdStr && visibleUsers[userIdStr] === false);
    });

    // y轴调整算法
    const visibleMax = getVisibleMaxFromSeries(updatedSeries);

    // 让可见最大值占约75%图高，向上取整
    let proposedTop = visibleMax > 0 ? niceCeil(visibleMax / 0.75) : Y_AXIS_FLOOR_MIN;

    // 保底最小值
    proposedTop = Math.max(proposedTop, Y_AXIS_FLOOR_MIN);

    // 加3%顶部余量防压顶
    proposedTop = Math.max(proposedTop, visibleMax * 1.03);

    // 上快下慢 + 短暂滞后
    const DOWN_FRAC = 0.85;
    const DOWN_DWELL_MS = 1500;
    const nowTs = Date.now();
    window.__ymax_state = window.__ymax_state || { yMax: 10000, since: 0 };

    let { yMax: curTop, since } = window.__ymax_state;

    // 是否允许下调
    let canDown = false;
    if (visibleMax < curTop * DOWN_FRAC) {
        if (!since) since = nowTs;
        canDown = nowTs - since >= DOWN_DWELL_MS;
    } else {
        since = 0; // 只要又接近上沿，取消降轴计时
    }

    // 只允许在 canDown==true 时把目标设得比当前低
    if (!canDown && proposedTop < curTop) proposedTop = curTop;

    // 限制单帧最大降幅
    const MAX_DROP = 0.15;
    if (proposedTop < curTop * (1 - MAX_DROP)) {
        proposedTop = curTop * (1 - MAX_DROP);
    }

    // 平滑一步
    const alpha = proposedTop > curTop ? 0.35 : 0.18;
    curTop = curTop + alpha * (proposedTop - curTop);

    // 微抖收敛
    if (Math.abs(curTop - proposedTop) < 1) curTop = proposedTop;

    // 更新状态
    window.__ymax_state = { yMax: curTop, since };

    // 合并所有配置为一次setOption调用
    chart.setOption(
        {
            // 如果这次 x 轴长度改变，也一起带上
            ...(xAxisChanged
                ? {
                    xAxis: {
                        data: xAxisData,
                        axisLine: {
                            lineStyle: {
                                color: document.body.classList.contains('dark-mode')
                                    ? 'rgba(180,180,180,0.25)'
                                    : 'rgba(100,100,100,0.4)',
                            },
                        },
                        axisTick: {
                            lineStyle: {
                                color: document.body.classList.contains('dark-mode')
                                    ? 'rgba(180,180,180,0.25)'
                                    : 'rgba(100,100,100,0.4)',
                            },
                        },
                        axisLabel: {
                            color: document.body.classList.contains('dark-mode') ? 'rgba(220,220,220,0.65)' : 'rgba(60,60,60,0.8)',
                        },
                        splitLine: {
                            show: true,
                            lineStyle: {
                                color: document.body.classList.contains('dark-mode')
                                    ? 'rgba(200,200,200,0.12)'
                                    : 'rgba(150,150,150,0.3)',
                                type: 'dashed',
                            },
                        },
                    },
                }
                : {}),
            series: updatedSeries,
            legend: {
                data: updatedSeries.map((s) => s.name),
                selected: legendSelected,
                textStyle: {
                    color: document.body.classList.contains('dark-mode') ? '#E6E6E6' : '#444',
                },
            },
            yAxis: {
                type: 'value',
                name: 'DPS',
                nameTextStyle: {
                    color: document.body.classList.contains('dark-mode') ? 'rgba(220,220,220,0.8)' : '#333',
                    fontSize: 12,
                },
                min: 0,
                max: curTop,
                splitNumber: 6,
                animation: false,
                axisLine: {
                    lineStyle: {
                        color: document.body.classList.contains('dark-mode') ? 'rgba(180,180,180,0.25)' : 'rgba(100,100,100,0.4)',
                    },
                },
                axisTick: {
                    lineStyle: {
                        color: document.body.classList.contains('dark-mode') ? 'rgba(180,180,180,0.25)' : 'rgba(100,100,100,0.4)',
                    },
                },
                axisLabel: {
                    color: document.body.classList.contains('dark-mode') ? 'rgba(220,220,220,0.65)' : 'rgba(60,60,60,0.8)',
                    fontSize: 11,
                    formatter: function (value) {
                        if (value >= 1000) {
                            return (value / 1000).toFixed(1) + 'K';
                        }
                        return value;
                    },
                },
                splitLine: {
                    lineStyle: {
                        color: document.body.classList.contains('dark-mode') ? 'rgba(200,200,200,0.12)' : 'rgba(150,150,150,0.3)',
                        type: 'dashed',
                    },
                },
            },
            tooltip: {
                backgroundColor: document.body.classList.contains('dark-mode') ? 'rgba(32,32,40,0.92)' : 'rgba(255,255,255,0.95)',
                borderColor: document.body.classList.contains('dark-mode') ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.15)',
                textStyle: { color: document.body.classList.contains('dark-mode') ? '#EEE' : '#333' },
            },
            grid: { left: 56, right: '4%', bottom: '8%', top: '15%', containLabel: true },
        },
        false,
        true,
    );

    // 更新状态显示
    updateChartStatus(priorityUsers.length, Object.keys(dpsHistory).length);
}

// 更新图表状态显示
function updateChartStatus(visibleCount, totalCount) {
    const statusElement = document.getElementById('chartStatus');
    if (!statusElement) return;

    statusElement.textContent = `显示 ${visibleCount}/${totalCount} 用户`;
    statusElement.style.color = '#666';
}

// 更新用户控制列表
function updateUserControlsList(userArray) {
    const controlsList = document.getElementById('userControlsList');
    const existingControls = new Set(Array.from(controlsList.children).map((el) => el.dataset.userId));

    for (const user of userArray) {
        const userIdStr = String(user.id);

        if (existingControls.has(userIdStr)) {
            // 更新已存在控件的复选框状态
            const existingControl = controlsList.querySelector(`[data-user-id="${userIdStr}"]`);
            if (existingControl) {
                const checkbox = existingControl.querySelector('.visibility-checkbox');
                const isVisible = visibleUsers[userIdStr] !== false;
                checkbox.checked = isVisible;
            }
            continue;
        }

        const hasValidName = user.name && user.name.trim() !== '';
        const nickname = userNicknames[userIdStr] || (hasValidName ? user.name : '') || `UID:${user.id}`;
        const isVisible = visibleUsers[userIdStr] !== false;

        const controlDiv = document.createElement('div');
        controlDiv.className = 'user-controls';
        controlDiv.dataset.userId = userIdStr;
        const placeholderText = hasValidName ? user.name : '昵称';
        controlDiv.innerHTML = `
            <input type="checkbox" class="visibility-checkbox" ${isVisible ? 'checked' : ''} onchange="toggleUserVisibility(${user.id}, this.checked)">
            <input type="text" class="user-nickname-input" value="${userNicknames[userIdStr] || ''}" placeholder="${placeholderText}" onchange="updateNickname(${user.id}, this.value)" oninput="updateNickname(${user.id}, this.value)">
            <span class="user-uid">(UID:${user.id})</span>
        `;

        controlsList.appendChild(controlDiv);
    }
}

// 更新昵称
function updateNickname(userId, nickname) {
    if (nickname.trim()) {
        userNicknames[userId] = nickname.trim();
    } else {
        delete userNicknames[userId];
    }
    localStorage.setItem('userNicknames', JSON.stringify(userNicknames));
}

// 切换用户可见性
function toggleUserVisibility(userId, isVisible) {
    // 确保userId是字符串类型
    const userIdStr = String(userId);

    if (isVisible) {
        delete visibleUsers[userIdStr];
    } else {
        visibleUsers[userIdStr] = false;
    }
    localStorage.setItem('visibleUsers', JSON.stringify(visibleUsers));

    // 使用ECharts的dispatchAction来切换图例，这样与图例点击行为完全一致
    if (chart) {
        // 设置标志防止递归触发
        isUpdatingFromLegend = true;

        // 找到对应的series名称
        const user = getUserFromArray(userId);
        const hasValidName = user?.name && user.name.trim() !== '';
        const nickname = userNicknames[userIdStr] || (hasValidName ? user.name : '') || `UID:${userId}`;

        // 通过ECharts API切换图例选中状态
        chart.dispatchAction({
            type: 'legendToggleSelect',
            name: nickname,
        });

        // 重置标志
        setTimeout(() => {
            isUpdatingFromLegend = false;
        }, 100);
    }
}

// 全选/取消全选
function toggleAllUsers() {
    const checkboxes = document.querySelectorAll('.visibility-checkbox');
    const allChecked = Array.from(checkboxes).every((cb) => cb.checked);

    // 批量更新所有用户的可见性状态
    checkboxes.forEach((cb) => {
        cb.checked = !allChecked;
        const userId = cb.parentElement.dataset.userId;

        if (!allChecked) {
            // 全选：显示所有用户
            delete visibleUsers[userId];
        } else {
            // 取消全选：隐藏所有用户
            visibleUsers[userId] = false;
        }
    });

    localStorage.setItem('visibleUsers', JSON.stringify(visibleUsers));

    // 批量同步图例状态
    if (chart) {
        checkboxes.forEach((cb) => {
            const userId = cb.parentElement.dataset.userId;
            const user = getUserFromArray(userId);
            const hasValidName = user?.name && user.name.trim() !== '';
            const nickname = userNicknames[userId] || (hasValidName ? user.name : '') || `UID:${userId}`;

            // 设置标志防止递归触发
            isUpdatingFromLegend = true;

            // 通过ECharts API同步图例状态
            if (!allChecked) {
                // 全选：显示图例
                chart.dispatchAction({
                    type: 'legendSelect',
                    name: nickname,
                });
            } else {
                // 取消全选：隐藏图例
                chart.dispatchAction({
                    type: 'legendUnSelect',
                    name: nickname,
                });
            }
        });

        // 重置标志
        setTimeout(() => {
            isUpdatingFromLegend = false;
        }, 200);
    }

    // 触发数据更新，重新渲染表格
    fetchData();
}

// 清空所有昵称
function clearNicknames() {
    if (confirm('确定要清空所有自定义昵称吗？')) {
        userNicknames = {};
        localStorage.setItem('userNicknames', JSON.stringify(userNicknames));

        // 清空控制面板中的所有昵称输入框
        document.querySelectorAll('.user-nickname-input').forEach((input) => {
            input.value = '';
        });
    }
}

// 切换控制面板弹窗显示/隐藏
function toggleControlsModal() {
    const modal = document.getElementById('controlsModal');
    const isVisible = modal.classList.contains('show');

    if (isVisible) {
        modal.classList.remove('show');
        console.log('关闭用户设置弹窗');
    } else {
        modal.classList.add('show');
        console.log('打开用户设置弹窗');

        // 确保弹窗内容正确显示
        setTimeout(() => {
            const modalContent = modal.querySelector('.modal-content');
            if (modalContent) {
                console.log('弹窗内容尺寸:', modalContent.getBoundingClientRect());
            }
        }, 100);
    }
}

// 切换血条监控窗口
async function openHpWindow() {
    if (window.electronAPI && window.electronAPI.openHpWindow) {
        try {
            const result = await window.electronAPI.openHpWindow();
            if (result.code === 0) {
                // 更新按钮文本
                const button = document.querySelector('button[onclick="openHpWindow()"]');
                if (button) {
                    const buttonText = button.querySelector('span:not(.btn-icon)');
                    if (buttonText) {
                        buttonText.textContent = result.isOpen ? '关闭监控' : '血条监控';
                    }
                }
                console.log(result.msg);
            } else {
                console.error('Failed to toggle HP window:', result.msg);
            }
        } catch (error) {
            console.error('Error toggling HP window:', error);
        }
    } else {
        console.warn('Electron API not available');
    }
}

// 点击弹窗外部区域关闭弹窗
window.onclick = function (event) {
    const controlsModal = document.getElementById('controlsModal');
    const columnModal = document.getElementById('columnSettingsModal');
    if (event.target === controlsModal) {
        toggleControlsModal();
    } else if (event.target === columnModal) {
        closeColumnSettings();
    }
};

// 列显示设置相关功能
let columnVisibility = {
    uid: true,
    nickname: true,
    job: true,
    score: true,
    hp: true,
    takenDamage: true,
    critRate: true,
    luckyRate: true,
    totalDamage: true,
    pureCrit: true,
    pureLucky: true,
    critLucky: true,
    realtimeDps: true,
    realtimeDpsMax: true,
    dps: true,
    totalHealing: true,
    healingPureCrit: true,
    healingPureLucky: true,
    healingCritLucky: true,
    realtimeHps: true,
    realtimeHpsMax: true,
    hps: true,
    actions: true
};

// 从localStorage加载列显示设置
function loadColumnSettings() {
    const saved = localStorage.getItem('columnVisibility');
    if (saved) {
        columnVisibility = { ...columnVisibility, ...JSON.parse(saved) };
    }
    updateColumnCheckboxes();
    applyColumnVisibility();
}

// 保存列显示设置到localStorage
function saveColumnSettings() {
    localStorage.setItem('columnVisibility', JSON.stringify(columnVisibility));
}

// 更新复选框状态
function updateColumnCheckboxes() {
    Object.keys(columnVisibility).forEach(column => {
        const checkbox = document.querySelector(`#col-${column}`);
        if (checkbox) {
            checkbox.checked = columnVisibility[column];
        }
    });
}

// 打开列设置弹窗
function openColumnSettings() {
    generateColumnSettingsContent();
    document.getElementById('columnSettingsModal').style.display = 'flex';
}

// 关闭列设置弹窗
function closeColumnSettings() {
    document.getElementById('columnSettingsModal').style.display = 'none';
}

// 动态生成列设置内容
function generateColumnSettingsContent() {
    const modal = document.getElementById('columnSettingsModal');
    const content = modal.querySelector('.column-settings-content');

    // 清除现有内容（保留标题）
    const existingGroups = content.querySelectorAll('.column-group');
    existingGroups.forEach(group => group.remove());

    const isSimpleMode = document.body.classList.contains('simple-mode');

    // 基础信息组
    const baseGroup = createColumnGroup('🔰 基础信息', [
        { id: 'uid', label: '角色ID', column: 'uid' },
        { id: 'nickname', label: '角色昵称', column: 'nickname' },
        { id: 'job', label: '职业', column: 'job' },
        { id: 'score', label: '评分', column: 'score' },
        { id: 'hp', label: 'HP', column: 'hp' },
        { id: 'takenDamage', label: '承伤', column: 'takenDamage' },
        { id: 'critRate', label: '暴击率', column: 'critRate' },
        { id: 'luckyRate', label: '幸运率', column: 'luckyRate' }
    ]);
    content.appendChild(baseGroup);

    // 根据当前数据组显示相应的列设置
    if (currentDataGroup === 'damage' || currentDataGroup === 'all') {
        // 伤害数据组
        const damageOptions = [{ id: 'totalDamage', label: '总伤害', column: 'totalDamage' }];

        if (!isSimpleMode) {
            damageOptions.push(
                { id: 'pureCrit', label: '纯暴击', column: 'pureCrit' },
                { id: 'pureLucky', label: '纯幸运', column: 'pureLucky' },
                { id: 'critLucky', label: '暴击幸运', column: 'critLucky' }
            );
        }

        const damageGroup = createColumnGroup('⚔️ 伤害数据', damageOptions);
        content.appendChild(damageGroup);

        // DPS数据组
        const dpsGroup = createColumnGroup('⚡ DPS数据', [
            { id: 'realtimeDps', label: '瞬时DPS', column: 'realtimeDps' },
            { id: 'realtimeDpsMax', label: '最大瞬时', column: 'realtimeDpsMax' },
            { id: 'dps', label: '总DPS', column: 'dps' }
        ]);
        content.appendChild(dpsGroup);
    }

    if (currentDataGroup === 'healing' || currentDataGroup === 'all') {
        // 治疗数据组
        const healingOptions = [{ id: 'totalHealing', label: '总治疗', column: 'totalHealing' }];

        if (!isSimpleMode) {
            healingOptions.push(
                { id: 'healingPureCrit', label: '纯暴击', column: 'healingPureCrit' },
                { id: 'healingPureLucky', label: '纯幸运', column: 'healingPureLucky' },
                { id: 'healingCritLucky', label: '暴击幸运', column: 'healingCritLucky' }
            );
        }

        const healingGroup = createColumnGroup('❤️ 治疗数据', healingOptions);
        content.appendChild(healingGroup);

        // HPS数据组
        const hpsGroup = createColumnGroup('💚 HPS数据', [
            { id: 'realtimeHps', label: '瞬时HPS', column: 'realtimeHps' },
            { id: 'realtimeHpsMax', label: '最大瞬时', column: 'realtimeHpsMax' },
            { id: 'hps', label: '总HPS', column: 'hps' }
        ]);
        content.appendChild(hpsGroup);
    }

    // 其他组
    const otherGroup = createColumnGroup('🔧 其他', [
        { id: 'actions', label: '操作', column: 'actions' }
    ]);
    content.appendChild(otherGroup);

    // 重新绑定事件
    initColumnSettings();
}

// 创建列设置组
function createColumnGroup(title, options) {
    const group = document.createElement('div');
    group.className = 'column-group';

    const groupTitle = document.createElement('div');
    groupTitle.className = 'column-group-title';
    groupTitle.textContent = title;
    group.appendChild(groupTitle);

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'column-options';

    options.forEach(option => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'column-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `col-${option.id}`;
        checkbox.setAttribute('data-column', option.column);
        checkbox.checked = columnVisibility[option.column] || false;

        const label = document.createElement('label');
        label.setAttribute('for', `col-${option.id}`);
        label.textContent = option.label;

        optionDiv.appendChild(checkbox);
        optionDiv.appendChild(label);
        optionsContainer.appendChild(optionDiv);
    });

    group.appendChild(optionsContainer);
    return group;
}

// 应用列显示设置
function applyColumnVisibility() {
    const table = document.getElementById('damageTable');
    if (!table) return;

    // 基础信息列（rowspan=2）
    const baseColumns = [
        { column: 'uid', selector: 'th[title="角色唯一标识符"]' },
        { column: 'nickname', selector: 'th[title="角色昵称/自定义昵称"]' },
        { column: 'job', selector: 'th[title="角色职业"]' },
        { column: 'score', selector: 'th[title="角色评分"]' },
        { column: 'hp', selector: 'th[title="角色血量"]' },
        { column: 'takenDamage', selector: 'th[title="角色在战斗中受到的伤害"]' },
        { column: 'critRate', selector: 'th[title="角色在战斗中的暴击伤害次数占总伤害次数的比例"]' },
        { column: 'luckyRate', selector: 'th[title="角色在战斗中的幸运伤害次数占总伤害次数的比例"]' },
    ];

    // 应用基础列的显示/隐藏
    baseColumns.forEach(({ column, selector }) => {
        const isVisible = columnVisibility[column];
        const headerCell = table.querySelector(selector);
        if (headerCell) {
            if (isVisible) {
                headerCell.style.removeProperty('display');
            } else {
                headerCell.style.setProperty('display', 'none', 'important');
            }
        }
    });

    // 伤害相关列
    const damageColumns = [
        { column: 'totalDamage', selector: 'th[title="角色在战斗中造成的总伤害"]' },
        { column: 'pureCrit', selector: 'th[title="角色在战斗中造成的非幸运的暴击伤害"]' },
        { column: 'pureLucky', selector: 'th[title="角色在战斗中造成的非暴击的幸运伤害"]' },
        { column: 'critLucky', selector: 'th[title="角色在战斗中造成的暴击的幸运伤害"]' }
    ];

    damageColumns.forEach(({ column, selector }) => {
        const isVisible = columnVisibility[column];
        const headerCell = table.querySelector(selector);
        if (headerCell) {
            if (isVisible) {
                headerCell.style.removeProperty('display');
            } else {
                headerCell.style.setProperty('display', 'none', 'important');
            }
        }
    });

    // DPS相关列
    const dpsColumns = [
        { column: 'realtimeDps', selector: 'th[title="角色在战斗中的最近一秒造成的伤害"]' },
        { column: 'realtimeDpsMax', selector: 'th[title="角色在战斗中的最大瞬时DPS"]' },
        { column: 'dps', selector: 'th[title="角色在战斗中的总DPS（以第一次技能与最后一次技能之间的时间作为有效战斗时间计算）"]' }
    ];

    dpsColumns.forEach(({ column, selector }) => {
        const isVisible = columnVisibility[column];
        const headerCell = table.querySelector(selector);
        if (headerCell) {
            if (isVisible) {
                headerCell.style.removeProperty('display');
            } else {
                headerCell.style.setProperty('display', 'none', 'important');
            }
        }
    });

    // 治疗相关列
    const healingColumns = [
        { column: 'totalHealing', selector: 'th[title="角色在战斗中造成的总治疗量"]' },
        { column: 'healingPureCrit', selector: 'th[title="角色在战斗中造成的非幸运的暴击治疗量"]' },
        { column: 'healingPureLucky', selector: 'th[title="角色在战斗中造成的非暴击的幸运治疗量"]' },
        { column: 'healingCritLucky', selector: 'th[title="角色在战斗中造成的暴击的幸运治疗量"]' }
    ];

    healingColumns.forEach(({ column, selector }) => {
        const isVisible = columnVisibility[column];
        const headerCell = table.querySelector(selector);
        if (headerCell) {
            if (isVisible) {
                headerCell.style.removeProperty('display');
            } else {
                headerCell.style.setProperty('display', 'none', 'important');
            }
        }
    });

    // HPS相关列
    const hpsColumns = [
        { column: 'realtimeHps', selector: 'th[title="角色在战斗中的最近一秒造成的伤害和治疗量"]' },
        { column: 'realtimeHpsMax', selector: 'th[title="角色在战斗中的最大瞬时HPS"]' },
        { column: 'hps', selector: 'th[title="角色在战斗中的总HPS（以第一次技能与最后一次技能之间的时间作为有效战斗时间计算）"]' }
    ];

    hpsColumns.forEach(({ column, selector }) => {
        const isVisible = columnVisibility[column];
        const headerCell = table.querySelector(selector);
        if (headerCell) {
            if (isVisible) {
                headerCell.style.removeProperty('display');
            } else {
                headerCell.style.setProperty('display', 'none', 'important');
            }
        }
    });

    // 操作列
    const actionsHeader = table.querySelector('th:last-child');
    if (actionsHeader && actionsHeader.textContent.includes('操作')) {
        if (columnVisibility.actions) {
            actionsHeader.style.removeProperty('display');
        } else {
            actionsHeader.style.setProperty('display', 'none', 'important');
        }
    }

    // 应用表体单元格的显示/隐藏
    applyBodyColumnVisibility();

    // 更新colspan
    updateColspan();
}

// 应用表体单元格的显示/隐藏
function applyBodyColumnVisibility() {
    const table = document.getElementById('damageTable');
    if (!table) return;

    // 获取所有表体行
    const rows = table.querySelectorAll('tbody tr');

    rows.forEach(row => {
        const cells = row.querySelectorAll('td');

        // 基础信息列 (0-7)
        const baseCols = ['uid', 'nickname', 'job', 'score', 'hp', 'takenDamage', 'critRate', 'luckyRate'];
        baseCols.forEach((col, index) => {
            if (cells[index]) {
                if (columnVisibility[col]) {
                    cells[index].style.removeProperty('display');
                } else {
                    cells[index].style.setProperty('display', 'none', 'important');
                }
            }
        });

        // 动态列需要根据当前数据组和简洁模式来确定位置
        let cellIndex = 8; // 从第9列开始

        // 处理伤害相关列
        if (currentDataGroup === 'damage' || currentDataGroup === 'all') {
            // 总伤害列
            if (cells[cellIndex]) {
                if (columnVisibility.totalDamage) {
                    cells[cellIndex].style.removeProperty('display');
                } else {
                    cells[cellIndex].style.setProperty('display', 'none', 'important');
                }
            }
            cellIndex++;

            // 详细伤害列（非简洁模式）
            if (!document.body.classList.contains('simple-mode')) {
                const detailCols = ['pureCrit', 'pureLucky', 'critLucky'];
                detailCols.forEach(col => {
                    if (cells[cellIndex]) {
                        if (columnVisibility[col]) {
                            cells[cellIndex].style.removeProperty('display');
                        } else {
                            cells[cellIndex].style.setProperty('display', 'none', 'important');
                        }
                    }
                    cellIndex++;
                });
            }

            // DPS列
            const dpsCols = ['realtimeDps', 'realtimeDpsMax', 'dps'];
            dpsCols.forEach(col => {
                if (cells[cellIndex]) {
                    if (columnVisibility[col]) {
                        cells[cellIndex].style.removeProperty('display');
                    } else {
                        cells[cellIndex].style.setProperty('display', 'none', 'important');
                    }
                }
                cellIndex++;
            });
        }

        // 处理治疗相关列
        if (currentDataGroup === 'healing' || currentDataGroup === 'all') {
            // 总治疗列
            if (cells[cellIndex]) {
                if (columnVisibility.totalHealing) {
                    cells[cellIndex].style.removeProperty('display');
                } else {
                    cells[cellIndex].style.setProperty('display', 'none', 'important');
                }
            }
            cellIndex++;

            // 详细治疗列（非简洁模式）
            if (!document.body.classList.contains('simple-mode')) {
                const healingDetailCols = ['healingPureCrit', 'healingPureLucky', 'healingCritLucky'];
                healingDetailCols.forEach(col => {
                    if (cells[cellIndex]) {
                        if (columnVisibility[col]) {
                            cells[cellIndex].style.removeProperty('display');
                        } else {
                            cells[cellIndex].style.setProperty('display', 'none', 'important');
                        }
                    }
                    cellIndex++;
                });
            }

            // HPS列
            const hpsCols = ['realtimeHps', 'realtimeHpsMax', 'hps'];
            hpsCols.forEach(col => {
                if (cells[cellIndex]) {
                    if (columnVisibility[col]) {
                        cells[cellIndex].style.removeProperty('display');
                    } else {
                        cells[cellIndex].style.setProperty('display', 'none', 'important');
                    }
                }
                cellIndex++;
            });
        }

        // 操作列（最后一列）
        const lastCell = cells[cells.length - 1];
        if (lastCell) {
            if (columnVisibility.actions) {
                lastCell.style.removeProperty('display');
            } else {
                lastCell.style.setProperty('display', 'none', 'important');
            }
        }
    });
}

// 更新表头的colspan
function updateColspan() {
    const table = document.getElementById('damageTable');
    if (!table) return;

    // 计算各组可见列数
    const damageMainVisible = ['totalDamage', 'pureCrit', 'pureLucky', 'critLucky']
        .filter(col => columnVisibility[col]).length;
    const dpsVisible = ['realtimeDps', 'realtimeDpsMax', 'dps']
        .filter(col => columnVisibility[col]).length;
    const healingMainVisible = ['totalHealing', 'healingPureCrit', 'healingPureLucky', 'healingCritLucky']
        .filter(col => columnVisibility[col]).length;
    const hpsVisible = ['realtimeHps', 'realtimeHpsMax', 'hps']
        .filter(col => columnVisibility[col]).length;

    // 更新colspan
    const damageMainHeader = table.querySelector('.damage-main-col');
    const dpsHeader = table.querySelector('.dps-col');
    const healingMainHeader = table.querySelector('.healing-main-col');
    const hpsHeader = table.querySelector('.hps-col');

    if (damageMainHeader) {
        if (damageMainVisible > 0) {
            damageMainHeader.setAttribute('colspan', damageMainVisible);
            damageMainHeader.style.removeProperty('display');
        } else {
            damageMainHeader.style.setProperty('display', 'none', 'important');
        }
    }

    if (dpsHeader) {
        if (dpsVisible > 0) {
            dpsHeader.setAttribute('colspan', dpsVisible);
            dpsHeader.style.removeProperty('display');
        } else {
            dpsHeader.style.setProperty('display', 'none', 'important');
        }
    }

    if (healingMainHeader) {
        if (healingMainVisible > 0) {
            healingMainHeader.setAttribute('colspan', healingMainVisible);
            healingMainHeader.style.removeProperty('display');
        } else {
            healingMainHeader.style.setProperty('display', 'none', 'important');
        }
    }

    if (hpsHeader) {
        if (hpsVisible > 0) {
            hpsHeader.setAttribute('colspan', hpsVisible);
            hpsHeader.style.removeProperty('display');
        } else {
            hpsHeader.style.setProperty('display', 'none', 'important');
        }
    }
}

// 列设置复选框变化事件
function initColumnSettings() {
    document.querySelectorAll('#columnSettingsModal input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
            const column = this.getAttribute('data-column');
            columnVisibility[column] = this.checked;
            saveColumnSettings();
            applyColumnVisibility();
        });
    });
}

// 初始化列设置
document.addEventListener('DOMContentLoaded', function () {
    loadColumnSettings();
    initColumnSettings();
});

// 键盘ESC键关闭弹窗
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
        const modal = document.getElementById('controlsModal');
        if (modal.classList.contains('show')) {
            toggleControlsModal();
        }
    }
});

// 初始化
function initialize() {
    initTheme();
    initSimpleMode();
    initSortMode();
    initDataGroup();
    initChartVisibility();
    initPauseState();
    initChart();

    // 显示初始连接状态
    updateCaptureStatus('reconnecting', '正在初始化...');

    // 初始化Electron IPC连接
    initElectronIPC();

    // 启动数据轮询
    startDataPolling();

    // 初始化时获取一次数据
    fetchData();

    // 动态获取并设置版本号
    initAppVersion();

    // 应用启动时自动静默检查更新
    silentCheckForUpdates();

    // 添加事件委托处理技能按钮点击
    const damageTable = document.getElementById('damageTable');
    if (damageTable) {
        damageTable.addEventListener('click', function (event) {
            // 处理技能按钮点击
            if (event.target.classList.contains('skill-btn') || event.target.closest('.skill-btn')) {
                const button = event.target.classList.contains('skill-btn') ? event.target : event.target.closest('.skill-btn');
                const userId = button.getAttribute('data-user-id');
                if (userId) {
                    showSkillAnalysis(parseInt(userId));
                }
            }
            // 处理复制按钮点击
            else if (event.target.classList.contains('copy-btn') || event.target.closest('.copy-btn')) {
                const button = event.target.classList.contains('copy-btn') ? event.target : event.target.closest('.copy-btn');
                const userId = button.getAttribute('data-user-id');
                if (userId) {
                    copyUserData(parseInt(userId));
                }
            }
        });
    }

    // 添加窗口控制按钮事件监听
    initWindowControls();
}

// 窗口控制按钮功能
function initWindowControls() {
    console.log('初始化窗口控制按钮...');

    const minimizeBtn = document.getElementById('minimizeBtn');
    const maximizeBtn = document.getElementById('maximizeBtn');
    const closeBtn = document.getElementById('closeBtn');

    console.log('找到的按钮元素:', { minimizeBtn, maximizeBtn, closeBtn });

    // 最小化按钮
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', async (e) => {
            console.log('点击最小化按钮');
            e.preventDefault();
            e.stopPropagation();

            try {
                if (window.electronAPI && window.electronAPI.minimizeWindow) {
                    console.log('调用 electronAPI.minimizeWindow');
                    await window.electronAPI.minimizeWindow();
                } else {
                    console.warn('electronAPI.minimizeWindow 不可用');
                    alert('最小化功能需要在 Electron 环境中运行');
                }
            } catch (error) {
                console.error('最小化窗口失败:', error);
            }
        });
        console.log('最小化按钮事件监听器已添加');
    } else {
        console.error('未找到最小化按钮');
    }

    // 最大化按钮
    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', async (e) => {
            console.log('点击最大化/还原按钮');
            e.preventDefault();
            e.stopPropagation();

            try {
                if (window.electronAPI && window.electronAPI.toggleMaximizeWindow) {
                    console.log('调用 electronAPI.toggleMaximizeWindow');
                    const isMaximized = await window.electronAPI.toggleMaximizeWindow();
                    updateMaximizeButton(isMaximized);
                } else {
                    console.warn('electronAPI.toggleMaximizeWindow 不可用');
                    // Fallback: 手动切换按钮状态进行测试
                    const currentTitle = maximizeBtn.title;
                    const isCurrentlyMaximized = currentTitle === '还原';
                    updateMaximizeButton(!isCurrentlyMaximized);
                    alert(`${isCurrentlyMaximized ? '还原' : '最大化'}功能需要在 Electron 环境中运行`);
                }
            } catch (error) {
                console.error('最大化/还原窗口失败:', error);
            }
        });
        console.log('最大化按钮事件监听器已添加');
    } else {
        console.error('未找到最大化按钮');
    }

    // 关闭按钮
    if (closeBtn) {
        closeBtn.addEventListener('click', async (e) => {
            console.log('点击关闭按钮');
            e.preventDefault();
            e.stopPropagation();

            try {
                if (window.electronAPI && window.electronAPI.closeWindow) {
                    console.log('调用 electronAPI.closeWindow');
                    await window.electronAPI.closeWindow();
                } else {
                    console.warn('electronAPI.closeWindow 不可用，使用 window.close()');
                    window.close();
                }
            } catch (error) {
                console.error('关闭窗口失败:', error);
                // Fallback
                window.close();
            }
        });
        console.log('关闭按钮事件监听器已添加');
    } else {
        console.error('未找到关闭按钮');
    }

    // 添加双击标题栏最大化功能
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        navbar.addEventListener('dblclick', async (e) => {
            // 确保不是点击在按钮或其他交互元素上
            if (e.target.closest('.window-controls') || e.target.closest('.capture-status')) {
                return;
            }

            console.log('双击标题栏，切换最大化状态');
            try {
                if (window.electronAPI && window.electronAPI.toggleMaximizeWindow) {
                    const isMaximized = await window.electronAPI.toggleMaximizeWindow();
                    console.log('窗口最大化状态:', isMaximized);
                } else {
                    console.warn('electronAPI.toggleMaximizeWindow 不可用');
                }
            } catch (error) {
                console.error('切换最大化状态失败:', error);
            }
        });
        console.log('双击标题栏最大化功能已添加');
    }

    // 监听窗口状态变化
    if (window.electronAPI && window.electronAPI.onWindowStateChange) {
        window.electronAPI.onWindowStateChange((isMaximized) => {
            console.log('窗口状态变化:', isMaximized);
            updateMaximizeButton(isMaximized);
        });
        console.log('窗口状态变化监听器已添加');
    } else {
        console.warn('electronAPI.onWindowStateChange 不可用');
    }

    console.log('窗口控制按钮初始化完成');
}

// 更新最大化按钮图标
function updateMaximizeButton(isMaximized) {
    console.log('更新最大化按钮状态:', isMaximized);

    const maximizeBtn = document.getElementById('maximizeBtn');
    if (!maximizeBtn) {
        console.error('找不到最大化按钮元素');
        return;
    }

    const svg = maximizeBtn.querySelector('svg');
    if (!svg) {
        console.error('找不到最大化按钮中的 SVG 元素');
        return;
    }

    if (isMaximized) {
        // 还原图标（两个重叠的方框）
        svg.innerHTML = `
                <rect x="2" y="3" width="6" height="6" stroke="currentColor" stroke-width="1.2" fill="none" rx="0.5"/>
                <rect x="4" y="1" width="6" height="6" stroke="currentColor" stroke-width="1.2" fill="none" rx="0.5"/>
            `;
        maximizeBtn.title = '还原';
        console.log('设置为还原图标');
    } else {
        // 最大化图标（单个方框）
        svg.innerHTML = `
                <rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.5" fill="none" rx="1"/>
            `;
        maximizeBtn.title = '最大化';
        console.log('设置为最大化图标');
    }
}

// 等待DOM加载完成后初始化
// 检查更新功能
async function checkForUpdates() {
    try {
        // 显示更新弹窗并设置检查中状态
        showUpdateModal();
        setUpdateStatus('checking', '正在检查更新...', '🔄');
        
        const result = await window.electronAPI.checkForUpdates();
        
        if (result.code === 0) {
            if (result.hasUpdate) {
                // 有更新可用
                setUpdateStatus('available', `发现新版本 v${result.latestVersion}！`, '🎉');
                showUpdateInfo(result);
                showUpdateActions(result.releaseUrl);
            } else {
                // 已是最新版本
                setUpdateStatus('latest', `当前已是最新版本 v${result.currentVersion}`, '✅');
                showUpdateInfo(result);
            }
        } else {
            // 检查失败
            setUpdateStatus('error', result.msg || '检查更新失败', '❌');
        }
    } catch (error) {
        console.error('检查更新出错:', error);
        setUpdateStatus('error', '检查更新时发生错误', '❌');
    }
}

// 显示更新弹窗
function showUpdateModal() {
    const modal = document.getElementById('updateModal');
    modal.classList.add('show');
    modal.style.display = 'flex';
}

// 关闭更新弹窗
function closeUpdateModal() {
    const modal = document.getElementById('updateModal');
    modal.classList.remove('show');
    modal.style.display = 'none';
    
    // 清空内容
    document.getElementById('updateModalBody').innerHTML = '';
    document.getElementById('updateModalActions').style.display = 'none';
    document.getElementById('updateModalActions').innerHTML = '';
}

// 设置更新状态
function setUpdateStatus(type, message, icon) {
    const modalBody = document.getElementById('updateModalBody');
    
    const statusHtml = `
        <div class="update-status ${type}">
            <span class="update-status-icon">${icon}</span>
            <span>${message}</span>
        </div>
    `;
    
    modalBody.innerHTML = statusHtml;
}

// 显示更新信息
function showUpdateInfo(result) {
    const modalBody = document.getElementById('updateModalBody');
    
    let infoHtml = `
        <div class="update-info">
            <div class="update-info-row">
                <span class="update-info-label">当前版本</span>
                <span class="update-info-value">v${result.currentVersion}</span>
            </div>
            <div class="update-info-row">
                <span class="update-info-label">最新版本</span>
                <span class="update-info-value">v${result.latestVersion}</span>
            </div>
    `;
    
    if (result.publishedAt) {
        infoHtml += `
            <div class="update-info-row">
                <span class="update-info-label">发布时间</span>
                <span class="update-info-value">${new Date(result.publishedAt).toLocaleString()}</span>
            </div>
        `;
    }
    
    infoHtml += `</div>`;
    
    if (result.releaseNotes && result.releaseNotes.trim() !== '暂无更新说明') {
        infoHtml += `
            <div style="margin-top: var(--spacing-lg);">
                <h4 style="margin-bottom: var(--spacing-md); color: var(--text-secondary);">📝 更新说明</h4>
                <div class="update-notes">${formatReleaseNotes(result.releaseNotes)}</div>
            </div>
        `;
    }
    
    modalBody.innerHTML += infoHtml;
}

// 显示更新操作按钮
function showUpdateActions(releaseUrl) {
    const actionsDiv = document.getElementById('updateModalActions');
    
    actionsDiv.innerHTML = `
        <button class="btn btn-outline" onclick="closeUpdateModal()">
            <span class="btn-icon">❌</span>
            稍后更新
        </button>
        <button class="btn btn-primary" onclick="openDownloadPage('${releaseUrl}')">
            <span class="btn-icon">📥</span>
            立即下载
        </button>
    `;
    
    actionsDiv.style.display = 'flex';
}

// 打开下载页面
function openDownloadPage(url) {
    window.open(url, '_blank');
    closeUpdateModal();
}

// 格式化更新说明
function formatReleaseNotes(notes) {
    if (!notes || notes.trim() === '') {
        return '暂无更新说明';
    }
    
    // 简单的Markdown到HTML转换
    let formatted = notes
        // 转义HTML特殊字符
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // 处理标题
        .replace(/^### (.+)$/gm, '<h6>$1</h6>')
        .replace(/^## (.+)$/gm, '<h5>$1</h5>')
        .replace(/^# (.+)$/gm, '<h4>$1</h4>')
        // 处理粗体
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // 处理斜体
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // 处理代码
        .replace(/`(.+?)`/g, '<code>$1</code>')
        // 处理链接
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        // 处理无序列表
        .replace(/^[\s]*[-*+] (.+)$/gm, '<li>$1</li>')
        // 处理有序列表
        .replace(/^[\s]*\d+\. (.+)$/gm, '<li>$1</li>')
        // 处理换行
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    
    // 包装列表项
    formatted = formatted.replace(/(<li>.*?<\/li>)/gs, (match) => {
        return '<ul>' + match + '</ul>';
    });
    
    // 包装段落
    if (!formatted.includes('<h') && !formatted.includes('<ul>')) {
        formatted = '<p>' + formatted + '</p>';
    }
    
    return formatted;
}

// 动态获取并设置应用版本号
async function initAppVersion() {
    try {
        if (window.electronAPI && window.electronAPI.getAppVersion) {
            const result = await window.electronAPI.getAppVersion();
            if (result.code === 0) {
                const versionElement = document.getElementById('appVersion');
                if (versionElement) {
                    versionElement.textContent = `V${result.version}`;
                }
            }
        }
    } catch (error) {
        console.error('获取应用版本号失败:', error);
    }
}

// 静默检查更新（仅在有新版本时弹窗）
async function silentCheckForUpdates() {
    try {
        if (window.electronAPI && window.electronAPI.checkForUpdates) {
            const result = await window.electronAPI.checkForUpdates();
            if (result.code === 0 && result.hasUpdate) {
                // 只有在有新版本时才显示弹窗
                showUpdateModal();
                setUpdateStatus('available', '发现新版本！', '🎉');
                showUpdateInfo(result);
                showUpdateActions(result.releaseUrl);
            }
        }
    } catch (error) {
        console.error('静默检查更新失败:', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}