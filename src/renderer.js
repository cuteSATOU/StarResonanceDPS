const { ipcRenderer } = require('electron');
const echarts = require('echarts');

// DOM元素引用
let statusCard, statusIndicator, currentDevice, playerUid, noDataMessage, statsContainer;
let deviceSelect, refreshDeviceBtn, startCaptureBtn, stopCaptureBtn, clearStatsBtn, showLogBtn, toggleOverlayBtn, toggleRankingOverlayBtn, toggleSelfOnlyBtn;
let totalRealtimeDps, totalMaxDps, totalAvgDps, totalDamage, statsTable;
let totalRealtimeHps, totalMaxHps, totalAvgHps, totalHealing;
let minimizeBtn, maximizeBtn, closeBtn;

// 全局状态
let isCapturing = false;
let statsData = {};
let overlayEnabled = false;
let rankingOverlayEnabled = false;
let selfOnlyMode = false;
let currentPlayerUid = null;

// 初始化函数
function initializeElements() {
    // 状态相关元素
    statusCard = document.getElementById('statusCard');
    statusIndicator = document.getElementById('statusIndicator');
    currentDevice = document.getElementById('currentDevice');
    playerUid = document.getElementById('playerUid');
    
    // 主要区域
    noDataMessage = document.getElementById('noDataMessage');
    statsContainer = document.getElementById('statsContainer');
    
    // 控件
    deviceSelect = document.getElementById('deviceSelect');
    refreshDeviceBtn = document.getElementById('refreshDeviceBtn');
    startCaptureBtn = document.getElementById('startCaptureBtn');
    stopCaptureBtn = document.getElementById('stopCaptureBtn');
    clearStatsBtn = document.getElementById('clearStatsBtn');
    showLogBtn = document.getElementById('showLogBtn');
    toggleOverlayBtn = document.getElementById('toggleOverlayBtn');
    toggleRankingOverlayBtn = document.getElementById('toggleRankingOverlayBtn');
    toggleSelfOnlyBtn = document.getElementById('toggleSelfOnlyBtn');
    
    // 窗口控制按钮
    minimizeBtn = document.getElementById('minimizeBtn');
    maximizeBtn = document.getElementById('maximizeBtn');
    closeBtn = document.getElementById('closeBtn');
    
    // 数据展示元素
    totalRealtimeDps = document.getElementById('totalRealtimeDps');
    totalMaxDps = document.getElementById('totalMaxDps');
    totalAvgDps = document.getElementById('totalAvgDps');
    totalDamage = document.getElementById('totalDamage');
    totalRealtimeHps = document.getElementById('totalRealtimeHps');
    totalMaxHps = document.getElementById('totalMaxHps');
    totalAvgHps = document.getElementById('totalAvgHps');
    totalHealing = document.getElementById('totalHealing');
    statsTable = document.getElementById('statsTable');
}

// 绑定事件监听器
function bindEventListeners() {
    // 设备选择下拉框事件
    deviceSelect.addEventListener('change', () => {
        const selectedIndex = deviceSelect.value;
        if (selectedIndex !== '') {
            startCaptureBtn.disabled = false;
        } else {
            startCaptureBtn.disabled = true;
        }
    });

    // 刷新设备按钮
    refreshDeviceBtn.addEventListener('click', async () => {
        await loadDeviceList();
    });

    // 开始抓包按钮
    startCaptureBtn.addEventListener('click', async () => {
        const selectedIndex = parseInt(deviceSelect.value);
        if (selectedIndex >= 0) {
            try {
                const success = await ipcRenderer.invoke('start-capture', selectedIndex);
                if (!success) {
                    console.error('启动抓包失败，请检查设备和权限');
                }
            } catch (error) {
                console.error('启动抓包失败:', error);
            }
        }
    });

    stopCaptureBtn.addEventListener('click', async () => {
        try {
            await ipcRenderer.invoke('stop-capture');
            // 状态更新会通过IPC事件自动处理
        } catch (error) {
            console.error('停止抓包失败:', error);
        }
    });

    clearStatsBtn.addEventListener('click', async () => {
        if (confirm('确定要清除所有统计数据吗？')) {
            try {
                await ipcRenderer.invoke('clear-stats');
                statsData = {};
                updateStatsDisplay();
            } catch (error) {
                console.error('清除统计失败:', error);
            }
        }
    });

    // 显示日志窗口
    showLogBtn.addEventListener('click', async () => {
        try {
            await ipcRenderer.invoke('show-log-window');
        } catch (error) {
            console.error('打开日志窗口失败:', error);
        }
    });

    // 切换悬浮窗
    toggleOverlayBtn.addEventListener('click', async () => {
        try {
            const enabled = await ipcRenderer.invoke('toggle-overlay');
            updateOverlayButton(enabled);
        } catch (error) {
            console.error('切换悬浮窗失败:', error);
        }
    });

    // 切换DPS排行榜悬浮窗
    toggleRankingOverlayBtn.addEventListener('click', async () => {
        try {
            const enabled = await ipcRenderer.invoke('toggle-ranking-overlay');
            updateRankingOverlayButton(enabled);
        } catch (error) {
            console.error('切换DPS排行榜悬浮窗失败:', error);
        }
    });

    // 切换"仅自己"模式
    toggleSelfOnlyBtn.addEventListener('click', async () => {
        try {
            selfOnlyMode = !selfOnlyMode;
            updateSelfOnlyButton(selfOnlyMode);
            // 通知主进程和悬浮窗切换模式
            await ipcRenderer.invoke('toggle-self-only-mode', selfOnlyMode);
            // 立即更新显示
            updateStatsDisplay();
        } catch (error) {
            console.error('切换仅自己模式失败:', error);
        }
    });

    // 窗口控制按钮事件
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', async () => {
            await ipcRenderer.invoke('window-minimize');
        });
    }

    if (maximizeBtn) {
        maximizeBtn.addEventListener('click', async () => {
            await ipcRenderer.invoke('window-maximize');
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', async () => {
            if (isCapturing && !confirm('正在进行数据包捕获，确定要关闭吗？')) {
                return;
            }
            await ipcRenderer.invoke('window-close');
        });
    }

    // 查看详细信息按钮
    const showDetailBtn = document.getElementById('showDetailBtn');
    if (showDetailBtn) {
        showDetailBtn.addEventListener('click', () => {
            // 获取当前用户UID（如果有的话）
            const currentUserUid = getCurrentUserUid();
            if (currentUserUid && statsData[currentUserUid]) {
                openUserDetailModal(currentUserUid);
            } else {
                // 如果没有当前用户，打开第一个用户的详细信息
                const firstUid = Object.keys(statsData)[0];
                if (firstUid) {
                    openUserDetailModal(firstUid);
                }
            }
        });
    }
}

