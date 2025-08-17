const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const cap = require('cap');
const winston = require("winston");
const zlib = require('zlib');
const pb = require('./algo/pb');
const bpb = require('./algo/blueprotobuf');
const pbjs = require("protobufjs/minimal");
const { Readable } = require("stream");
const PacketProcessor = require('./algo/packet');

// PacketProcessor 实例将在后面创建

const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;

// 全局变量
let mainWindow;
let logWindow;
let overlayWindow;
let rankingOverlayWindow; // DPS排行榜悬浮窗
let devices = [];
let isCapturing = false;
let selectedDevice = null;
let capInstance = null; // Cap实例
let overlayEnabled = false;
let rankingOverlayEnabled = false; // DPS排行榜悬浮窗状态
let selfOnlyMode = false;

// 统计数据
let total_damage = {};
let total_count = {};
let total_healing = {}; // 治疗统计
let healing_count = {}; // 治疗次数统计
let dps_window = {};
let hps_window = {}; // HPS滑动窗口
let damage_time = {};
let healing_time = {}; // 治疗时间统计
let realtime_dps = {};
let realtime_hps = {}; // 实时HPS (Healing Per Second)
let player_skills = {}; // 玩家技能信息，用于职业识别
let skill_damage_stats = {}; // 按技能ID统计的伤害数据
let skill_healing_stats = {}; // 按技能ID统计的治疗数据
let skill_count_stats = {}; // 按技能ID统计的使用次数

// 用户数据管理器
let player_names = {}; // 玩家昵称 {uid: name}
let player_fight_points = {}; // 玩家战力 {uid: fightPoint}
let player_profession_ids = {}; // 玩家职业ID {uid: professionId}

// 网络包处理变量
let user_uid;
let current_server = '';
let _data = Buffer.alloc(0);
let tcp_next_seq = -1;
let tcp_cache = new Map();
let tcp_last_time = 0;

// IP分片处理相关变量
const fragmentIpCache = new Map();
const FRAGMENT_TIMEOUT = 30000;

// 性能监控变量
let packet_count = 0;
let last_packet_time = 0;
let performance_warnings = 0;

// 日志缓存队列，用于在mainWindow创建前缓存日志
let logQueue = [];

// 内存优化变量
let dataCleanupInterval;
let statsUpdateInterval;
let tcpCleanupInterval;

// 配置文件路径
const configPath = path.join(app.getPath('userData'), 'config.json');

// 默认配置
const defaultConfig = {
    overlayEnabled: false,
    rankingOverlayEnabled: false,
    selfOnlyMode: false,
    overlaySettings: {
        opacity: 90,
        updateFreency: 250,
        detailsExpanded: true,
        isPinned: true,
        hideHpsDisplay: false
    }
};

// 当前配置
let appConfig = { ...defaultConfig };

// 自定义传输器，将日志发送到渲染进程
class ElectronTransport extends winston.transports.Console {
    log(info, callback) {
        // 先调用父类方法处理控制台输出
        super.log(info, () => {
            // 父类回调完成后，处理发送到渲染进程的逻辑
            const level = info.level.replace(/\x1b\[[0-9;]*m/g, ''); // 移除颜色码
            const logEntry = { level, message: info.message };
            
            // 发送到日志窗口（优先）
            if (logWindow && logWindow.webContents) {
                logWindow.webContents.send('log-message', level, info.message);
            } else {
                // 如果日志窗口没有打开，缓存日志（限制缓存大小）
                logQueue.push(logEntry);
                if (logQueue.length > 100) {
                    logQueue.shift(); // 移除最旧的日志
                }
            }
            
            // 只调用一次callback
            callback();
        });
    }
}

// 发送缓存的日志到渲染进程
function flushLogQueue() {
    if (mainWindow && mainWindow.webContents && logQueue.length > 0) {
        logQueue.forEach(log => {
            mainWindow.webContents.send('log-message', log.level, log.message);
        });
        logQueue = [];
    }
}

// 日志配置
const logger = winston.createLogger({
    level: 'warn',
    format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => {
            return `[${info.timestamp}] [${info.level}] ${info.message}`;
        })
    ),
    transports: [
        new ElectronTransport()
    ]
});

// PacketProcessor 实例将在 UserDataManager 定义后初始化
let packetProcessor;

// Lock类用于TCP包处理同步
// TCP锁已移除，改为单线程处理

// 配置管理函数
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            const loadedConfig = JSON.parse(configData);
            appConfig = { ...defaultConfig, ...loadedConfig };
            logger.info('配置文件加载成功:', appConfig);
        } else {
            logger.info('配置文件不存在，使用默认配置');
            saveConfig(); // 创建默认配置文件
        }
    } catch (error) {
        logger.error('加载配置文件失败:', error);
        appConfig = { ...defaultConfig };
    }
}

function saveConfig() {
    try {
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2), 'utf8');
        logger.info('配置文件保存成功:', appConfig);
    } catch (error) {
        logger.error('保存配置文件失败:', error);
    }
}

function updateConfig(key, value) {
    appConfig[key] = value;
    saveConfig();
}

// 用户数据管理器方法
class UserDataManager {
    static setName(uid, name) {
        player_names[uid] = name;
        logger.info(`Set player name: ${name} for UID ${uid}`);
    }
    
    static setFightPoint(uid, fightPoint) {
        player_fight_points[uid] = fightPoint;
        logger.debug(`Set player fight point: ${fightPoint} for UID ${uid}`);
    }
    
    static setProfession(uid, professionId) {
        player_profession_ids[uid] = professionId;
        logger.debug(`Set player profession ID: ${professionId} for UID ${uid}`);
    }
    
    static getName(uid) {
        return player_names[uid] || null;
    }
    
    static getFightPoint(uid) {
        return player_fight_points[uid] || null;
    }
    
    static getProfessionId(uid) {
        return player_profession_ids[uid] || null;
    }
    
    static getDisplayName(uid) {
        // 如果是当前玩家，优先显示昵称，如果没有昵称则显示UID
        if (user_uid && uid === user_uid.toString()) {
            return player_names[uid] || uid;
        }
        // 如果有昵称则显示昵称，否则显示UID
        return player_names[uid] || uid;
    }
    
    static getAllUserData() {
        const result = {};
        const allUids = new Set([
            ...Object.keys(player_names),
            ...Object.keys(player_fight_points),
            ...Object.keys(player_profession_ids)
        ]);
        
        for (const uid of allUids) {
            result[uid] = {
                name: player_names[uid] || null,
                fightPoint: player_fight_points[uid] || null,
                professionId: player_profession_ids[uid] || null,
                displayName: this.getDisplayName(uid)
            };
        }
        
        return result;
    }
    
    // 获取单个用户数据，兼容 PacketProcessor 接口
    static getUser(uid) {
        return {
            name: player_names[uid] || null,
            fightPoint: player_fight_points[uid] || null,
            professionId: player_profession_ids[uid] || null,
            displayName: this.getDisplayName(uid)
        };
    }
    
