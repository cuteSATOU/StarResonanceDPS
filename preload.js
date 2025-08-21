const { contextBridge, ipcRenderer } = require('electron');

// 向渲染进程暴露安全的API
contextBridge.exposeInMainWorld('electronAPI', {
    // 数据获取
    getData: () => ipcRenderer.invoke('get-data'),
    
    // 清除数据
    clearData: () => ipcRenderer.invoke('clear-data'),
    
    // 暂停/恢复统计
    togglePause: (paused) => ipcRenderer.invoke('toggle-pause', paused),
    
    // 获取技能数据
    getSkillData: (uid) => ipcRenderer.invoke('get-skill-data', uid),
    
    // 打开技能分析窗口
    openSkillAnalysis: (uid) => ipcRenderer.invoke('open-skill-analysis', uid),
    
    // 抓包控制
    startCapture: (deviceValue, logLevel) => ipcRenderer.invoke('start-capture', deviceValue, logLevel),
    stopCapture: () => ipcRenderer.invoke('stop-capture'),
    
    // 窗口控制
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    toggleMaximizeWindow: () => ipcRenderer.invoke('toggle-maximize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    
    // 血条监控窗口控制
    openHpWindow: () => ipcRenderer.invoke('open-hp-window'),
    minimizeHpWindow: () => ipcRenderer.invoke('minimize-hp-window'),
    setHpWindowAlwaysOnTop: (alwaysOnTop) => ipcRenderer.invoke('set-hp-window-always-on-top', alwaysOnTop),
    
    // 血条监控数据请求
    requestPlayerData: () => {
        // 血条监控窗口可以通过主窗口的数据更新机制获取数据
        // 这里提供一个手动请求的接口
        return ipcRenderer.invoke('get-data');
    },
    
    // 监听主进程发送的事件
    onDataUpdate: (callback) => {
        ipcRenderer.on('data-update', (event, data) => callback(data));
    },
    
    onShowDeviceSelection: (callback) => {
        ipcRenderer.on('show-device-selection', () => callback());
    },
    
    onClearAllData: (callback) => {
        ipcRenderer.on('clear-all-data', () => callback());
    },
    
    onTogglePauseState: (callback) => {
        ipcRenderer.on('toggle-pause-state', () => callback());
    },

    onWindowStateChange: (callback) => {
        ipcRenderer.on('window-state-change', (event, isMaximized) => callback(isMaximized));
    },

    onCaptureStarted: (callback) => {
        ipcRenderer.on('capture-started', (event, data) => callback(data));
    },

    onCaptureFailed: (callback) => {
        ipcRenderer.on('capture-failed', (event, error) => callback(error));
    },

    onCaptureStopped: (callback) => {
        ipcRenderer.on('capture-stopped', (event, data) => callback(data));
    },

    // 技能分析窗口初始化事件
    onInitSkillAnalysis: (callback) => {
        ipcRenderer.on('init-skill-analysis', (event, uid) => callback(uid));
    },

    // 设备列表监听事件
    onDeviceList: (callback) => {
        ipcRenderer.on('device-list', (event, devices) => callback(devices));
    },
    
    // 血条监控窗口事件监听
    onPlayerDataUpdate: (callback) => {
        ipcRenderer.on('player-data-update', (event, data) => callback(data));
    },
    
    onConnectionStatusChange: (callback) => {
        ipcRenderer.on('connection-status-change', (event, status) => callback(status));
    },

    onHpWindowClosed: (callback) => {
        ipcRenderer.on('hp-window-closed', () => callback());
    },
    
    // 移除事件监听器
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },

    // 暴露 ipcRenderer 给技能分析窗口使用
    ipcRenderer: ipcRenderer
});