// IPC事件监听
function bindIpcListeners() {
    // 接收统计数据更新
    ipcRenderer.on('stats-updated', (event, data) => {
        statsData = data;
        // 使用防抖来减少频繁更新
        clearTimeout(window.updateStatsTimeout);
        window.updateStatsTimeout = setTimeout(() => {
            updateStatsDisplay();
        }, 100);
    });

    // 接收玩家UID更新
    ipcRenderer.on('player-uid-updated', (event, uid) => {
        currentPlayerUid = uid;
        playerUid.textContent = uid || '未获取';
        // 如果是仅自己模式，立即更新显示
        if (selfOnlyMode) {
            updateStatsDisplay();
        }
    });

    // 接收抓包状态变化
    ipcRenderer.on('capture-status-changed', (event, status) => {
        updateCaptureStatus(status.isCapturing, status.selectedDevice);
    });

    // 接收悬浮窗状态变化
    ipcRenderer.on('overlay-status-changed', (event, enabled) => {
        overlayEnabled = enabled;
        updateOverlayButton(enabled);
    });
    
    // 接收DPS排行榜悬浮窗状态变化
    ipcRenderer.on('ranking-overlay-status-changed', (event, enabled) => {
        rankingOverlayEnabled = enabled;
        updateRankingOverlayButton(enabled);
    });
    
    // 接收数据清空事件（F10快捷键触发）
    ipcRenderer.on('stats-cleared', (event) => {
        console.log('收到数据清空事件');
        statsData = {};
        updateStatsDisplay();
    });
    
    // 接收模式切换事件（F11快捷键触发）
    ipcRenderer.on('self-only-mode-changed', (event, enabled) => {
        console.log('收到模式切换事件:', enabled);
        selfOnlyMode = enabled;
        updateSelfOnlyButton(enabled);
        updateStatsDisplay();
    });
}

// 更新抓包状态
function updateCaptureStatus(capturing, deviceName = null) {
    isCapturing = capturing;
    
    if (capturing) {
        statusCard.className = 'status-card capturing';
        statusIndicator.querySelector('.status-text').textContent = '正在抓包';
        startCaptureBtn.disabled = true;
        stopCaptureBtn.disabled = false;
        if (deviceSelect) deviceSelect.disabled = true;
        if (refreshDeviceBtn) refreshDeviceBtn.disabled = true;
        
        if (deviceName) {
            currentDevice.textContent = deviceName;
        }
    } else {
        statusCard.className = 'status-card';
        statusIndicator.querySelector('.status-text').textContent = '待连接';
        startCaptureBtn.disabled = !deviceSelect || deviceSelect.value === '';
        stopCaptureBtn.disabled = true;
        if (deviceSelect) deviceSelect.disabled = false;
        if (refreshDeviceBtn) refreshDeviceBtn.disabled = false;
        
        // 如果停止抓包，重置设备显示
        if (deviceName === null) {
            currentDevice.textContent = '未选择';
        }
    }
}

// 格式化数字显示
function formatNumber(num, decimals = 0) {
    if (typeof num !== 'number' || isNaN(num)) return '0';
    
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    } else {
        return num.toFixed(decimals);
    }
}

// 格式化百分比
function formatPercentage(num) {
    if (typeof num !== 'number' || isNaN(num)) return '0%';
    return (num * 100).toFixed(1) + '%';
}

// 根据skill id识别职业
function getRoleNameBySkills(skills) {
    if (!skills || !Array.isArray(skills) || skills.length === 0) {
        return '未知';
    }
    
    // 遍历技能列表，找到匹配的职业
    for (const skill of skills) {
        switch (skill) {
            case 1241:
                return '射线';
            case 55302:
                return '协奏';
            case 20301:
                return '愈合';
            case 1518:
                return '惩戒';
            case 2306:
                return '狂音';
            case 120902:
                return '冰矛';
            case 1714:
                return '居合';
            case 44701:
                return '月刃';
            case 220112:
            case 2203622:
                return '鹰弓';
            case 1700827:
                return '狼弓';
            case 1419:
                return '空枪';
            case 1418:
                return '重装';
            case 2405:
                return '防盾';
            case 2406:
                return '光盾';
            case 199902:
                return '岩盾';
            default:
                continue;
        }
    }
    
    return '未知';
}