    // 添加伤害数据的方法，兼容 packet.js 接口
    static addDamage(uid, skillId, damage, isCrit, isLucky, hpLessenValue) {
        if (!total_damage[uid]) {
            total_damage[uid] = {
                normal: 0,
                critical: 0,
                lucky: 0,
                crit_lucky: 0,
                hpLessen: 0,
                total: 0
            };
            total_count[uid] = {
                normal: 0,
                critical: 0,
                lucky: 0,
                total: 0
            };
            dps_window[uid] = [];
            damage_time[uid] = [];
            realtime_dps[uid] = 0;
        }
        
        // 根据伤害类型分类统计
        if (isCrit && isLucky) {
            total_damage[uid].crit_lucky += damage;
        } else if (isCrit) {
            total_damage[uid].critical += damage;
            total_count[uid].critical++;
        } else if (isLucky) {
            total_damage[uid].lucky += damage;
            total_count[uid].lucky++;
        } else {
            total_damage[uid].normal += damage;
            total_count[uid].normal++;
        }
        
        if (hpLessenValue) {
            total_damage[uid].hpLessen += hpLessenValue;
        }
        
        total_damage[uid].total += damage;
        total_count[uid].total++;
        
        // 确保数组存在（可能被数据清理定时器删除）
        if (!dps_window[uid]) {
            dps_window[uid] = [];
        }
        if (!damage_time[uid]) {
            damage_time[uid] = [];
        }
        
        const now = Date.now();
        dps_window[uid].push({ damage, time: now, isCrit, isLucky, hpLessenValue });
        damage_time[uid].push(now);
        
        // 记录技能伤害统计
        if (skillId) {
            // 记录技能ID到player_skills数组（用于职业识别）
            if (!player_skills[uid]) {
                player_skills[uid] = new Set();
            }
            player_skills[uid].add(skillId);
            
            if (!skill_damage_stats[uid]) {
                skill_damage_stats[uid] = {};
            }
            if (!skill_damage_stats[uid][skillId]) {
                skill_damage_stats[uid][skillId] = { total: 0, count: 0, critCount: 0, luckyCount: 0, max: 0 };
            }
            skill_damage_stats[uid][skillId].total += damage;
            skill_damage_stats[uid][skillId].count++;
            if (isCrit) skill_damage_stats[uid][skillId].critCount++;
            if (isLucky) skill_damage_stats[uid][skillId].luckyCount++;
            // 更新最高伤害
            if (damage > skill_damage_stats[uid][skillId].max) {
                skill_damage_stats[uid][skillId].max = damage;
            }
            
            // 记录技能使用次数统计
            if (!skill_count_stats[uid]) {
                skill_count_stats[uid] = {};
            }
            if (!skill_count_stats[uid][skillId]) {
                skill_count_stats[uid][skillId] = 0;
            }
            skill_count_stats[uid][skillId]++;
        }
    }
    
    // 添加治疗数据的方法，兼容 packet.js 接口
    static addHealing(uid, skillId, healing, isCrit, isLucky) {
        if (!total_healing[uid]) {
            total_healing[uid] = {
                normal: 0,
                critical: 0,
                lucky: 0,
                total: 0
            };
            healing_count[uid] = {
                normal: 0,
                critical: 0,
                lucky: 0,
                total: 0
            };
            hps_window[uid] = [];
            healing_time[uid] = [];
            realtime_hps[uid] = 0;
        }
        
        // 根据治疗类型分类统计
        if (isCrit) {
            total_healing[uid].critical += healing;
            healing_count[uid].critical++;
        } else if (isLucky) {
            total_healing[uid].lucky += healing;
            healing_count[uid].lucky++;
        } else {
            total_healing[uid].normal += healing;
            healing_count[uid].normal++;
        }
        
        total_healing[uid].total += healing;
        healing_count[uid].total++;
        
        // 确保数组存在（可能被数据清理定时器删除）
        if (!hps_window[uid]) {
            hps_window[uid] = [];
        }
        if (!healing_time[uid]) {
            healing_time[uid] = [];
        }
        
        const now = Date.now();
        hps_window[uid].push({ healing, time: now, isCrit, isLucky });
        healing_time[uid].push(now);
        
        // 记录技能治疗统计
        if (skillId) {
            // 记录技能ID到player_skills数组（用于职业识别）
            if (!player_skills[uid]) {
                player_skills[uid] = new Set();
            }
            player_skills[uid].add(skillId);
            
            if (!skill_healing_stats[uid]) {
                skill_healing_stats[uid] = {};
            }
            if (!skill_healing_stats[uid][skillId]) {
                skill_healing_stats[uid][skillId] = { total: 0, count: 0, critCount: 0, luckyCount: 0, max: 0 };
            }
            skill_healing_stats[uid][skillId].total += healing;
            skill_healing_stats[uid][skillId].count++;
            if (isCrit) skill_healing_stats[uid][skillId].critCount++;
            if (isLucky) skill_healing_stats[uid][skillId].luckyCount++;
            // 更新最高治疗
            if (healing > skill_healing_stats[uid][skillId].max) {
                skill_healing_stats[uid][skillId].max = healing;
            }
            
            // 记录技能使用次数统计
            if (!skill_count_stats[uid]) {
                skill_count_stats[uid] = {};
            }
            if (!skill_count_stats[uid][skillId]) {
                skill_count_stats[uid][skillId] = 0;
            }
            skill_count_stats[uid][skillId]++;
        }
    }
    
    // 添加承受伤害数据的方法，兼容 packet.js 接口
    static addTakenDamage(uid, damage, skillId) {
        // 这里可以根据需要添加承受伤害的统计逻辑
        // 目前暂时不做特殊处理，可以后续扩展
    }
}

// 初始化 PacketProcessor 实例
packetProcessor = new PacketProcessor({ logger, userDataManager: UserDataManager });

// 创建主窗口
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false, // 去掉标题栏
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets/icon.png'), // 如果有图标的话
        title: '星痕共鸣 DPS 统计工具',
        titleBarStyle: 'hidden', // 隐藏标题栏
        trafficLightPosition: { x: 15, y: 15 } // macOS 窗口控制按钮位置
    });

    mainWindow.loadFile('src/index.html');

    // 页面加载完成后发送缓存的日志
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            flushLogQueue();
        }, 500); // 等待一段时间确保渲染进程已准备好
    });

    // 开发时打开开发者工具
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (isCapturing) {
            stopCapture();
        }
        // 停止定时器
        stopDataUpdateTimers();
        // 关闭其他窗口
        if (logWindow) {
            logWindow.close();
        }
        if (overlayWindow) {
            overlayWindow.close();
        }
        if (rankingOverlayWindow) {
            rankingOverlayWindow.close();
        }
    });
}

// 创建日志窗口
function createLogWindow() {
    if (logWindow) {
        logWindow.focus();
        return;
    }

    logWindow = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'assets/icon.png'),
        title: '实时日志 - 星痕共鸣 DPS'
    });

    logWindow.loadFile('src/log-window.html');

    // 开发时打开开发者工具
    if (process.env.NODE_ENV === 'development') {
        logWindow.webContents.openDevTools();
    }

    logWindow.on('closed', () => {
        logWindow = null;
    });

    // 发送缓存的日志到日志窗口
    logWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            if (logWindow && logQueue.length > 0) {
                logQueue.forEach(log => {
                    logWindow.webContents.send('log-message', log.level, log.message);
                });
            }
        }, 500);
    });
}

