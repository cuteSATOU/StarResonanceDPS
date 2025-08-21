const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const readline = require('readline');
const winston = require('winston');
const { UserDataManager } = require('./core/data-manager');
const PacketCapture = require('./core/packet-capture');

class ElectronDamageCounter {
    constructor() {
        this.mainWindow = null;
        this.logger = null;
        this.userDataManager = null;
        this.packetCapture = null;
        this.isCapturing = false;
        this.deviceSelectionWindow = null;
        this.skillAnalysisWindow = null;
        this.hpWindow = null;
        
        // 数据更新定时器
        this.dataUpdateTimer = null;
        
        // 当前设备名称
        this.currentDeviceName = null;
        
        // 悬浮窗位置记忆
        this.hpWindowPosition = { x: undefined, y: undefined };
    }

    createLogger(logLevel = 'info') {
        this.logger = winston.createLogger({
            level: logLevel,
            format: winston.format.combine(
                winston.format.colorize({ all: true }),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf((info) => {
                    return `[${info.timestamp}] [${info.level}] ${info.message}`;
                }),
            ),
            transports: [new winston.transports.Console()],
        });
    }

    createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            frame: false, // 隐藏窗口工具栏
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            icon: path.join(__dirname, 'assets', 'icon.png'), // 可选：应用图标
            show: false // 先不显示，等加载完成再显示
        });

        this.mainWindow.loadFile('public/index.html');

        this.mainWindow.once('ready-to-show', () => {
            this.mainWindow.show();
            
            // 初始化服务并发送设备列表到主窗口
            this.initializeServices('info');
            setTimeout(() => {
                if (this.packetCapture) {
                    const devices = this.packetCapture.getDevices();
                    this.mainWindow.webContents.send('device-list', devices);
                }
            }, 500);
        });

        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
        });

        // 监听窗口状态变化
        this.mainWindow.on('maximize', () => {
            this.mainWindow.webContents.send('window-state-change', true);
        });

        this.mainWindow.on('unmaximize', () => {
            this.mainWindow.webContents.send('window-state-change', false);
        });

        // 开发环境下打开开发者工具
        if (process.env.NODE_ENV === 'development') {
            this.mainWindow.webContents.openDevTools();
        }
    }



    createSkillAnalysisWindow(uid) {
        // 如果窗口已经存在，则关闭并重新创建
        if (this.skillAnalysisWindow) {
            this.skillAnalysisWindow.close();
            this.skillAnalysisWindow = null;
        }

        this.skillAnalysisWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            parent: this.mainWindow,
            frame: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            show: false,
            title: '技能分析',
            icon: path.join(__dirname, 'assets', 'icon.png')
        });

        // 加载技能分析页面
        this.skillAnalysisWindow.loadFile('public/skill-analysis.html');

        this.skillAnalysisWindow.once('ready-to-show', () => {
            this.skillAnalysisWindow.show();
            // 窗口准备就绪后发送用户ID
            this.skillAnalysisWindow.webContents.send('init-skill-analysis', uid);
        });

        this.skillAnalysisWindow.on('closed', () => {
            this.skillAnalysisWindow = null;
        });
    }

    createHpWindow() {
        // 如果窗口已经存在，则显示并聚焦
        if (this.hpWindow) {
            this.hpWindow.show();
            this.hpWindow.focus();
            return;
        }

        const windowOptions = {
            width: 400,
            height: 600,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            resizable: true,
            minimizable: true,
            maximizable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            show: false,
            title: '血条监控',
            icon: path.join(__dirname, 'assets', 'icon.png')
        };
        
        // 如果有保存的位置，则恢复位置
        if (this.hpWindowPosition.x !== undefined && this.hpWindowPosition.y !== undefined) {
            windowOptions.x = this.hpWindowPosition.x;
            windowOptions.y = this.hpWindowPosition.y;
        }
        
        this.hpWindow = new BrowserWindow(windowOptions);

        // 加载血条监控页面
        this.hpWindow.loadFile('public/hp_window.html');

        this.hpWindow.once('ready-to-show', () => {
            this.hpWindow.show();
        });

        // 监听窗口移动事件，实时保存位置
        this.hpWindow.on('moved', () => {
            if (this.hpWindow && !this.hpWindow.isDestroyed()) {
                const [x, y] = this.hpWindow.getPosition();
                this.hpWindowPosition.x = x;
                this.hpWindowPosition.y = y;
            }
        });
        
        this.hpWindow.on('closed', () => {
            // 保存窗口位置
            if (this.hpWindow && !this.hpWindow.isDestroyed()) {
                const [x, y] = this.hpWindow.getPosition();
                this.hpWindowPosition.x = x;
                this.hpWindowPosition.y = y;
            }
            
            this.hpWindow = null;
            // 通知主窗口更新按钮状态
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('hp-window-closed');
            }
        });
    }

    setupIpcHandlers() {
        // 获取数据
        ipcMain.handle('get-data', () => {
            if (!this.userDataManager) return { code: 1, msg: 'Data manager not initialized' };
            return {
                code: 0,
                user: this.userDataManager.getAllUsersData(),
                isCapturing: this.isCapturing,
                isPaused: this.packetCapture ? this.packetCapture.getPausedState() : false
            };
        });

        // 清除数据
        ipcMain.handle('clear-data', () => {
            if (!this.userDataManager) return { code: 1, msg: 'Data manager not initialized' };
            this.userDataManager.clearAll();
            this.logger.info('Statistics have been cleared!');
            return { code: 0, msg: 'Statistics have been cleared!' };
        });

        // 暂停/恢复统计
        ipcMain.handle('toggle-pause', (event, paused) => {
            if (!this.packetCapture) return { code: 1, msg: 'Packet capture not initialized' };
            
            if (paused) {
                this.packetCapture.pause();
            } else {
                this.packetCapture.resume();
            }
            
            this.logger.info(`Statistics ${paused ? 'paused' : 'resumed'}!`);
            return {
                code: 0,
                msg: `Statistics ${paused ? 'paused' : 'resumed'}!`,
                paused
            };
        });

        // 获取技能数据
        ipcMain.handle('get-skill-data', (event, uid) => {
            if (!this.userDataManager) return { code: 1, msg: 'Data manager not initialized' };
            
            const skillData = this.userDataManager.getUserSkillData(parseInt(uid));
            if (!skillData) {
                return { code: 1, msg: 'User not found' };
            }
            
            return { code: 0, data: skillData };
        });

        // 打开技能分析窗口
        ipcMain.handle('open-skill-analysis', (event, uid) => {
            try {
                this.createSkillAnalysisWindow(uid);
                return { code: 0, msg: 'Skill analysis window opened' };
            } catch (error) {
                this.logger.error('Failed to open skill analysis window:', error);
                return { code: 1, msg: `Failed to open skill analysis window: ${error.message}` };
            }
        });



        // 开始抓包
        ipcMain.handle('start-capture', async (event, deviceValue, logLevel) => {
            try {
                // 重新创建logger如果日志级别改变
                if (!this.logger || this.logger.level !== logLevel) {
                    this.createLogger(logLevel);
                }

                if (!this.userDataManager || !this.packetCapture) {
                    this.initializeServices(logLevel);
                }

                await this.packetCapture.startCapture(deviceValue);
                this.isCapturing = true;
                this.startDataUpdates();

                // 获取设备名称
                let deviceName = '未知设备';
                if (deviceValue === 'auto') {
                    deviceName = '自动检测';
                } else {
                    const devices = this.packetCapture.getDevices();
                    const deviceIndex = parseInt(deviceValue);
                    if (devices && devices[deviceIndex]) {
                        deviceName = devices[deviceIndex].description || devices[deviceIndex].name || `设备${deviceIndex}`;
                    }
                }
                
                // 保存当前设备名称
                this.currentDeviceName = deviceName;

                // 通知主窗口抓包开始成功
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('capture-started', { 
                        deviceValue,
                        deviceName,
                        message: '抓包已开始' 
                    });
                }

                return { 
                    code: 0, 
                    msg: `开始抓包: 设备${deviceValue}, 日志级别${logLevel}` 
                };
            } catch (error) {
                this.logger.error('Failed to start capture:', error);
                
                // 通知主窗口抓包开始失败
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('capture-failed', { 
                        error: error.message,
                        message: `启动抓包失败: ${error.message}`
                    });
                }

                return { 
                    code: 1, 
                    msg: `启动抓包失败: ${error.message}` 
                };
            }
        });

        // 停止抓包
        ipcMain.handle('stop-capture', () => {
            if (this.packetCapture) {
                this.packetCapture.destroy();
                this.isCapturing = false;
                this.stopDataUpdates();
                
                // 清除设备名称
                this.currentDeviceName = null;
                
                this.logger.info('Packet capture stopped');
                
                // 通知主窗口抓包已停止
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('capture-stopped', { 
                        message: '抓包已停止' 
                    });
                }
                
                return { code: 0, msg: 'Packet capture stopped' };
            }
            return { code: 1, msg: 'No active capture to stop' };
        });

        // 窗口控制功能
        ipcMain.handle('minimize-window', () => {
            if (this.mainWindow) {
                this.mainWindow.minimize();
            }
        });

        ipcMain.handle('toggle-maximize-window', () => {
            if (this.mainWindow) {
                if (this.mainWindow.isMaximized()) {
                    this.mainWindow.restore();
                    return false;
                } else {
                    this.mainWindow.maximize();
                    return true;
                }
            }
            return false;
        });

        ipcMain.handle('close-window', () => {
            if (this.mainWindow) {
                this.mainWindow.close();
            }
        });

        // 血条监控窗口控制
        ipcMain.handle('open-hp-window', () => {
            try {
                // 检查窗口是否已存在且可见
                if (this.hpWindow && !this.hpWindow.isDestroyed()) {
                    if (this.hpWindow.isVisible()) {
                        // 窗口已打开，关闭它
                        this.hpWindow.close();
                        return { code: 0, msg: 'HP window closed', isOpen: false };
                    } else {
                        // 窗口存在但隐藏，显示它
                        this.hpWindow.show();
                        return { code: 0, msg: 'HP window shown', isOpen: true };
                    }
                } else {
                    // 窗口不存在，创建新窗口
                    this.createHpWindow();
                    return { code: 0, msg: 'HP window opened', isOpen: true };
                }
            } catch (error) {
                this.logger.error('Failed to toggle HP window:', error);
                return { code: 1, msg: `Failed to toggle HP window: ${error.message}` };
            }
        });

        ipcMain.handle('minimize-hp-window', () => {
            if (this.hpWindow) {
                this.hpWindow.minimize();
            }
        });

        ipcMain.handle('set-hp-window-always-on-top', (event, alwaysOnTop) => {
            if (this.hpWindow) {
                this.hpWindow.setAlwaysOnTop(alwaysOnTop);
                return alwaysOnTop;
            }
            return false;
        });


    }

    initializeServices(logLevel = 'info') {
        if (!this.logger) {
            this.createLogger(logLevel);
        }

        this.userDataManager = new UserDataManager(this.logger);
        this.packetCapture = new PacketCapture(this.logger, this.userDataManager);

        // 进程退出时保存用户缓存
        const cleanup = () => {
            console.log('\\nSaving user cache...');
            if (this.userDataManager) {
                this.userDataManager.forceUserCacheSave();
            }
            if (this.packetCapture) {
                this.packetCapture.destroy();
            }
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('before-quit', cleanup);
    }

    startDataUpdates() {
        // 每100ms向渲染进程发送数据更新
        this.dataUpdateTimer = setInterval(() => {
            if (this.userDataManager && this.isCapturing) {
                // 获取当前设备名称
                let deviceName = this.currentDeviceName || '正在抓包...';
                
                const data = {
                    code: 0,
                    user: this.userDataManager.getAllUsersData(),
                    isCapturing: this.isCapturing,
                    isPaused: this.packetCapture ? this.packetCapture.getPausedState() : false,
                    deviceName: deviceName
                };
                
                // 向主窗口发送数据更新
                if (this.mainWindow) {
                    this.mainWindow.webContents.send('data-update', data);
                }
                
                // 向血条监控窗口发送数据更新
                if (this.hpWindow) {
                    // 为血条监控窗口准备特定的数据格式
                    const hpData = {
                        players: Object.values(data.user || {}).map(user => ({
                            id: user.uid,
                            name: user.name,
                            profession: user.profession,
                            hp: user.hp,
                            maxHp: user.maxHp,
                            hpPercent: user.maxHp > 0 ? (user.hp / user.maxHp * 100) : 0,
                            dps: user.dps || 0,
                            hps: user.hps || 0,
                            isAlive: user.hp > 0
                        })),
                        connected: this.isCapturing && !this.packetCapture.getPausedState()
                    };
                    this.hpWindow.webContents.send('player-data-update', hpData);
                    this.hpWindow.webContents.send('connection-status-change', { connected: hpData.connected });
                }
            }
        }, 100);
    }

    stopDataUpdates() {
        if (this.dataUpdateTimer) {
            clearInterval(this.dataUpdateTimer);
            this.dataUpdateTimer = null;
        }
    }

    async initialize() {
        await app.whenReady();
        
        this.createMainWindow();
        this.setupIpcHandlers();

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createMainWindow();
            }
        });
    }
}

// 创建应用实例并启动
const damageCounter = new ElectronDamageCounter();
damageCounter.initialize().catch(console.error);