// 更新统计数据显示
function updateStatsDisplay() {
    let userIds = Object.keys(statsData);
    
    // 如果是"仅自己"模式，只显示当前玩家的数据
    if (selfOnlyMode && currentPlayerUid) {
        userIds = userIds.filter(uid => uid === currentPlayerUid);
    }
    
    if (userIds.length === 0) {
        noDataMessage.style.display = 'block';
        statsContainer.style.display = 'none';
        return;
    }
    
    noDataMessage.style.display = 'none';
    statsContainer.style.display = 'block';
    
    // 计算总体统计
    let totalRealtimeDpsValue = 0;
    let totalMaxDpsValue = 0;
    let totalAvgDpsValue = 0;
    let totalDamageValue = 0;
    let totalRealtimeHpsValue = 0;
    let totalMaxHpsValue = 0;
    let totalAvgHpsValue = 0;
    let totalHealingValue = 0;
    let playerCount = 0;
    
    for (const uid of userIds) {
        const userData = statsData[uid];
        totalRealtimeDpsValue += userData.realtime_dps || 0;
        totalMaxDpsValue = Math.max(totalMaxDpsValue, userData.realtime_dps_max || 0);
        totalAvgDpsValue += userData.total_dps || 0;
        totalDamageValue += userData.total_damage.total || 0;
        totalRealtimeHpsValue += userData.realtime_hps || 0;
        totalMaxHpsValue = Math.max(totalMaxHpsValue, userData.realtime_hps_max || 0);
        totalAvgHpsValue += userData.total_hps || 0;
        totalHealingValue += userData.total_healing ? userData.total_healing.total || 0 : 0;
        playerCount++;
    }
    
    if (playerCount > 0) {
        totalAvgDpsValue = totalAvgDpsValue / playerCount;
        totalAvgHpsValue = totalAvgHpsValue / playerCount;
    }
    
    // 更新概览卡片
    totalRealtimeDps.textContent = formatNumber(totalRealtimeDpsValue);
    totalMaxDps.textContent = formatNumber(totalMaxDpsValue);
    totalAvgDps.textContent = formatNumber(totalAvgDpsValue);
    totalDamage.textContent = formatNumber(totalDamageValue);
    totalRealtimeHps.textContent = formatNumber(totalRealtimeHpsValue);
    totalMaxHps.textContent = formatNumber(totalMaxHpsValue);
    totalAvgHps.textContent = formatNumber(totalAvgHpsValue);
    totalHealing.textContent = formatNumber(totalHealingValue);
    
    // 更新表格
    updateStatsTable();
    
    // 更新图表
    updateMetricCharts();
    
    // 更新查看详细信息按钮状态
    const showDetailBtn = document.getElementById('showDetailBtn');
    if (showDetailBtn) {
        const hasData = Object.keys(statsData).length > 0;
        showDetailBtn.disabled = !hasData;
    }
}

// 更新统计表格
function updateStatsTable() {
    const tbody = statsTable.querySelector('tbody');
    
    let userIds = Object.keys(statsData).sort();
    
    // 如果是"仅自己"模式，只显示当前玩家的数据
    if (selfOnlyMode && currentPlayerUid) {
        userIds = userIds.filter(uid => uid === currentPlayerUid);
    }
    
    // 获取现有的行，避免完全重新渲染
    const existingRows = Array.from(tbody.querySelectorAll('tr'));
    const existingUids = existingRows.map(row => row.cells[0].textContent);
    
    // 移除不再存在的用户行
    existingRows.forEach(row => {
        const uid = row.cells[0].textContent;
        if (!userIds.includes(uid)) {
            row.remove();
        }
    });
    
    for (const uid of userIds) {
        const userData = statsData[uid];
        const damage = userData.total_damage;
        const count = userData.total_count;
        
        // 计算暴击率
        const critRate = count.total > 0 ? count.critical / count.total : 0;
        
        // 获取治疗数据
        const healing = userData.total_healing || { total: 0, normal: 0, critical: 0, lucky: 0, crit_lucky: 0 };
        const healingCount = userData.healing_count || { total: 0, normal: 0, critical: 0, lucky: 0, crit_lucky: 0 };
        
        // 获取职业名称
        const roleName = getRoleNameBySkills(userData.skills);
        
        // 查找现有行或创建新行
        let row = existingRows.find(r => r.cells[0].textContent === uid);
        let isNewRow = false;
        
        if (!row) {
            row = document.createElement('tr');
            isNewRow = true;
        }
        
        // 获取显示名称和战力
        const displayName = userData.displayName || uid;
        const fightPoint = userData.playerFightPoint ? formatNumber(userData.playerFightPoint) : '-';
        
        row.innerHTML = `
            <td title="UID: ${uid}">${displayName}</td>
            <td>${roleName}</td>
            <td class="number">${fightPoint}</td>
            <td class="number">${formatNumber(userData.realtime_dps)}</td>
            <td class="number">${formatNumber(userData.realtime_dps_max)}</td>
            <td class="number">${formatNumber(userData.total_dps)}</td>
            <td class="number">${formatNumber(damage.total)}</td>
            <td class="number">${formatNumber(damage.normal)}</td>
            <td class="number">${formatNumber(damage.critical)}</td>
            <td class="number">${formatNumber(damage.lucky)}</td>
            <td class="number">${formatNumber(damage.crit_lucky)}</td>
            <td class="number">${count.total}</td>
            <td class="number">${formatPercentage(critRate)}</td>
            <td class="number">${formatNumber(userData.realtime_hps || 0)}</td>
            <td class="number">${formatNumber(userData.realtime_hps_max || 0)}</td>
            <td class="number">${formatNumber(userData.total_hps || 0)}</td>
            <td class="number">${formatNumber(healing.total)}</td>
            <td class="number">${formatNumber(healing.normal)}</td>
            <td class="number">${formatNumber(healing.critical)}</td>
            <td class="number">${formatNumber(healing.lucky)}</td>
            <td class="number">${formatNumber(healing.crit_lucky)}</td>
            <td class="number">${healingCount.total}</td>
        `;
        
        if (isNewRow) {
            tbody.appendChild(row);
        }
    }
}