// 创建悬浮窗
function createOverlayWindow() {
    if (overlayWindow) {
        overlayWindow.focus();
        return;
    }

    overlayWindow = new BrowserWindow({
        width: 320,
        height: 400,
        minWidth: 280,
        minHeight: 200,
        maxWidth: 500,
        maxHeight: 800,
        frame: false,
        transparent: true,
        alwaysOnTop: false,
        resizable: true,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: 'DPS悬浮窗'
    });

    // 设置为screen-saver级别的置顶
    overlayWindow.setAlwaysOnTop(true, "screen-saver");

    overlayWindow.loadFile('src/overlay-window.html');

    // 设置初始位置到屏幕右上角
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    overlayWindow.setPosition(width - 350, 50);

    // 开发时打开开发者工具
    if (process.env.NODE_ENV === 'development') {
        overlayWindow.webContents.openDevTools();
    }

    overlayWindow.on('closed', () => {
        overlayWindow = null;
        overlayEnabled = false;
        // 只有在不是主窗口关闭导致的情况下才保存配置
        if (!app.isMainWindowClosing) {
            updateConfig('overlayEnabled', false);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('overlay-status-changed', false);
        }
    });

    // 悬浮窗加载完成后发送初始数据
    overlayWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            // 发送当前玩家UID（如果有的话）
            if (user_uid && overlayWindow && overlayWindow.webContents) {
                overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                logger.info('Sending initial UID to overlay window: ' + user_uid.toString());
            } else {
                // 即使没有UID，也发送一个空值来触发悬浮窗的初始化
                if (overlayWindow && overlayWindow.webContents) {
                    overlayWindow.webContents.send('player-uid-updated', null);
                    logger.info('Sending null UID to overlay window for initialization');
                }
            }
            // 发送当前的"仅自己"模式状态
            if (overlayWindow && overlayWindow.webContents) {
                overlayWindow.webContents.send('self-only-mode-changed', selfOnlyMode);
                logger.info('Sending initial self-only mode to overlay window: ' + selfOnlyMode);
            }
            // 发送悬浮窗配置
            if (overlayWindow && overlayWindow.webContents) {
                overlayWindow.webContents.send('overlay-settings-updated', appConfig.overlaySettings);
                logger.info('Sending overlay settings to overlay window:', appConfig.overlaySettings);
            }
        }, 500);
    });

    overlayEnabled = true;
    if (mainWindow) {
        mainWindow.webContents.send('overlay-status-changed', true);
    }
}

// 创建DPS排行榜悬浮窗
function createRankingOverlayWindow() {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.focus();
        return;
    }

    rankingOverlayWindow = new BrowserWindow({
        width: 350,
        height: 145,
        frame: false,
        transparent: true,
        alwaysOnTop: false,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: 'DPS排行榜'
    });

    // 设置为screen-saver级别的置顶
    rankingOverlayWindow.setAlwaysOnTop(true, "screen-saver");

    rankingOverlayWindow.loadFile('src/dps-ranking-overlay.html');

    // 设置初始位置到屏幕左上角
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    rankingOverlayWindow.setPosition(50, 50);

    // 开发时打开开发者工具
    if (process.env.NODE_ENV === 'development') {
        rankingOverlayWindow.webContents.openDevTools();
    }

    rankingOverlayWindow.on('closed', () => {
        rankingOverlayWindow = null;
        rankingOverlayEnabled = false;
        // 只有在不是主窗口关闭导致的情况下才保存配置
        if (!app.isMainWindowClosing) {
            updateConfig('rankingOverlayEnabled', false);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ranking-overlay-status-changed', false);
        }
    });

    // 排行榜悬浮窗加载完成后发送初始数据
    rankingOverlayWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            // 发送当前统计数据
            if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
                const userData = {};
                Object.keys(total_damage).forEach(uid => {
                    if (total_damage[uid] && total_damage[uid].total > 0) {
                        userData[uid] = {
                            totalDamage: total_damage[uid].total,
                            skills: Array.from(player_skills[uid] || []),
                            realtimeDps: realtime_dps[uid] ? realtime_dps[uid].value : 0
                        };
                    }
                });
                rankingOverlayWindow.webContents.send('stats-updated', { users: userData });
                logger.info('Sending initial stats to ranking overlay window');
            }
            
            // 发送当前玩家UID（如果有的话）
            if (user_uid && rankingOverlayWindow && rankingOverlayWindow.webContents) {
                rankingOverlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                logger.info('Sending initial UID to ranking overlay window: ' + user_uid.toString());
            } else {
                // 即使没有UID，也发送一个空值来触发排行榜的初始化
                if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
                    rankingOverlayWindow.webContents.send('player-uid-updated', null);
                    logger.info('Sending null UID to ranking overlay window for initialization');
                }
            }
        }, 500);
    });

    rankingOverlayEnabled = true;
    if (mainWindow) {
        mainWindow.webContents.send('ranking-overlay-status-changed', true);
    }
}

// 获取设备列表
async function getDeviceList() {
    try {
        devices = cap.deviceList();
        const deviceList = devices.map((device, index) => ({
            index,
            name: device.name,
            description: device.description,
            addresses: device.addresses || []
        }));

        // 尝试自动选择默认网卡
        const findDefaultNetworkDevice = require('./algo/netInterfaceUtil');
        let recommendedIndex = null;
        
        try {
            // 构建设备对象，用于findDefaultNetworkDevice函数
            const deviceMap = {};
            devices.forEach((device, index) => {
                deviceMap[device.name] = {
                    addresses: device.addresses || []
                };
            });
            
            const defaultDeviceName = await findDefaultNetworkDevice(deviceMap);
            if (defaultDeviceName) {
                // 找到推荐设备的索引
                recommendedIndex = devices.findIndex(device => device.name === defaultDeviceName);
                if (recommendedIndex !== -1) {
                    logger.info(`自动推荐网络设备: ${devices[recommendedIndex].description} (索引: ${recommendedIndex})`);
                }
            }
        } catch (autoSelectError) {
            logger.warn('自动选择网卡失败:', autoSelectError);
        }

        return {
            devices: deviceList,
            recommendedIndex
        };
    } catch (error) {
        logger.error('获取设备列表失败:', error);
        return {
            devices: [],
            recommendedIndex: null
        };
    }
}

// 数据处理函数
function processPacket(buf) {
    // 如果不在抓包状态，直接返回
    if (!isCapturing) {
        return;
    }
    
    try {
        // 使用 PacketProcessor 处理数据包
        packetProcessor.processPacket(buf);
        
        // 检查 UID 是否发生变化
        if (packetProcessor.hasUserUidChanged()) {
            const newUid = packetProcessor.getCurrentUserUid();
            if (newUid && user_uid !== newUid) {
                user_uid = newUid;
                logger.info('Player UID obtained: ' + user_uid);
                
                // 通知渲染进程
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('player-uid-updated', user_uid.toString());
                    logger.info('Sending UID update to main window: ' + user_uid.toString());
                } else {
                    logger.warn('Main window not available for UID update');
                }
                
                // 通知悬浮窗（仅在悬浮窗已存在时）
                if (overlayWindow && overlayWindow.webContents) {
                    overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                    logger.info('Sending UID update to overlay window: ' + user_uid.toString());
                } else {
                    logger.debug('Overlay window not available for UID update, skipping...');
                }
                
                // 通知DPS排行榜悬浮窗
                if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
                    rankingOverlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                    logger.info('Sending UID update to ranking overlay window: ' + user_uid.toString());
                }
            }
        }
        
    } catch (e) {
        logger.debug('Error in processPacket:', e);
    }
}

