const { ipcRenderer } = require('electron');

// DOM元素引用
let statusCard, statusIndicator, currentDevice, playerUid, noDataMessage, statsContainer;
let deviceSelect, refreshDeviceBtn, startCaptureBtn, stopCaptureBtn, clearStatsBtn, showLogBtn, toggleOverlayBtn;
let totalRealtimeDps, totalMaxDps, totalAvgDps, totalDamage, statsTable;
let minimizeBtn, maximizeBtn, closeBtn;

// 全局状态
let isCapturing = false;
let statsData = {};
let overlayEnabled = false;

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
    
    // 窗口控制按钮
    minimizeBtn = document.getElementById('minimizeBtn');
    maximizeBtn = document.getElementById('maximizeBtn');
    closeBtn = document.getElementById('closeBtn');
    
    // 数据展示元素
    totalRealtimeDps = document.getElementById('totalRealtimeDps');
    totalMaxDps = document.getElementById('totalMaxDps');
    totalAvgDps = document.getElementById('totalAvgDps');
    totalDamage = document.getElementById('totalDamage');
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
}

// IPC事件监听
function bindIpcListeners() {
    // 接收统计数据更新
    ipcRenderer.on('stats-updated', (event, data) => {
        statsData = data;
        updateStatsDisplay();
    });

    // 接收玩家UID更新
    ipcRenderer.on('player-uid-updated', (event, uid) => {
        playerUid.textContent = uid || '未获取';
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

// 更新统计数据显示
function updateStatsDisplay() {
    const userIds = Object.keys(statsData);
    
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
    let playerCount = 0;
    
    for (const uid of userIds) {
        const userData = statsData[uid];
        totalRealtimeDpsValue += userData.realtime_dps || 0;
        totalMaxDpsValue = Math.max(totalMaxDpsValue, userData.realtime_dps_max || 0);
        totalAvgDpsValue += userData.total_dps || 0;
        totalDamageValue += userData.total_damage.total || 0;
        playerCount++;
    }
    
    if (playerCount > 0) {
        totalAvgDpsValue = totalAvgDpsValue / playerCount;
    }
    
    // 更新概览卡片
    totalRealtimeDps.textContent = formatNumber(totalRealtimeDpsValue);
    totalMaxDps.textContent = formatNumber(totalMaxDpsValue);
    totalAvgDps.textContent = formatNumber(totalAvgDpsValue);
    totalDamage.textContent = formatNumber(totalDamageValue);
    
    // 更新表格
    updateStatsTable();
    
    // 更新图表进度条
    updateMetricCharts();
}

// 更新统计表格
function updateStatsTable() {
    const tbody = statsTable.querySelector('tbody');
    tbody.innerHTML = '';
    
    const userIds = Object.keys(statsData).sort();
    
    for (const uid of userIds) {
        const userData = statsData[uid];
        const damage = userData.total_damage;
        const count = userData.total_count;
        
        // 计算暴击率
        const critRate = count.total > 0 ? count.critical / count.total : 0;
        
        const row = document.createElement('tr');
        row.className = 'stats-update';
        
        row.innerHTML = `
            <td>${uid}</td>
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
        `;
        
        tbody.appendChild(row);
        
        // 移除动画类
        setTimeout(() => {
            row.classList.remove('stats-update');
        }, 500);
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
    const maxValue = Math.max(
        parseFloat(totalRealtimeDps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalMaxDps.textContent.replace(/[^\d.]/g, '') || 0),
        parseFloat(totalAvgDps.textContent.replace(/[^\d.]/g, '') || 0)
    );
    
    if (maxValue > 0) {
        // 更新实时DPS进度条
        const realtimeDpsPercent = (parseFloat(totalRealtimeDps.textContent.replace(/[^\d.]/g, '') || 0) / maxValue) * 100;
        const realtimeChart = document.querySelector('.metric-card.primary .chart-bar');
        if (realtimeChart) {
            realtimeChart.style.width = `${Math.min(realtimeDpsPercent, 100)}%`;
        }
        
        // 更新峰值DPS进度条
        const maxDpsPercent = (parseFloat(totalMaxDps.textContent.replace(/[^\d.]/g, '') || 0) / maxValue) * 100;
        const maxChart = document.querySelector('.metric-card.danger .chart-bar');
        if (maxChart) {
            maxChart.style.width = `${Math.min(maxDpsPercent, 100)}%`;
        }
        
        // 更新平均DPS进度条
        const avgDpsPercent = (parseFloat(totalAvgDps.textContent.replace(/[^\d.]/g, '') || 0) / maxValue) * 100;
        const avgChart = document.querySelector('.metric-card.success .chart-bar');
        if (avgChart) {
            avgChart.style.width = `${Math.min(avgDpsPercent, 100)}%`;
        }
        
        // 总伤害使用独立的缩放
        const totalDamageValue = parseFloat(totalDamage.textContent.replace(/[^\d.]/g, '') || 0);
        const damageChart = document.querySelector('.metric-card.warning .chart-bar');
        if (damageChart && totalDamageValue > 0) {
            // 使用对数缩放来更好地显示大数值
            const damagePercent = Math.min((Math.log10(totalDamageValue + 1) / Math.log10(1000000)) * 100, 100);
            damageChart.style.width = `${damagePercent}%`;
        }
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
        
        if (status.userUid) {
            playerUid.textContent = status.userUid;
        }
        
        console.info('应用程序已启动');
        
        // 加载设备列表
        await loadDeviceList();
        
        // 检查悬浮窗状态
        const overlayStatus = await ipcRenderer.invoke('get-overlay-status');
        updateOverlayButton(overlayStatus);
        
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