// 添加日志消息
function addLogMessage(level, message) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('zh-CN', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    
    const logItem = document.createElement('div');
    logItem.className = 'log-item';
    logItem.innerHTML = `
        <div class="log-time">${timeString}</div>
        <div class="log-message">
            <span class="log-level ${level}">${level.toUpperCase()}</span>
            ${message}
        </div>
    `;
    
    logContent.appendChild(logItem);
    logContent.scrollTop = logContent.scrollHeight;
    
    // 保存到内存中
    logMessages.push({ timestamp: timeString, level, message });
    
    // 更新日志计数
    updateLogCount();
    
    // 限制日志数量
    if (logMessages.length > 1000) {
        logMessages.shift();
        if (logContent.children.length > 1000) {
            logContent.removeChild(logContent.firstChild);
        }
    }
}

// 更新日志计数
function updateLogCount() {
    if (logCount) {
        logCount.textContent = logMessages.length;
    }
}

// 更新指标图表
function updateMetricCharts() {
    // DPS相关的最大值计算
    const maxDpsValue = Math.max(
        parseFloat(totalRealtimeDps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalMaxDps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalAvgDps.textContent.replace(/[^\d.]/g, '') || 0)
    );
    
    // HPS相关的最大值计算
    const maxHpsValue = Math.max(
        parseFloat(totalRealtimeHps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalMaxHps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalAvgHps.textContent.replace(/[^\d.]/g, '') || 0)
    );
    
    // 更新DPS进度条
    if (maxDpsValue > 0) {
        // 更新实时DPS进度条
        const realtimeDpsPercent = (parseFloat(totalRealtimeDps.textContent.replace(/[^\d.]/g, '') || 0) / maxDpsValue) * 100;
        const realtimeChart = document.querySelector('#realtimeDpsCard .chart-bar');
        if (realtimeChart) {
            realtimeChart.style.width = `${Math.min(realtimeDpsPercent, 100)}%`;
        }
        
        // 更新峰值DPS进度条
        const maxDpsPercent = (parseFloat(totalMaxDps.textContent.replace(/[^\d.]/g, '') || 0) / maxDpsValue) * 100;
        const maxChart = document.querySelector('#maxDpsCard .chart-bar');
        if (maxChart) {
            maxChart.style.width = `${Math.min(maxDpsPercent, 100)}%`;
        }
        
        // 更新平均DPS进度条
        const avgDpsPercent = (parseFloat(totalAvgDps.textContent.replace(/[^\d.]/g, '') || 0) / maxDpsValue) * 100;
        const avgDpsChart = document.querySelector('#avgDpsCard .chart-bar');
        if (avgDpsChart) {
            avgDpsChart.style.width = `${Math.min(avgDpsPercent, 100)}%`;
        }
    }
    
    // 更新HPS进度条
    if (maxHpsValue > 0) {
        // 更新实时HPS进度条
        const realtimeHpsPercent = (parseFloat(totalRealtimeHps.textContent.replace(/[^\d.]/g, '') || 0) / maxHpsValue) * 100;
        const realtimeHpsChart = document.querySelector('#realtimeHpsCard .chart-bar');
        if (realtimeHpsChart) {
            realtimeHpsChart.style.width = `${Math.min(realtimeHpsPercent, 100)}%`;
        }
        
        // 更新峰值HPS进度条
        const maxHpsPercent = (parseFloat(totalMaxHps.textContent.replace(/[^\d.]/g, '') || 0) / maxHpsValue) * 100;
        const maxHpsChart = document.querySelector('#maxHpsCard .chart-bar');
        if (maxHpsChart) {
            maxHpsChart.style.width = `${Math.min(maxHpsPercent, 100)}%`;
        }
        
        // 更新平均HPS进度条
        const avgHpsPercent = (parseFloat(totalAvgHps.textContent.replace(/[^\d.]/g, '') || 0) / maxHpsValue) * 100;
        const avgHpsChart = document.querySelector('#avgHpsCard .chart-bar');
        if (avgHpsChart) {
            avgHpsChart.style.width = `${Math.min(avgHpsPercent, 100)}%`;
        }
    }
    
    // 总伤害使用独立的缩放
    const totalDamageValue = parseFloat(totalDamage.textContent.replace(/[^\d.]/g, '') || 0);
    const damageChart = document.querySelector('#totalDamageCard .chart-bar');
    if (damageChart && totalDamageValue > 0) {
        // 使用对数缩放来更好地显示大数值
        const damagePercent = Math.min((Math.log10(totalDamageValue + 1) / Math.log10(1000000)) * 100, 100);
        damageChart.style.width = `${damagePercent}%`;
    }
    
    // 总治疗使用独立的缩放
    const totalHealingValue = parseFloat(totalHealing.textContent.replace(/[^\d.]/g, '') || 0);
    const healingChart = document.querySelector('#totalHealingCard .chart-bar');
    if (healingChart && totalHealingValue > 0) {
        // 使用对数缩放来更好地显示大数值
        const healingPercent = Math.min((Math.log10(totalHealingValue + 1) / Math.log10(1000000)) * 100, 100);
        healingChart.style.width = `${healingPercent}%`;
    }
}

// 加载设备列表
async function loadDeviceList() {
    try {
        deviceSelect.disabled = true;
        deviceSelect.innerHTML = '<option value="">正在加载设备...</option>';
        
        const devices = await ipcRenderer.invoke('get-devices');
        
        deviceSelect.innerHTML = '<option value="">请选择网络设备</option>';
        
        if (devices.length === 0) {
            deviceSelect.innerHTML = '<option value="">未找到可用设备</option>';
            console.warn('未找到可用的网络设备，请检查权限或网络连接');
            return;
        }
        
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.index;
            option.textContent = device.description;
            option.title = device.name;
            deviceSelect.appendChild(option);
        });
        
        deviceSelect.disabled = false;
        // 确保开始按钮初始状态为禁用
        startCaptureBtn.disabled = true;
        console.info(`已加载 ${devices.length} 个网络设备`);
        
    } catch (error) {
        deviceSelect.innerHTML = '<option value="">加载失败</option>';
        console.error('获取设备列表失败:', error);
    }
}