// 清理TCP缓存
function clearTcpCache() {
    _data = Buffer.alloc(0);
    tcp_next_seq = -1;
    tcp_last_time = 0;
    tcp_cache.clear();
}

// IP分片处理函数
function getTCPPacket(frameBuffer, ethOffset) {
    const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
    const ipId = ipPacket.info.id;
    const isFragment = (ipPacket.info.flags & 0x1) !== 0;
    const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
    const now = Date.now();

    if (isFragment || ipPacket.info.fragoffset > 0) {
        if (!fragmentIpCache.has(_key)) {
            fragmentIpCache.set(_key, {
                fragments: [],
                timestamp: now
            });
        }

        const cacheEntry = fragmentIpCache.get(_key);
        const ipBuffer = Buffer.from(frameBuffer.subarray(ethOffset));
        cacheEntry.fragments.push(ipBuffer);
        cacheEntry.timestamp = now;

        // there's more fragment ip packet, wait for the rest
        if (isFragment) {
            return null;
        }

        // last fragment received, reassemble
        const fragments = cacheEntry.fragments;
        if (!fragments) {
            logger.error(`Can't find fragments for ${_key}`);
            return null;
        }

        // Reassemble fragments based on their offset
        let totalLength = 0;
        const fragmentData = [];

        // Collect fragment data with their offsets
        for (const buffer of fragments) {
            const ip = decoders.IPV4(buffer);
            const fragmentOffset = ip.info.fragoffset * 8;
            const payloadLength = ip.info.totallen - ip.hdrlen;
            const payload = Buffer.from(buffer.subarray(ip.offset, ip.offset + payloadLength));

            fragmentData.push({
                offset: fragmentOffset,
                payload: payload
            });

            const endOffset = fragmentOffset + payloadLength;
            if (endOffset > totalLength) {
                totalLength = endOffset;
            }
        }

        const fullPayload = Buffer.alloc(totalLength);
        for (const fragment of fragmentData) {
            fragment.payload.copy(fullPayload, fragment.offset);
        }

        fragmentIpCache.delete(_key);
        return fullPayload;
    }

    return Buffer.from(frameBuffer.subarray(ipPacket.offset, ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen)));
}

// 开始抓包
function startCapture(deviceIndex) {
    try {
        if (isCapturing) {
            stopCapture();
        }

        const device = devices[deviceIndex];
        if (!device) {
            throw new Error('Device not found');
        }

        selectedDevice = device;
        capInstance = new Cap();
        const filter = 'ip and tcp';
        const bufSize = 50 * 1024 * 1024; // 增加到50MB缓冲区
        const buffer = Buffer.alloc(65535);
        
        const linkType = capInstance.open(device.name, filter, bufSize, buffer);
        capInstance.setMinBytes && capInstance.setMinBytes(0);

        logger.info(`Starting packet capture on device: ${device.description}`);
        isCapturing = true;
        
        // 确保先停止之前的定时器，再启动新的定时器
        stopDataUpdateTimers();
        startDataUpdateTimers();
        
        // 启动TCP缓存清理定时器
        startTcpCleanupTimer();

        // 通知主窗口状态更新
        if (mainWindow) {
            mainWindow.webContents.send('capture-status-changed', {
                isCapturing: true,
                selectedDevice: device.description
            });
        }

        capInstance.on('packet', async function (nbytes, trunc) {
            // 性能监控
            packet_count++;
            const now = Date.now();
            if (last_packet_time === 0) {
                last_packet_time = now;
            } else if (now - last_packet_time > 5000) { // 每5秒检查一次
                const pps = packet_count / ((now - last_packet_time) / 1000);
                if (pps > 1000 && performance_warnings < 5) { // 每秒超过1000包时警告
                    logger.warn(`高流量检测: ${pps.toFixed(0)} 包/秒, TCP缓存: ${tcp_cache.size}`);
                    performance_warnings++;
                }
                packet_count = 0;
                last_packet_time = now;
            }
            
            const buffer1 = Buffer.from(buffer);
            
            if (linkType === 'ETHERNET') {
                var ret = decoders.Ethernet(buffer1);
                
                if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
                    const ipPacket = decoders.IPV4(buffer1, ret.offset);
                    const srcaddr = ipPacket.info.srcaddr;
                    const dstaddr = ipPacket.info.dstaddr;
                    
                    if (ipPacket.info.protocol === PROTOCOL.IP.TCP) {
                        const tcpBuffer = getTCPPacket(buffer1, ret.offset);
                        if (tcpBuffer === null) return; // IP分片未完成，等待更多分片
                        
                        const tcpPacket = decoders.TCP(tcpBuffer);
                        const srcport = tcpPacket.info.srcport;
                        const dstport = tcpPacket.info.dstport;
                        const src_server = `${srcaddr}:${srcport} -> ${dstaddr}:${dstport}`;
                        
                        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));
                        
                        // TCP超时检查已移至定时器中处理
                        
                        if (current_server !== src_server) {
                            try {
                                // 尝试通过小包识别服务器
                                if (buf[4] == 0) {
                                    const data = buf.subarray(10);
                                    if (data.length) {
                                        const stream = Readable.from(data, { objectMode: false });
                                        let data1;
                                        
                                        do {
                                            const len_buf = stream.read(4);
                                            if (!len_buf) break;
                                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                                            
                                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); //c3SB??
                                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                                            
                                            try {
                                                if (current_server !== src_server) {
                                                    current_server = src_server;
                                                    clearTcpCache();
                                                    tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                                    logger.info('Got Scene Server Address: ' + src_server);
                                                }
                                            } catch (e) { }
                                        } while (data1 && data1.length);
                                    }
                                }
                                
                                // 尝试通过登录返回包识别服务器(仍需测试)
                                if (buf.length === 0x62) {
                                    // prettier-ignore
                                    const signature = Buffer.from([
                                        0x00, 0x00, 0x00, 0x62,
                                        0x00, 0x03,
                                        0x00, 0x00, 0x00, 0x01,
                                        0x00, 0x11, 0x45, 0x14,//seq?
                                        0x00, 0x00, 0x00, 0x00,
                                        0x0a, 0x4e, 0x08, 0x01, 0x22, 0x24
                                    ]);
                                    if (Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0) {
                                        if (current_server !== src_server) {
                                            current_server = src_server;
                                            clearTcpCache();
                                            tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                            logger.info('Got Scene Server Address by Login Return Packet: ' + src_server);
                                        }
                                    }
                                }
                                
                                // 尝试解析protobuf获取UID（保留原有逻辑）
                                if (buf[4] == 0) {
                                    const data = buf.subarray(10);
                                    if (data.length) {
                                        const stream = Readable.from(data, { objectMode: false });
                                        let data1;
                                        
                                        do {
                                            const len_buf = stream.read(4);
                                            if (!len_buf) break;
                                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                                            
                                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]);
                                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                                            
                                            try {
                                                let body = pb.decode(data1.subarray(18)) || {};
                                                
                                                if (data1[17] === 0x2e) {
                                                    body = body[1];
                                                    if (body[5]) {
                                                        const uid = BigInt(body[5]) >> 16n;
                                                        if (user_uid !== uid) {
                                                            user_uid = uid;
                                                            logger.info('Player UID obtained: ' + user_uid);
                                                            // 通知渲染进程
                                                            if (mainWindow && mainWindow.webContents) {
                                                                mainWindow.webContents.send('player-uid-updated', user_uid.toString());
                                                                logger.info('Sending UID update to main window: ' + user_uid.toString());
                                                            } else {
                                                                logger.warn('Main window not available for UID update');
                                                            }
                                                            // 通知悬浮窗
                                            if (overlayWindow && overlayWindow.webContents) {
                                                overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                                                logger.info('Sending UID update to overlay window: ' + user_uid.toString());
                                            } else {
                                                logger.warn('Overlay window not available for UID update');
                                            }
                                            // 通知DPS排行榜悬浮窗
                                            if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
                                                rankingOverlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                                                logger.info('Sending UID update to ranking overlay window: ' + user_uid.toString());
                                            }
                                                        }
                                                    }
                                                }
                                            } catch (e) {
                                                // 忽略解析错误
                                            }
                                        } while (data1 && data1.length);
                                    }
                                }
                            } catch (e) {
                                // 忽略识别错误
                            }
                            return;
                        }
                        
                        // TCP包重组处理 - 按顺序单线程处理
                        try {
                            // 如果不在抓包状态，直接返回
                            if (!isCapturing) {
                                return;
                            }
                            
                            if (tcp_next_seq === -1) {
                                logger.error("Unexpected TCP capture error! tcp_next_seq is -1");
                                if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                                    tcp_next_seq = tcpPacket.info.seqno;
                                }
                            }
                            
                            // 只缓存有效的包（按顺序或tcp_next_seq为-1时）
                            // 正确处理32位无符号整数的序列号比较
                            const seqDiff = (tcpPacket.info.seqno - tcp_next_seq) >>> 0;
                            if (tcp_next_seq === -1 || seqDiff < 0x80000000) {
                                tcp_cache.set(tcpPacket.info.seqno, buf);
                            }
                            
                            // 防止缓存过大导致内存溢出
                            if (tcp_cache.size > 40000) {
                                logger.warn(`TCP缓存过大 (${tcp_cache.size})，清理旧数据`);
                                const keys = Array.from(tcp_cache.keys()).sort((a, b) => a - b);
                                const toDelete = keys.slice(0, tcp_cache.size - 30000);
                                for (const key of toDelete) {
                                    tcp_cache.delete(key);
                                }
                            }
                            
                            // 按顺序重组TCP包
                            while (tcp_cache.has(tcp_next_seq)) {
                                const seq = tcp_next_seq;
                                const cachedTcpData = tcp_cache.get(seq);
                                _data = _data.length === 0 ? cachedTcpData : Buffer.concat([_data, cachedTcpData]);
                                tcp_next_seq = (seq + cachedTcpData.length) >>> 0; // uint32
                                tcp_cache.delete(seq);
                                tcp_last_time = Date.now();
                            }
                            
                            // 处理完整的数据包
                            while (_data.length >= 4) {
                                // 先peek包大小，不消耗字节
                                let packetSize = _data.readUInt32BE(0);
                                
                                // 检查包大小是否合理
                                if (packetSize > 0x0fffff || packetSize < 4) {
                                    logger.error(`无效包大小!! ${_data.length},${packetSize}，重置TCP状态`);
                                    clearTcpCache();
                                    break;
                                }
                                
                                // 检查是否有完整的包
                                if (_data.length < packetSize) break;
                                
                                // 提取完整的包并处理
                                const packet = _data.subarray(0, packetSize);
                                _data = _data.subarray(packetSize);
                                // 同步处理数据包
                                processPacket(packet);
                            }
                            
                        } catch (error) {
                            logger.error('TCP包处理错误:', error);
                        }
                    }
                }
            }
        });

        return true;
    } catch (error) {
        logger.error('开始抓包失败:', error);
        isCapturing = false;
        return false;
    }
}

// 停止抓包
function stopCapture() {
    isCapturing = false;
    
    // 关闭Cap实例
    if (capInstance) {
        try {
            capInstance.close();
            capInstance = null;
            logger.info('Cap instance closed successfully');
        } catch (error) {
            logger.error('Error closing cap instance:', error);
            capInstance = null;
        }
    }
    
    // 停止数据更新定时器
    stopDataUpdateTimers();
    
    clearTcpCache();
    current_server = '';
    logger.info('Packet capture stopped');
    
    // 通知主窗口状态更新
    if (mainWindow) {
        mainWindow.webContents.send('capture-status-changed', {
            isCapturing: false,
            selectedDevice: null
        });
    }
}

// 清除统计数据
function clearStats() {
    total_damage = {};
    total_count = {};
    total_healing = {};
    healing_count = {};
    dps_window = {};
    hps_window = {};
    damage_time = {};
    healing_time = {};
    realtime_dps = {};
    realtime_hps = {};
    player_skills = {};
    skill_damage_stats = {};
    skill_healing_stats = {};
    skill_count_stats = {};
    
    // 立即发送空数据到渲染进程，清除界面显示
    const emptyData = {};
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('stats-updated', emptyData);
    }
    if (overlayWindow && overlayWindow.webContents) {
        overlayWindow.webContents.send('stats-updated', emptyData);
    }
    // 向DPS排行榜悬浮窗发送清空事件
    if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
        rankingOverlayWindow.webContents.send('stats-cleared');
    }
    
    logger.info('Statistics data cleared (including damage and healing data)');
}