// 初始化状态
async function initializeStatus() {
    try {
        const status = await ipcRenderer.invoke('get-capture-status');
        updateCaptureStatus(status.isCapturing, status.selectedDevice);
        
        // 主动获取当前玩家UID
        try {
            const uid = await ipcRenderer.invoke('get-player-uid');
            console.log('主页面主动获取UID结果:', uid);
            if (uid) {
                currentPlayerUid = uid;
                playerUid.textContent = uid;
                console.log('主页面UID已设置为:', uid);
            } else {
                playerUid.textContent = '未获取';
                console.log('主页面未获取到UID');
            }
        } catch (error) {
            console.error('主页面获取UID失败:', error);
            playerUid.textContent = '获取失败';
        }
        
        // 兼容旧的status.userUid（如果存在）
        if (status.userUid && !currentPlayerUid) {
            currentPlayerUid = status.userUid;
            playerUid.textContent = status.userUid;
        }
        
        console.info('应用程序已启动');
        
        // 加载设备列表
        await loadDeviceList();
        
        // 检查悬浮窗状态
        const overlayStatus = await ipcRenderer.invoke('get-overlay-status');
        updateOverlayButton(overlayStatus);
        
        // 检查DPS排行榜悬浮窗状态
        const rankingOverlayStatus = await ipcRenderer.invoke('get-ranking-overlay-status');
        updateRankingOverlayButton(rankingOverlayStatus);
        
        // 获取selfOnlyMode初始状态
        const selfOnlyModeStatus = await ipcRenderer.invoke('get-self-only-mode');
        selfOnlyMode = selfOnlyModeStatus;
        updateSelfOnlyButton(selfOnlyModeStatus);
        console.log('主窗口初始化selfOnlyMode状态:', selfOnlyModeStatus);
        
        if (status.isCapturing) {
            console.info(`正在设备 "${status.selectedDevice}" 上抓包`);
        }
    } catch (error) {
        console.error('获取初始状态失败:', error);
    }
}

// 键盘快捷键
function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey) {
            switch (event.key) {
                case 'r':
                case 'R':
                    event.preventDefault();
                    if (!isCapturing) {
                        refreshDeviceBtn.click();
                    }
                    break;
                case 's':
                case 'S':
                    event.preventDefault();
                    if (isCapturing) {
                        stopCaptureBtn.click();
                    }
                    break;
                case 'l':
                case 'L':
                    event.preventDefault();
                    clearLogBtn.click();
                    break;
                case 'd':
                case 'D':
                    event.preventDefault();
                    clearStatsBtn.click();
                    break;
            }
        }
    });
}

// 工具提示
function addTooltips() {
    const tooltips = {
        'refreshDeviceBtn': 'Ctrl+R - 刷新设备列表',
        'stopCaptureBtn': 'Ctrl+S - 停止抓包',
        'clearStatsBtn': 'Ctrl+D - 清除统计数据',
        'clearLogBtn': 'Ctrl+L - 清除日志'
    };
    
    for (const [id, tooltip] of Object.entries(tooltips)) {
        const element = document.getElementById(id);
        if (element) {
            element.title = tooltip;
        }
    }
}

// 主初始化函数
async function initialize() {
    initializeElements();
    bindEventListeners();
    bindIpcListeners();
    bindKeyboardShortcuts();
    addTooltips();
    await initializeStatus();
    initializeModalElements();
    
    // 定期更新时间显示（如果需要）
    setInterval(() => {
        // 可以在这里添加定期更新的逻辑
    }, 1000);
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initialize);

// 窗口关闭前确认和内存清理
window.addEventListener('beforeunload', (event) => {
    // 清理数据引用以释放内存
    statsData = null;
    
    if (isCapturing) {
        event.preventDefault();
        event.returnValue = '正在进行数据包捕获，确定要关闭吗？';
        return event.returnValue;
    }
});

// 导出一些函数供调试使用
window.debugAPI = {
    getStatsData: () => statsData,
    addTestData: () => {
        // 添加测试数据用于开发调试
        const testData = {
            '12345678901234567890': {
                realtime_dps: 15420,
                realtime_dps_max: 23450,
                total_dps: 18500,
                total_damage: {
                    normal: 250000,
                    critical: 180000,
                    lucky: 45000,
                    crit_lucky: 32000,
                    hpLessen: 5000,
                    total: 507000
                },
                total_count: {
                    normal: 125,
                    critical: 89,
                    lucky: 23,
                    total: 237
                }
            }
        };
        statsData = testData;
        updateStatsDisplay();
        console.info('已添加测试数据');
    }
};

// 更新悬浮窗按钮状态
function updateOverlayButton(enabled) {
    overlayEnabled = enabled;
    if (toggleOverlayBtn) {
        const btnText = toggleOverlayBtn.querySelector('.btn-text');
        const btnIcon = toggleOverlayBtn.querySelector('.btn-icon');
        
        if (enabled) {
            btnText.textContent = '关闭悬浮窗';
            btnIcon.textContent = '📱';
            toggleOverlayBtn.classList.remove('btn-outline');
            toggleOverlayBtn.classList.add('btn-success');
        } else {
            btnText.textContent = '悬浮窗';
            btnIcon.textContent = '📱';
            toggleOverlayBtn.classList.remove('btn-success');
            toggleOverlayBtn.classList.add('btn-outline');
        }
    }
}