// 启动数据更新和清理定时器
function startDataUpdateTimers() {
    // 计算实时DPS和HPS
    statsUpdateInterval = setInterval(() => {
        const now = Date.now();
        
        // 只有在抓包状态下才计算实时DPS和HPS
        if (isCapturing) {
            // 获取所有有伤害数据的用户ID
            const allDpsUids = new Set([...Object.keys(dps_window), ...Object.keys(realtime_dps)]);
            
            // 计算实时DPS
            for (const uid of allDpsUids) {
                // 清理过期数据
                if (dps_window[uid]) {
                    while (dps_window[uid].length > 0 && dps_window[uid][0] && dps_window[uid][0].time && now - dps_window[uid][0].time > 1000) {
                        dps_window[uid].shift();
                    }
                }
                
                if (!realtime_dps[uid]) {
                    realtime_dps[uid] = {
                        value: 0,
                        max: 0,
                    };
                }
                
                // 计算当前实时DPS
                realtime_dps[uid].value = 0;
                if (dps_window[uid] && dps_window[uid].length > 0) {
                    for (const b of dps_window[uid]) {
                        realtime_dps[uid].value += b.damage;
                    }
                }
                
                // 更新峰值
                if (realtime_dps[uid].value > realtime_dps[uid].max) {
                    realtime_dps[uid].max = realtime_dps[uid].value;
                }
            }
            
            // 获取所有有治疗数据的用户ID
            const allHpsUids = new Set([...Object.keys(hps_window), ...Object.keys(realtime_hps)]);
            
            // 计算实时HPS
            for (const uid of allHpsUids) {
                // 清理过期数据
                if (hps_window[uid]) {
                    while (hps_window[uid].length > 0 && hps_window[uid][0] && hps_window[uid][0].time && now - hps_window[uid][0].time > 1000) {
                        hps_window[uid].shift();
                    }
                }
                
                if (!realtime_hps[uid]) {
                    realtime_hps[uid] = {
                        value: 0,
                        max: 0,
                    };
                }
                
                // 计算当前实时HPS
                realtime_hps[uid].value = 0;
                if (hps_window[uid] && hps_window[uid].length > 0) {
                    for (const h of hps_window[uid]) {
                        realtime_hps[uid].value += h.healing;
                    }
                }
                
                // 更新峰值
                if (realtime_hps[uid].value > realtime_hps[uid].max) {
                    realtime_hps[uid].max = realtime_hps[uid].value;
                }
            }
        }
        
        // 发送数据到渲染进程（无论是否在抓包都发送）
        const userData = {};
        
        // 合并所有用户ID（伤害和治疗）
        const allUids = new Set([...Object.keys(total_damage), ...Object.keys(total_healing)]);
        
        for (const uid of allUids) {
            if (!userData[uid]) {
                userData[uid] = {
                    realtime_dps: 0,
                    realtime_dps_max: 0,
                    total_dps: 0,
                    realtime_hps: 0,
                    realtime_hps_max: 0,
                    total_hps: 0,
                    total_damage: {
                        normal: 0,
                        critical: 0,
                        lucky: 0,
                        crit_lucky: 0,
                        hpLessen: 0,
                        total: 0,
                    },
                    total_count: {
                        normal: 0,
                        critical: 0,
                        lucky: 0,
                        total: 0,
                    },
                    total_healing: {
                        normal: 0,
                        critical: 0,
                        lucky: 0,
                        crit_lucky: 0,
                        total: 0,
                    },
                    healing_count: {
                        normal: 0,
                        critical: 0,
                        lucky: 0,
                        total: 0,
                    },
                };
            }
            
            // 伤害数据
            if (total_damage[uid]) {
                userData[uid].total_damage = total_damage[uid];
                userData[uid].total_count = total_count[uid] || {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                };
                
                // 修复总DPS计算，使用整个战斗时间
                if (damage_time[uid] && damage_time[uid].length >= 2) {
                    const firstTime = damage_time[uid][0];
                    const lastTime = damage_time[uid][damage_time[uid].length - 1];
                    const timeDiff = lastTime - firstTime;
                    if (timeDiff >= 1000) { // 至少1秒的时间差
                        userData[uid].total_dps = (total_damage[uid].total / timeDiff * 1000) || 0;
                    } else {
                        userData[uid].total_dps = 0;
                    }
                } else {
                    userData[uid].total_dps = 0;
                }
                
                userData[uid].realtime_dps = realtime_dps[uid] ? realtime_dps[uid].value : 0;
                userData[uid].realtime_dps_max = realtime_dps[uid] ? realtime_dps[uid].max : 0;
                userData[uid].damage_time = damage_time[uid] || [];
            }
            
            // 治疗数据
            if (total_healing[uid]) {
                userData[uid].total_healing = total_healing[uid];
                userData[uid].healing_count = healing_count[uid] || {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                };
                
                // 计算总HPS，使用整个治疗时间
                if (healing_time[uid] && healing_time[uid].length >= 2) {
                    const firstTime = healing_time[uid][0];
                    const lastTime = healing_time[uid][healing_time[uid].length - 1];
                    const timeDiff = lastTime - firstTime;
                    if (timeDiff >= 1000) { // 至少1秒的时间差
                        userData[uid].total_hps = (total_healing[uid].total / timeDiff * 1000) || 0;
                    } else {
                        userData[uid].total_hps = 0;
                    }
                } else {
                    userData[uid].total_hps = 0;
                }
                
                userData[uid].realtime_hps = realtime_hps[uid] ? realtime_hps[uid].value : 0;
                userData[uid].realtime_hps_max = realtime_hps[uid] ? realtime_hps[uid].max : 0;
            }
            
            // 添加技能信息（用于职业识别）
            if (player_skills[uid]) {
                userData[uid].skills = Array.from(player_skills[uid]);
            } else {
                userData[uid].skills = [];
            }
            
            // 添加技能统计数据
            userData[uid].skill_damage_stats = skill_damage_stats[uid] || {};
            userData[uid].skill_healing_stats = skill_healing_stats[uid] || {};
            userData[uid].skill_count_stats = skill_count_stats[uid] || {};
            
            // 添加用户数据信息
            userData[uid].playerName = UserDataManager.getName(uid);
            userData[uid].playerFightPoint = UserDataManager.getFightPoint(uid);
            userData[uid].professionId = UserDataManager.getProfessionId(uid);
            userData[uid].displayName = UserDataManager.getDisplayName(uid);
        }
        
        // 发送到主窗口
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('stats-updated', userData);
        }
        
        // 发送到悬浮窗
        if (overlayWindow && overlayWindow.webContents) {
            let overlayData = userData;
            // 如果悬浮窗处于"仅自己"模式，只发送当前玩家的数据
            if (selfOnlyMode && user_uid) {
                const currentUid = user_uid.toString();
                overlayData = userData[currentUid] ? { [currentUid]: userData[currentUid] } : {};
            }
            overlayWindow.webContents.send('stats-updated', overlayData);
        }
        
        // 发送数据到DPS排行榜悬浮窗
        if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
            const rankingData = {};
            Object.keys(total_damage).forEach(uid => {
                if (total_damage[uid] && total_damage[uid].total > 0) {
                    rankingData[uid] = {
                        totalDamage: total_damage[uid].total,
                        skills: Array.from(player_skills[uid] || []),
                        // 添加实时DPS
                        realtimeDps: realtime_dps[uid] ? realtime_dps[uid].value : 0,
                        // 添加用户数据信息
                        playerName: UserDataManager.getName(uid),
                        playerFightPoint: UserDataManager.getFightPoint(uid),
                        professionId: UserDataManager.getProfessionId(uid),
                        displayName: UserDataManager.getDisplayName(uid)
                    };
                }
            });
            rankingOverlayWindow.webContents.send('stats-updated', { users: rankingData });
        }
    }, 100);

    // 内存清理定时器 - 每30秒清理一次过期数据
    dataCleanupInterval = setInterval(() => {
        const now = Date.now();
        const maxAge = 300000; // 5分钟

        // 清理过期的DPS窗口数据
        for (const uid of Object.keys(dps_window)) {
            if (dps_window[uid]) {
                dps_window[uid] = dps_window[uid].filter(item => item && item.time && now - item.time <= maxAge);
                if (dps_window[uid].length === 0) {
                    delete dps_window[uid];
                }
            }
        }
        
        // 清理过期的HPS窗口数据
        for (const uid of Object.keys(hps_window)) {
            if (hps_window[uid]) {
                hps_window[uid] = hps_window[uid].filter(item => item && item.time && now - item.time <= maxAge);
                if (hps_window[uid].length === 0) {
                    delete hps_window[uid];
                }
            }
        }

        // 清理TCP缓存中的过期数据
        for (const [key, value] of tcp_cache) {
            if (value && value.time && now - value.time > maxAge) {
                tcp_cache.delete(key);
            }
        }

        // 限制TCP缓存大小
        if (tcp_cache.size > 40000) { // 增加TCP缓存限制到40000
            const keys = Array.from(tcp_cache.keys());
            const toDelete = keys.slice(0, tcp_cache.size - 30000);
            for (const key of toDelete) {
                tcp_cache.delete(key);
            }
        }

        // 清理日志缓存
        if (logQueue.length > 50) {
            logQueue = logQueue.slice(-50);
        }

        logger.debug(`Memory cleanup completed - DPS windows: ${Object.keys(dps_window).length}, HPS windows: ${Object.keys(hps_window).length}, TCP cache: ${tcp_cache.size}, Log cache: ${logQueue.length}`);
    }, 60000); // 增加清理间隔到60秒，减少性能开销
}

// 停止所有定时器
function stopDataUpdateTimers() {
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
        statsUpdateInterval = null;
    }
    if (dataCleanupInterval) {
        clearInterval(dataCleanupInterval);
        dataCleanupInterval = null;
    }
    if (tcpCleanupInterval) {
        clearInterval(tcpCleanupInterval);
        tcpCleanupInterval = null;
    }
}

// TCP缓存清理定时器
function startTcpCleanupTimer() {
    // 停止之前的定时器
    if (tcpCleanupInterval) {
        clearInterval(tcpCleanupInterval);
    }
    
    // 每10秒检查一次TCP连接状态和清理过期缓存
    tcpCleanupInterval = setInterval(() => {
        const now = Date.now();
        const TIMEOUT = 30000; // 30秒超时
        
        // 清理过期的IP分片缓存
        for (const [key, fragment] of fragmentIpCache.entries()) {
            if (now - fragment.timestamp > FRAGMENT_TIMEOUT) {
                fragmentIpCache.delete(key);
            }
        }
        
        if (tcp_last_time && now - tcp_last_time > TIMEOUT) {
            logger.warn('无法捕获下一个包! 游戏是否关闭或断线? seq: ' + tcp_next_seq);
            current_server = '';
            clearTcpCache();
        }
    }, 10000);
}

// IPC事件处理
ipcMain.handle('get-devices', async () => {
    return await getDeviceList();
});

ipcMain.handle('start-capture', (event, deviceIndex) => {
    return startCapture(deviceIndex);
});

ipcMain.handle('stop-capture', () => {
    stopCapture();
    return true;
});

ipcMain.handle('clear-stats', () => {
    clearStats();
    return true;
});

ipcMain.handle('get-capture-status', () => {
    return {
        isCapturing,
        selectedDevice: selectedDevice ? selectedDevice.description : null,
        userUid: user_uid ? user_uid.toString() : null
    };
});



// 窗口控制IPC事件
ipcMain.handle('window-minimize', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.handle('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.handle('window-close', () => {
    if (mainWindow) {
        // 设置标志表示是主窗口退出导致的关闭
        app.isMainWindowClosing = true;
        // 主动关闭悬浮窗，但不保存配置
        if (overlayWindow) {
            overlayWindow.close();
        }
        if (rankingOverlayWindow) {
            rankingOverlayWindow.close();
        }
        mainWindow.close();
    }
});

// 日志窗口控制
ipcMain.handle('show-log-window', () => {
    createLogWindow();
});

ipcMain.handle('close-log-window', () => {
    if (logWindow) {
        logWindow.close();
    }
});

// 悬浮窗控制
ipcMain.handle('toggle-overlay', () => {
    if (overlayWindow) {
        overlayWindow.close();
        return false;
    } else {
        createOverlayWindow();
        updateConfig('overlayEnabled', true);
        return true;
    }
});

// DPS排行榜悬浮窗控制
ipcMain.handle('toggle-ranking-overlay', () => {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.close();
        return false;
    } else {
        createRankingOverlayWindow();
        updateConfig('rankingOverlayEnabled', true);
        return true;
    }
});

ipcMain.handle('ranking-overlay-close', () => {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.close();
    }
});

ipcMain.handle('ranking-overlay-set-always-on-top', (event, alwaysOnTop) => {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.setAlwaysOnTop(alwaysOnTop, "screen-saver");
    }
});

ipcMain.handle('ranking-overlay-set-ignore-mouse-events', (event, ignore) => {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
});

ipcMain.handle('overlay-minimize', () => {
    if (overlayWindow) {
        overlayWindow.minimize();
    }
});

ipcMain.handle('overlay-close', () => {
    if (overlayWindow) {
        overlayWindow.close();
    }
});

ipcMain.handle('overlay-set-always-on-top', (event, alwaysOnTop) => {
    if (overlayWindow) {
        overlayWindow.setAlwaysOnTop(alwaysOnTop, "screen-saver");
    }
});

ipcMain.handle('overlay-resize', (event, { width, height }) => {
    if (overlayWindow) {
        overlayWindow.setSize(width, height);
    }
});

ipcMain.handle('ranking-overlay-resize', (event, { width, height }) => {
    if (rankingOverlayWindow) {
        rankingOverlayWindow.setSize(width, height);
    }
});

ipcMain.handle('get-stats-data', () => {
    const userData = {};
    
    // 获取所有有数据的UID（伤害或治疗）
    let allUids = new Set([...Object.keys(total_damage), ...Object.keys(total_healing)]);
    
    // 如果启用了"仅自己"模式，只返回当前玩家的数据
    if (selfOnlyMode && user_uid) {
        const userUidStr = user_uid.toString();
        allUids = new Set(Array.from(allUids).filter(uid => uid === userUidStr));
    }
    
    for (const uid of allUids) {
        if (!userData[uid]) {
            userData[uid] = {
                realtime_dps: 0,
                realtime_dps_max: 0,
                total_dps: 0,
                realtime_hps: 0,
                realtime_hps_max: 0,
                total_hps: 0,
                total_damage: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    crit_lucky: 0,
                    hpLessen: 0,
                    total: 0,
                },
                total_count: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                },
                total_healing: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                },
                healing_count: {
                    normal: 0,
                    critical: 0,
                    lucky: 0,
                    total: 0,
                },
            };
        }
        
        // 伤害数据
        if (total_damage[uid]) {
            userData[uid].total_damage = total_damage[uid];
            userData[uid].total_count = total_count[uid] || {
                normal: 0,
                critical: 0,
                lucky: 0,
                total: 0,
            };
            
            // 修复总DPS计算，使用整个战斗时间
            if (damage_time[uid] && damage_time[uid].length >= 2) {
                const firstTime = damage_time[uid][0];
                const lastTime = damage_time[uid][damage_time[uid].length - 1];
                const timeDiff = lastTime - firstTime;
                if (timeDiff > 0) {
                    userData[uid].total_dps = (total_damage[uid].total / timeDiff * 1000) || 0;
                } else {
                    userData[uid].total_dps = 0;
                }
            } else {
                userData[uid].total_dps = 0;
            }
            
            userData[uid].realtime_dps = realtime_dps[uid] ? realtime_dps[uid].value : 0;
            userData[uid].realtime_dps_max = realtime_dps[uid] ? realtime_dps[uid].max : 0;
            userData[uid].damage_time = damage_time[uid] || [];
        }
        
        // 治疗数据
        if (total_healing[uid]) {
            userData[uid].total_healing = total_healing[uid];
            userData[uid].healing_count = healing_count[uid] || {
                normal: 0,
                critical: 0,
                lucky: 0,
                total: 0,
            };
            
            // 计算总HPS，使用整个治疗时间
            if (healing_time[uid] && healing_time[uid].length >= 2) {
                const firstTime = healing_time[uid][0];
                const lastTime = healing_time[uid][healing_time[uid].length - 1];
                const timeDiff = lastTime - firstTime;
                if (timeDiff > 0) {
                    userData[uid].total_hps = (total_healing[uid].total / timeDiff * 1000) || 0;
                } else {
                    userData[uid].total_hps = 0;
                }
            } else {
                userData[uid].total_hps = 0;
            }
            
            userData[uid].realtime_hps = realtime_hps[uid] ? realtime_hps[uid].value : 0;
            userData[uid].realtime_hps_max = realtime_hps[uid] ? realtime_hps[uid].max : 0;
        }
        
        // 添加技能信息（用于职业识别）
        if (player_skills[uid]) {
            userData[uid].skills = Array.from(player_skills[uid]);
        } else {
            userData[uid].skills = [];
        }
        
        // 添加按技能ID统计的详细数据
        if (skill_damage_stats[uid]) {
            userData[uid].skill_damage_stats = skill_damage_stats[uid];
        } else {
            userData[uid].skill_damage_stats = {};
        }
        
        if (skill_healing_stats[uid]) {
            userData[uid].skill_healing_stats = skill_healing_stats[uid];
        } else {
            userData[uid].skill_healing_stats = {};
        }
        
        if (skill_count_stats[uid]) {
            userData[uid].skill_count_stats = skill_count_stats[uid];
        } else {
            userData[uid].skill_count_stats = {};
        }
    }
    
    return userData;
});