// 更新DPS排行榜悬浮窗按钮状态
function updateRankingOverlayButton(enabled) {
    rankingOverlayEnabled = enabled;
    if (toggleRankingOverlayBtn) {
        const btnText = toggleRankingOverlayBtn.querySelector('.btn-text');
        const btnIcon = toggleRankingOverlayBtn.querySelector('.btn-icon');
        
        if (enabled) {
            btnText.textContent = '关闭排行榜';
            btnIcon.textContent = '🏆';
            toggleRankingOverlayBtn.classList.remove('btn-outline');
            toggleRankingOverlayBtn.classList.add('btn-success');
        } else {
            btnText.textContent = 'DPS排行榜';
            btnIcon.textContent = '🏆';
            toggleRankingOverlayBtn.classList.remove('btn-success');
            toggleRankingOverlayBtn.classList.add('btn-outline');
        }
    }
}

// 更新"仅自己"按钮状态
function updateSelfOnlyButton(enabled) {
    if (toggleSelfOnlyBtn) {
        const btnText = toggleSelfOnlyBtn.querySelector('.btn-text');
        if (enabled) {
            toggleSelfOnlyBtn.classList.add('active');
            if (btnText) btnText.textContent = '❤️只看自己';
        } else {
            toggleSelfOnlyBtn.classList.remove('active');
            if (btnText) btnText.textContent = '👻谁是内鬼';
        }
    }
}

// 用户详细分析弹窗相关变量
let userDetailModal, userDetailSelect, closeUserDetailModal;
let selectedUserUid, selectedUserRole, userTotalDamage, userTotalHealing;
let damageTab, healingTab, tabButtons;
let damageSkillChart, healingSkillChart;
let damageSkillTableBody, healingSkillTableBody;
let currentAnalysisData = {};

// 初始化弹窗元素
function initializeModalElements() {
    userDetailModal = document.getElementById('userDetailModal');
    userDetailSelect = document.getElementById('userDetailSelect');
    closeUserDetailModal = document.getElementById('closeUserDetailModal');
    selectedUserUid = document.getElementById('selectedUserUid');
    selectedUserRole = document.getElementById('selectedUserRole');
    userTotalDamage = document.getElementById('userTotalDamage');
    userTotalHealing = document.getElementById('userTotalHealing');
    damageTab = document.getElementById('damageTab');
    healingTab = document.getElementById('healingTab');
    damageSkillChart = document.getElementById('damageSkillChart');
    healingSkillChart = document.getElementById('healingSkillChart');
    damageSkillTableBody = document.getElementById('damageSkillTableBody');
    healingSkillTableBody = document.getElementById('healingSkillTableBody');
    tabButtons = document.querySelectorAll('.tab-button');
    
    bindModalEventListeners();
}

// 绑定弹窗事件监听器
function bindModalEventListeners() {
    // 关闭弹窗
    if (closeUserDetailModal) {
        closeUserDetailModal.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Close button clicked');
            closeModal();
        });
    }
    
    // 点击遮罩层关闭弹窗
    if (userDetailModal) {
        userDetailModal.addEventListener('click', (e) => {
            if (e.target === userDetailModal) {
                console.log('Modal overlay clicked');
                closeModal();
            }
        });
    }
    
    // 用户选择器变化
    if (userDetailSelect) {
        userDetailSelect.addEventListener('change', (e) => {
            const selectedUid = e.target.value;
            console.log('User selector changed to:', selectedUid);
            if (selectedUid && statsData[selectedUid]) {
                updateModalData(selectedUid);
            }
        });
    }
    
    // 标签页切换
    tabButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const tabType = e.target.dataset.tab;
            console.log('Tab switched to:', tabType);
            switchTab(tabType);
        });
    });
    
    // ESC键关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && userDetailModal && userDetailModal.style.display !== 'none') {
            console.log('ESC key pressed, closing modal');
            closeModal();
        }
    });
}

// 打开用户详细分析弹窗
function openUserDetailModal(uid) {
    console.log('Opening modal for user:', uid);
    console.log('Modal element:', userDetailModal);
    console.log('User data:', statsData[uid]);
    
    if (!userDetailModal || !statsData[uid]) {
        console.log('Modal or user data not available');
        return;
    }
    
    // 更新用户选择器
    updateUserSelector();
    
    // 设置当前选中的用户
    if (userDetailSelect) {
        userDetailSelect.value = uid;
    }
    
    // 更新弹窗数据
    updateModalData(uid);
    
    // 显示弹窗
    userDetailModal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    console.log('Modal opened successfully');
}