ipcMain.handle('get-overlay-status', () => {
    return overlayEnabled;
});

ipcMain.handle('get-ranking-overlay-status', () => {
    return rankingOverlayEnabled;
});

// 悬浮窗设置管理
ipcMain.handle('save-overlay-settings', (event, settings) => {
    appConfig.overlaySettings = { ...appConfig.overlaySettings, ...settings };
    saveConfig();
    logger.info('Overlay settings saved:', appConfig.overlaySettings);
    return true;
});

ipcMain.handle('get-overlay-settings', () => {
    return appConfig.overlaySettings;
});

ipcMain.handle('get-player-uid', () => {
    return user_uid ? user_uid.toString() : null;
});

ipcMain.handle('get-self-only-mode', () => {
    return selfOnlyMode;
});

ipcMain.handle('toggle-self-only-mode', (event, enabled) => {
    selfOnlyMode = enabled;
    // 保存配置到文件
    updateConfig('selfOnlyMode', enabled);
    // 通知悬浮窗切换模式
    if (overlayWindow && overlayWindow.webContents) {
        overlayWindow.webContents.send('self-only-mode-changed', enabled);
    }
    logger.info(`Self-only mode ${enabled ? 'enabled' : 'disabled'}`);
    return enabled;
});

// 用户数据管理相关的IPC处理程序
ipcMain.handle('get-user-data', (event, uid) => {
    return {
        name: UserDataManager.getName(uid),
        fightPoint: UserDataManager.getFightPoint(uid),
        playerFightPoint: UserDataManager.getFightPoint(uid),
        professionId: UserDataManager.getProfessionId(uid),
        displayName: UserDataManager.getDisplayName(uid)
    };
});

ipcMain.handle('get-all-user-data', () => {
    return UserDataManager.getAllUserData();
});

// 应用事件
app.whenReady().then(() => {
    // 加载配置文件
    loadConfig();
    
    createWindow();
    
    // 注册全局快捷键
    try {
        // F10: 清空数据
        globalShortcut.register('F10', () => {
            logger.info('F10 pressed - clearing stats data');
            clearStats();
            // 通知所有窗口数据已清空
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('stats-cleared');
            }
            if (overlayWindow && overlayWindow.webContents) {
                overlayWindow.webContents.send('stats-cleared');
            }
            if (rankingOverlayWindow && rankingOverlayWindow.webContents) {
                rankingOverlayWindow.webContents.send('stats-cleared');
            }
        });
        
        // F11: 切换只看自己/看全队模式
        globalShortcut.register('F11', () => {
            selfOnlyMode = !selfOnlyMode;
            updateConfig('selfOnlyMode', selfOnlyMode);
            logger.info(`F11 pressed - toggled self-only mode to: ${selfOnlyMode}`);
            // 通知所有窗口模式已切换
            if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('self-only-mode-changed', selfOnlyMode);
            }
            if (overlayWindow && overlayWindow.webContents) {
                overlayWindow.webContents.send('self-only-mode-changed', selfOnlyMode);
            }
        });
        
        // Ctrl+F12: 打开开发者工具
        globalShortcut.register('CommandOrControl+F12', () => {
            logger.info('Ctrl+F12 pressed - opening dev tools');
            // 获取当前焦点窗口并打开开发者工具
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow && focusedWindow.webContents) {
                if (focusedWindow.webContents.isDevToolsOpened()) {
                    focusedWindow.webContents.closeDevTools();
                    logger.info('Dev tools closed');
                } else {
                    focusedWindow.webContents.openDevTools();
                    logger.info('Dev tools opened');
                }
            } else if (mainWindow && mainWindow.webContents) {
                // 如果没有焦点窗口，默认打开主窗口的开发者工具
                if (mainWindow.webContents.isDevToolsOpened()) {
                    mainWindow.webContents.closeDevTools();
                    logger.info('Main window dev tools closed');
                } else {
                    mainWindow.webContents.openDevTools();
                    logger.info('Main window dev tools opened');
                }
            }
        });
        
        logger.info('Global shortcuts registered: F10 (clear data), F11 (toggle self-only mode), Ctrl+F12 (toggle dev tools)');
    } catch (error) {
        logger.error('Failed to register global shortcuts:', error);
    }
    
    // 根据配置决定是否创建DPS监控悬浮窗
    if (appConfig.overlayEnabled) {
        setTimeout(() => {
            try {
                createOverlayWindow();
                logger.info('Auto-created overlay window on startup based on config');
                // 如果已经有UID，立即发送给悬浮窗
                if (user_uid && overlayWindow && overlayWindow.webContents) {
                    setTimeout(() => {
                        overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                        logger.info('Sending existing UID to auto-created overlay window: ' + user_uid.toString());
                    }, 500);
                }
            } catch (error) {
                logger.error('Failed to auto-create overlay window:', error);
            }
        }, 1000);
    }
    
    // 根据配置决定是否创建DPS排行榜悬浮窗
    if (appConfig.rankingOverlayEnabled) {
        setTimeout(() => {
            try {
                createRankingOverlayWindow();
                logger.info('Auto-created ranking overlay window on startup based on config');
            } catch (error) {
                logger.error('Failed to auto-create ranking overlay window:', error);
            }
        }, 1500);
    }
    
    // 从配置中恢复自己模式状态
    selfOnlyMode = appConfig.selfOnlyMode;
    logger.info('Restored self-only mode from config:', selfOnlyMode);
    // 不在应用启动时自动启动定时器，而是在开始抓包时启动
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (isCapturing) {
            stopCapture();
        }
        stopDataUpdateTimers();
        // 注销全局快捷键
        globalShortcut.unregisterAll();
        app.quit();
    }
});

app.on('before-quit', () => {
    // 应用程序即将退出，重置标志
    app.isMainWindowClosing = false;
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// 错误处理
process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝:', reason);
});