// 关闭弹窗
function closeModal() {
    if (userDetailModal) {
        userDetailModal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

// 更新用户选择器
function updateUserSelector() {
    if (!userDetailSelect) return;
    
    userDetailSelect.innerHTML = '';
    
    Object.keys(statsData).forEach(uid => {
        const userData = statsData[uid];
        const displayName = userData.displayName || uid;
        const option = document.createElement('option');
        option.value = uid;
        option.textContent = `${displayName} (${getRoleNameBySkills(userData.skills)})`;
        option.title = `UID: ${uid}`;
        userDetailSelect.appendChild(option);
    });
}

// 更新弹窗数据
function updateModalData(uid) {
    const userData = statsData[uid];
    if (!userData) {
        return;
    }
    
    // 更新用户基本信息
    const displayName = userData.displayName || uid;
    const fightPoint = userData.playerFightPoint ? formatNumber(userData.playerFightPoint) : '未知';
    
    if (selectedUserUid) {
        selectedUserUid.textContent = displayName;
        selectedUserUid.title = `UID: ${uid}`;
    }
    if (selectedUserRole) {
        selectedUserRole.textContent = `${getRoleNameBySkills(userData.skills)} | 战力: ${fightPoint}`;
    }
    if (userTotalDamage) userTotalDamage.textContent = formatNumber(userData.total_damage ? userData.total_damage.total : 0);
    if (userTotalHealing) userTotalHealing.textContent = formatNumber(userData.total_healing ? userData.total_healing.total : 0);
    
    // 分析技能数据
    currentAnalysisData = analyzeUserSkillData(userData);
    
    // 更新当前显示的标签页
    const activeTab = document.querySelector('.tab-button.active');
    const tabType = activeTab ? activeTab.dataset.tab : 'damage';
    updateTabContent(tabType);
}

// 分析用户技能数据
function analyzeUserSkillData(userData) {
    const damageSkills = {};
    const healingSkills = {};
    
    // 调试：检查技能统计数据是否存在
    if (userData.skill_damage_stats || userData.skill_healing_stats || userData.skill_count_stats) {
        
    } else {
        console.log('技能统计数据为空或未定义');
    }
    
    // 检查是否有技能伤害统计数据
    if (userData.skill_damage_stats && Object.keys(userData.skill_damage_stats).length > 0) {
        for (const [skillId, skillData] of Object.entries(userData.skill_damage_stats)) {
            if (skillData.total && skillData.total > 0) {
                damageSkills[skillId] = {
                    totalDamage: skillData.total,
                    count: skillData.count || 0,
                    maxDamage: skillData.max || 0,
                    avgDamage: skillData.count > 0 ? skillData.total / skillData.count : 0,
                    critRate: skillData.count > 0 ? ((skillData.critCount || 0) / skillData.count * 100) : 0,
                    luckyRate: skillData.count > 0 ? ((skillData.luckyCount || 0) / skillData.count * 100) : 0
                };
            }
        }
    }
    
    // 检查是否有技能治疗统计数据
    if (userData.skill_healing_stats && Object.keys(userData.skill_healing_stats).length > 0) {
        for (const [skillId, skillData] of Object.entries(userData.skill_healing_stats)) {
            if (skillData.total && skillData.total > 0) {
                healingSkills[skillId] = {
                    totalHealing: skillData.total,
                    count: skillData.count || 0,
                    maxHealing: skillData.max || 0,
                    avgHealing: skillData.count > 0 ? skillData.total / skillData.count : 0,
                    critRate: skillData.count > 0 ? ((skillData.critCount || 0) / skillData.count * 100) : 0,
                    luckyRate: skillData.count > 0 ? ((skillData.luckyCount || 0) / skillData.count * 100) : 0
                };
            }
        }
    }
    

    
    return { damageSkills, healingSkills, userData };
}

// 切换标签页
function switchTab(tabType) {
    // 更新标签按钮状态
    tabButtons.forEach(button => {
        if (button.dataset.tab === tabType) {
            button.classList.add('active');
        } else {
            button.classList.remove('active');
        }
    });
    
    // 更新标签页内容显示
    if (damageTab && healingTab) {
        if (tabType === 'damage') {
            damageTab.classList.add('active');
            healingTab.classList.remove('active');
        } else {
            healingTab.classList.add('active');
            damageTab.classList.remove('active');
        }
    }
    
    // 更新标签页内容
    updateTabContent(tabType);
}

// 更新标签页内容
function updateTabContent(tabType) {
    if (tabType === 'damage') {
        updateDamageAnalysis();
    } else {
        updateHealingAnalysis();
    }
}

// 更新伤害分析
function updateDamageAnalysis() {
    const { damageSkills, userData } = currentAnalysisData;
    
    // 更新技能占比图表
    updateSkillChart(damageSkillChart, damageSkills, 'totalDamage');
    
    // 更新技能统计表格
    updateSkillTable(damageSkillTableBody, damageSkills, 'damage');
    
    // 更新伤害类型分布
    updateDamageTypeChart(userData);
}

// 更新治疗分析
function updateHealingAnalysis() {
    const { healingSkills, userData } = currentAnalysisData;
    
    // 更新技能占比图表
    updateSkillChart(healingSkillChart, healingSkills, 'totalHealing');
    
    // 更新技能统计表格
    updateSkillTable(healingSkillTableBody, healingSkills, 'healing');
    
    // 更新治疗类型分布
    updateHealingTypeChart(userData);
}

// 更新技能图表
function updateSkillChart(chartElement, skillsData, valueKey) {
    if (!chartElement) return;
    
    chartElement.innerHTML = '';
    
    // 计算总值
    const totalValue = Object.values(skillsData).reduce((sum, skill) => sum + skill[valueKey], 0);
    
    if (totalValue === 0) {
        chartElement.innerHTML = '<div class="no-data">暂无数据</div>';
        return;
    }
    
    // 按值排序
    const sortedSkills = Object.entries(skillsData)
        .sort(([,a], [,b]) => b[valueKey] - a[valueKey]);
    
    // 创建ECharts容器
    const chartContainer = document.createElement('div');
    chartContainer.style.width = '100%';
    chartContainer.style.height = '400px';
    chartContainer.className = 'echarts-container';
    
    chartElement.appendChild(chartContainer);
    
    // 初始化ECharts实例
    const chart = echarts.init(chartContainer);
    
    // 准备数据
    const chartData = sortedSkills.map(([skillId, skillData]) => ({
        name: `技能${skillId}`,
        value: skillData[valueKey],
        skillId: skillId,
        skillData: skillData,
        valueKey: valueKey
    }));
    
    // 配置选项
     const option = {
        tooltip: {
            trigger: 'item',
            formatter: function(params) {
                const data = params.data;
                const percentage = params.percent;
                const skillData = data.skillData;
                const valueKey = data.valueKey;
                
                return `
                    <div style="padding: 8px;">
                        <div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 4px;">${data.name}</div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">${valueKey === 'totalDamage' ? '总伤害' : '总治疗'}:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${formatNumber(data.value)}</span>
                        </div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">占比:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${percentage}%</span>
                        </div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">次数:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${skillData.count || 0}</span>
                        </div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">${valueKey === 'totalDamage' ? '平均伤害' : '平均治疗'}:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${formatNumber(skillData[valueKey === 'totalDamage' ? 'avgDamage' : 'avgHealing'] || 0)}</span>
                        </div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">${valueKey === 'totalDamage' ? '最高伤害' : '最高治疗'}:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${formatNumber(skillData[valueKey === 'totalDamage' ? 'maxDamage' : 'maxHealing'] || 0)}</span>
                        </div>
                        <div style="margin-bottom: 4px;">
                            <span style="color: #666;">暴击率:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${(skillData.critRate || 0).toFixed(1)}%</span>
                        </div>
                        <div>
                            <span style="color: #666;">幸运率:</span>
                            <span style="font-weight: bold; margin-left: 8px;">${(skillData.luckyRate || 0).toFixed(1)}%</span>
                        </div>
                    </div>
                `;
            },
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            borderColor: '#ccc',
            borderWidth: 1,
            textStyle: {
                fontSize: 12
            }
        },
        legend: {
              orient: 'horizontal',
              bottom: 5,
              left: 'center',
              data: chartData.map(item => item.name),
              textStyle: {
                  fontSize: 10
              },
              itemWidth: 12,
              itemHeight: 8,
              itemGap: 8,
              formatter: function(name) {
                  const item = chartData.find(d => d.name === name);
                  if (item) {
                      const percentage = ((item.value / totalValue) * 100).toFixed(1);
                      return `${name} (${percentage}%)`;
                  }
                  return name;
              }
          },
        series: [{
            name: valueKey === 'totalDamage' ? '伤害占比' : '治疗占比',
            type: 'pie',
            radius: ['35%', '75%'],
             center: ['50%', '40%'],
            avoidLabelOverlap: false,
            itemStyle: {
                borderRadius: 8,
                borderColor: '#fff',
                borderWidth: 2
            },
            label: {
                show: false,
                position: 'center'
            },
            emphasis: {
                label: {
                    show: true,
                    fontSize: '18',
                    fontWeight: 'bold'
                },
                itemStyle: {
                    shadowBlur: 10,
                    shadowOffsetX: 0,
                    shadowColor: 'rgba(0, 0, 0, 0.5)'
                }
            },
            labelLine: {
                show: false
            },
            data: chartData,
            animationType: 'scale',
            animationEasing: 'elasticOut',
            animationDelay: function (idx) {
                return Math.random() * 200;
            }
        }],
        color: [
            '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
            '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6366f1'
        ]
    };
    
    // 设置配置项并渲染图表
    chart.setOption(option);
    
    // 响应式处理
    const resizeObserver = new ResizeObserver(() => {
        chart.resize();
    });
    resizeObserver.observe(chartContainer);
    
    // 存储chart实例以便后续清理
    chartContainer._echartsInstance = chart;
    chartContainer._resizeObserver = resizeObserver;
}

// 更新技能表格
function updateSkillTable(tableBody, skillsData, type) {
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    // 计算总值
    const valueKey = type === 'damage' ? 'totalDamage' : 'totalHealing';
    const totalValue = Object.values(skillsData).reduce((sum, skill) => sum + skill[valueKey], 0);
    
    if (totalValue === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="8" style="text-align: center; color: var(--text-muted);">暂无数据</td>';
        tableBody.appendChild(row);
        return;
    }
    
    // 按值排序
    const sortedSkills = Object.entries(skillsData)
        .sort(([,a], [,b]) => b[valueKey] - a[valueKey]);
    
    sortedSkills.forEach(([skillId, skillData]) => {
        const percentage = (skillData[valueKey] / totalValue * 100).toFixed(1);
        const avgKey = type === 'damage' ? 'avgDamage' : 'avgHealing';
        const maxKey = type === 'damage' ? 'maxDamage' : 'maxHealing';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>技能${skillId}</td>
            <td class="number">${formatNumber(skillData[valueKey])}</td>
            <td class="number">${percentage}%</td>
            <td class="number">${skillData.count}</td>
            <td class="number">${formatNumber(skillData[avgKey])}</td>
            <td class="number">${formatNumber(skillData[maxKey])}</td>
            <td class="number">${skillData.critRate.toFixed(1)}%</td>
            <td class="number">${skillData.luckyRate.toFixed(1)}%</td>
        `;
        
        tableBody.appendChild(row);
    });
    

}

// 更新伤害类型分布图表
function updateDamageTypeChart(userData) {
    if (!userData.total_damage) return;
    
    const damage = userData.total_damage;
    const total = damage.total;
    
    if (total === 0) return;
    
    // 更新各类型的条形图和数值
    updateTypeBar('normalDamageBar', 'normalDamageValue', damage.normal, total);
    updateTypeBar('criticalDamageBar', 'criticalDamageValue', damage.critical, total);
    updateTypeBar('luckyDamageBar', 'luckyDamageValue', damage.lucky, total);
    updateTypeBar('critLuckyDamageBar', 'critLuckyDamageValue', damage.crit_lucky, total);
}

// 更新治疗类型分布图表
function updateHealingTypeChart(userData) {
    if (!userData.total_healing) return;
    
    const healing = userData.total_healing;
    const total = healing.total;
    
    if (total === 0) return;
    
    // 更新各类型的条形图和数值
    updateTypeBar('normalHealingBar', 'normalHealingValue', healing.normal, total);
    updateTypeBar('criticalHealingBar', 'criticalHealingValue', healing.critical, total);
    updateTypeBar('luckyHealingBar', 'luckyHealingValue', healing.lucky, total);
    updateTypeBar('critLuckyHealingBar', 'critLuckyHealingValue', healing.crit_lucky, total);
}

// 更新类型条形图
function updateTypeBar(barId, valueId, value, total) {
    const barElement = document.getElementById(barId);
    const valueElement = document.getElementById(valueId);
    
    if (barElement && valueElement) {
        const percentage = total > 0 ? (value / total * 100) : 0;
        barElement.style.width = `${percentage}%`;
        valueElement.textContent = formatNumber(value);
    }
}

// 获取当前用户UID
function getCurrentUserUid() {
    return currentPlayerUid;
}