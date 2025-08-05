const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const cap = require('cap');
const winston = require("winston");
const zlib = require('zlib');
const pb = require('./algo/pb');
const { Readable } = require("stream");

const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;

// 全局变量
let mainWindow;
let logWindow;
let overlayWindow;
let devices = [];
let isCapturing = false;
let selectedDevice = null;
let overlayEnabled = false;
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

// 网络包处理变量
let user_uid;
let current_server = '';
let _data = Buffer.alloc(0);
let tcp_next_seq = -1;
let tcp_cache = {};
let tcp_cache_size = 0;
let tcp_last_time = 0;

// 日志缓存队列，用于在mainWindow创建前缓存日志
let logQueue = [];

// 内存优化变量
let dataCleanupInterval;
let statsUpdateInterval;

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
    level: 'info',
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

// Lock类用于TCP包处理同步
class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }

    async acquire() {
        if (this.locked) {
            return new Promise((resolve) => this.queue.push(resolve));
        }
        this.locked = true;
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

const tcp_lock = new Lock();

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
        alwaysOnTop: true,
        resizable: true,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        title: 'DPS悬浮窗'
    });

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
        if (mainWindow) {
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
        }, 500);
    });

    overlayEnabled = true;
    if (mainWindow) {
        mainWindow.webContents.send('overlay-status-changed', true);
    }
}



// 获取设备列表
function getDeviceList() {
    try {
        devices = cap.deviceList();
        return devices.map((device, index) => ({
            index,
            name: device.name,
            description: device.description
        }));
    } catch (error) {
        logger.error('获取设备列表失败:', error);
        return [];
    }
}

// 数据处理函数
function processPacket(buf) {
    try {
        if (buf.length < 32) return;
        
        if (buf[4] & 0x80) { // zstd压缩
            if (!zlib.zstdDecompressSync) {
                logger.warn('zstdDecompressSync不可用! 请检查Node.js版本!');
                return;
            }
            const decompressed = zlib.zstdDecompressSync(buf.subarray(10));
            buf = Buffer.concat([buf.subarray(0, 10), decompressed]);
        }

        const data = buf.subarray(10);
        if (data.length) {
            const stream = Readable.from(data, { objectMode: false });
            let data1;
            
            do {
                const len_buf = stream.read(4);
                if (!len_buf) break;
                data1 = stream.read(len_buf.readUInt32BE() - 4);
                
                try {
                    let body = pb.decode(data1.subarray(18)) || {};
                    
                    if (data1[17] === 0x2e) {
                        body = body[1];
                        if (body[5]) {
                            // 玩家UID
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
                                logger.info('Checking overlay window status: overlayWindow=' + !!overlayWindow + ', webContents=' + !!(overlayWindow && overlayWindow.webContents));
                                if (overlayWindow && overlayWindow.webContents) {
                                    overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                                    logger.info('Sending UID update to overlay window: ' + user_uid.toString());
                                } else {
                                    logger.warn('Overlay window not available for UID update, overlayWindow=' + !!overlayWindow + ', webContents=' + !!(overlayWindow && overlayWindow.webContents));
                                    logger.warn('Creating overlay window...');
                                    // 如果悬浮窗不存在，自动创建悬浮窗
                                    createOverlayWindow();
                                    // 等待悬浮窗加载完成后再发送UID
                                    setTimeout(() => {
                                        if (overlayWindow && overlayWindow.webContents) {
                                            overlayWindow.webContents.send('player-uid-updated', user_uid.toString());
                                            logger.info('Sending UID update to newly created overlay window: ' + user_uid.toString());
                                        } else {
                                            logger.error('Failed to create overlay window or webContents not ready');
                                        }
                                    }, 1000);
                                }
                            } else {
                                logger.debug('UID unchanged, current UID: ' + user_uid);
                            }
                        }
                    }

                    let body1 = body[1];
                    if (body1) {
                        if (!Array.isArray(body1)) body1 = [body1];
                        
                        for (const b of body1) {
                            if (b[7] && b[7][2]) {
                                logger.debug(b.toBase64());
                                const hits = Array.isArray(b[7][2]) ? b[7][2] : [b[7][2]];
                                
                                for (const hit of hits) {
                                    const skill = hit[12];
                                    if (typeof skill !== 'number') break;
                                    
                                    const value = hit[6];
                                    const luckyValue = hit[8];
                                    const isMiss = hit[2];
                                    const isCrit = hit[5];
                                    const hpLessenValue = hit[9] ?? 0;
                                    const rawValue = value ?? luckyValue;
                                    
                                    //看起来HealFlag不为undefined时即为治疗
                                    const damageType = hit[1];     // 可能的伤害类型
                                    const actionType = hit[3];     // 可能的动作类型
                                    const healFlag = hit[4];       // 可能的治疗标识
                                    const elementType = hit[7];    // 可能的元素类型
                                    const targetType = hit[10];    // 可能的目标类型
                                    
                                    // 检查治疗标识
                                    let isHealing = healFlag !== undefined && healFlag !== null && healFlag !== 0;
                                    
                                    const damage = isHealing ? 0 : Math.abs(rawValue);
                                    const healing = isHealing ? Math.abs(rawValue) : 0;
                                    
                                    // 详细调试输出，帮助分析数据结构
                                    if (rawValue !== 0) {
                                        logger.debug(`Hit detailed data: skill=${skill}, value=${value}, luckyValue=${luckyValue}, damageType=${damageType}, actionType=${actionType}, healFlag=${healFlag}, elementType=${elementType}, targetType=${targetType}, rawValue=${rawValue}, isHealing=${isHealing}`);
                                    }
                                    
                                    const is_player = (BigInt(hit[21] || hit[11]) & 0xffffn) === 640n;
                                    if (!is_player) break; // 排除怪物攻击
                                    
                                    const operator_uid = BigInt(hit[21] || hit[11]) >> 16n;
                                    if (!operator_uid) break;
                                    
                                    // 初始化伤害数据结构
                                    if (!total_damage[operator_uid]) {
                                        total_damage[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            crit_lucky: 0,
                                            hpLessen: 0,
                                            total: 0,
                                        };
                                    }
                                    
                                    if (!total_count[operator_uid]) {
                                        total_count[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            total: 0,
                                        };
                                    }
                                    
                                    // 初始化治疗数据结构
                                    if (!total_healing[operator_uid]) {
                                        total_healing[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            crit_lucky: 0,
                                            total: 0,
                                        };
                                    }
                                    
                                    if (!healing_count[operator_uid]) {
                                        healing_count[operator_uid] = {
                                            normal: 0,
                                            critical: 0,
                                            lucky: 0,
                                            total: 0,
                                        };
                                    }
                                    
                                    // 确保所有伤害字段都存在
                                    if (typeof total_damage[operator_uid].normal === 'undefined') total_damage[operator_uid].normal = 0;
                                    if (typeof total_damage[operator_uid].critical === 'undefined') total_damage[operator_uid].critical = 0;
                                    if (typeof total_damage[operator_uid].lucky === 'undefined') total_damage[operator_uid].lucky = 0;
                                    if (typeof total_damage[operator_uid].crit_lucky === 'undefined') total_damage[operator_uid].crit_lucky = 0;
                                    if (typeof total_damage[operator_uid].hpLessen === 'undefined') total_damage[operator_uid].hpLessen = 0;
                                    if (typeof total_damage[operator_uid].total === 'undefined') total_damage[operator_uid].total = 0;
                                    
                                    if (typeof total_count[operator_uid].normal === 'undefined') total_count[operator_uid].normal = 0;
                                    if (typeof total_count[operator_uid].critical === 'undefined') total_count[operator_uid].critical = 0;
                                    if (typeof total_count[operator_uid].lucky === 'undefined') total_count[operator_uid].lucky = 0;
                                    if (typeof total_count[operator_uid].total === 'undefined') total_count[operator_uid].total = 0;
                                    
                                    // 确保所有治疗字段都存在
                                    if (typeof total_healing[operator_uid].normal === 'undefined') total_healing[operator_uid].normal = 0;
                                    if (typeof total_healing[operator_uid].critical === 'undefined') total_healing[operator_uid].critical = 0;
                                    if (typeof total_healing[operator_uid].lucky === 'undefined') total_healing[operator_uid].lucky = 0;
                                    if (typeof total_healing[operator_uid].crit_lucky === 'undefined') total_healing[operator_uid].crit_lucky = 0;
                                    if (typeof total_healing[operator_uid].total === 'undefined') total_healing[operator_uid].total = 0;
                                    
                                    if (typeof healing_count[operator_uid].normal === 'undefined') healing_count[operator_uid].normal = 0;
                                    if (typeof healing_count[operator_uid].critical === 'undefined') healing_count[operator_uid].critical = 0;
                                    if (typeof healing_count[operator_uid].lucky === 'undefined') healing_count[operator_uid].lucky = 0;
                                    if (typeof healing_count[operator_uid].total === 'undefined') healing_count[operator_uid].total = 0;
                                    
                                    // 计算伤害统计
                                    if (damage > 0) {
                                        if (isCrit) {
                                            total_count[operator_uid].critical++;
                                            if (luckyValue) {
                                                total_damage[operator_uid].crit_lucky += damage;
                                                total_count[operator_uid].lucky++;
                                            } else {
                                                total_damage[operator_uid].critical += damage;
                                            }
                                        } else if (luckyValue) {
                                            total_damage[operator_uid].lucky += damage;
                                            total_count[operator_uid].lucky++;
                                        } else {
                                            total_damage[operator_uid].normal += damage;
                                            total_count[operator_uid].normal++;
                                        }
                                        
                                        total_damage[operator_uid].total += damage;
                                        total_damage[operator_uid].hpLessen += hpLessenValue;
                                        total_count[operator_uid].total++;
                                    }
                                    
                                    // 计算治疗统计
                                    if (healing > 0) {
                                        if (isCrit) {
                                            healing_count[operator_uid].critical++;
                                            if (luckyValue) {
                                                total_healing[operator_uid].crit_lucky += healing;
                                                healing_count[operator_uid].lucky++;
                                            } else {
                                                total_healing[operator_uid].critical += healing;
                                            }
                                        } else if (luckyValue) {
                                            total_healing[operator_uid].lucky += healing;
                                            healing_count[operator_uid].lucky++;
                                        } else {
                                            total_healing[operator_uid].normal += healing;
                                            healing_count[operator_uid].normal++;
                                        }
                                        
                                        total_healing[operator_uid].total += healing;
                                        healing_count[operator_uid].total++;
                                    }
                                    
                                    // DPS窗口数据
                    if (!dps_window[operator_uid]) dps_window[operator_uid] = [];
                    dps_window[operator_uid].push({
                        time: Date.now(),
                        damage,
                    });
                    
                    // HPS窗口数据
                    if (healing > 0) {
                        if (!hps_window[operator_uid]) hps_window[operator_uid] = [];
                        hps_window[operator_uid].push({
                            time: Date.now(),
                            healing,
                        });
                    }
                                    
                                    // 治疗时间统计
                                    if (healing > 0) {
                                        if (!healing_time[operator_uid]) healing_time[operator_uid] = [];
                                        if (healing_time[operator_uid][0]) {
                                            healing_time[operator_uid][1] = Date.now();
                                        } else {
                                            healing_time[operator_uid][0] = Date.now();
                                        }
                                    }
                                    
                                    // 记录时间
                                    if (!damage_time[operator_uid]) damage_time[operator_uid] = [];
                                    if (damage_time[operator_uid][0]) {
                                        damage_time[operator_uid][1] = Date.now();
                                    } else {
                                        damage_time[operator_uid][0] = Date.now();
                                    }
                                    
                                    let extra = [];
                                    if (isCrit) extra.push('Critical');
                    if (luckyValue) extra.push('Lucky');
                    if (extra.length === 0) extra = ['Normal'];
                                    
                                    if (damage > 0) {
                        logger.info(`User: ${operator_uid} Skill: ${skill} Damage: ${damage} HP Reduced: ${hpLessenValue} Type: ${extra.join('|')}`);
                    }
                    if (healing > 0) {
                        logger.info(`User: ${operator_uid} Skill: ${skill} Healing: ${healing} Type: ${extra.join('|')}`);
                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    logger.debug(e);
                    logger.debug(data1.subarray(18).toString('hex'));
                }
            } while (data1 && data1.length);
        }
    } catch (e) {
        logger.debug(e);
    }
}

// 清理TCP缓存
function clearTcpCache() {
    _data = Buffer.alloc(0);
    tcp_next_seq = -1;
    tcp_last_time = 0;
    tcp_cache = {};
    tcp_cache_size = 0;
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
        const c = new Cap();
        const filter = 'ip and tcp';
        const bufSize = 10 * 1024 * 1024;
        const buffer = Buffer.alloc(65535);
        
        const linkType = c.open(device.name, filter, bufSize, buffer);
        c.setMinBytes && c.setMinBytes(0);

        logger.info(`Starting packet capture on device: ${device.description}`);
        isCapturing = true;
        
        // 确保先停止之前的定时器，再启动新的定时器
        stopDataUpdateTimers();
        startDataUpdateTimers();

        // 通知主窗口状态更新
        if (mainWindow) {
            mainWindow.webContents.send('capture-status-changed', {
                isCapturing: true,
                selectedDevice: device.description
            });
        }

        c.on('packet', async function (nbytes, trunc) {
            const buffer1 = Buffer.from(buffer);
            
            if (linkType === 'ETHERNET') {
                var ret = decoders.Ethernet(buffer1);
                
                if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
                    ret = decoders.IPV4(buffer1, ret.offset);
                    const srcaddr = ret.info.srcaddr;
                    const dstaddr = ret.info.dstaddr;
                    
                    if (ret.info.protocol === PROTOCOL.IP.TCP) {
                        var datalen = ret.info.totallen - ret.hdrlen;
                        ret = decoders.TCP(buffer1, ret.offset);
                        
                        const srcport = ret.info.srcport;
                        const dstport = ret.info.dstport;
                        const src_server = `${srcaddr}:${srcport} -> ${dstaddr}:${dstport}`;
                        
                        datalen -= ret.hdrlen;
                        let buf = Buffer.from(buffer1.subarray(ret.offset, ret.offset + datalen));
                        
                        if (tcp_last_time && Date.now() - tcp_last_time > 30000) {
                            logger.warn('无法捕获下一个包! 游戏是否关闭或断线? seq: ' + tcp_next_seq);
                            current_server = '';
                            clearTcpCache();
                        }
                        
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
                                            
                                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]);
                                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;
                                            
                                            try {
                                                let body = pb.decode(data1.subarray(18)) || {};
                                                if (current_server !== src_server) {
                                                    current_server = src_server;
                                                    clearTcpCache();
                                                    logger.info('Scene server address obtained: ' + src_server);
                                                }
                                                
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
                        
                        // TCP包重组处理
                        await tcp_lock.acquire();
                        
                        if (tcp_next_seq === -1 && buf.length > 4 && buf.readUInt32BE() < 999999) {
                            tcp_next_seq = ret.info.seqno;
                        }
                        
                        //logger.debug('TCP next seq: ' + tcp_next_seq);
                        tcp_cache[ret.info.seqno] = buf;
                        tcp_cache_size++;
                        
                        while (tcp_cache[tcp_next_seq]) {
                            const seq = tcp_next_seq;
                            _data = _data.length === 0 ? tcp_cache[seq] : Buffer.concat([_data, tcp_cache[seq]]);
                            tcp_next_seq = (seq + tcp_cache[seq].length) >>> 0;
                            tcp_cache[seq] = undefined;
                            tcp_cache_size--;
                            tcp_last_time = Date.now();
                            
                            setTimeout(() => {
                                if (tcp_cache[seq]) {
                                    tcp_cache[seq] = undefined;
                                    tcp_cache_size--;
                                }
                            }, 10000);
                        }
                        
                        while (_data.length > 4) {
                            let len = _data.readUInt32BE();
                            if (_data.length >= len) {
                                const packet = _data.subarray(0, len);
                                _data = _data.subarray(len);
                                processPacket(packet);
                            } else {
                                if (len > 999999) {
                                    logger.error(`无效长度!! ${_data.length},${len},${_data.toString('hex')},${tcp_next_seq}`);
                                    process.exit(1);
                                }
                                break;
                            }
                        }
                        
                        tcp_lock.release();
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
    
    // 立即发送空数据到渲染进程，清除界面显示
    const emptyData = {};
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('stats-updated', emptyData);
    }
    if (overlayWindow && overlayWindow.webContents) {
        overlayWindow.webContents.send('stats-updated', emptyData);
    }
    
    logger.info('Statistics data cleared (including damage and healing data)');
}

// 启动数据更新和清理定时器
function startDataUpdateTimers() {
    // 计算实时DPS和HPS
    statsUpdateInterval = setInterval(() => {
        // 只有在抓包状态下才更新统计数据
        if (!isCapturing) {
            return;
        }
        
        const now = Date.now();
        
        // 计算实时DPS
        for (const uid of Object.keys(dps_window)) {
            while (dps_window[uid].length > 0 && dps_window[uid][0] && dps_window[uid][0].time && now - dps_window[uid][0].time > 1000) {
                dps_window[uid].shift();
            }
            
            if (!realtime_dps[uid]) {
                realtime_dps[uid] = {
                    value: 0,
                    max: 0,
                };
            }
            
            realtime_dps[uid].value = 0;
            for (const b of dps_window[uid]) {
                realtime_dps[uid].value += b.damage;
            }
            
            if (realtime_dps[uid].value > realtime_dps[uid].max) {
                realtime_dps[uid].max = realtime_dps[uid].value;
            }
        }
        
        // 计算实时HPS
        for (const uid of Object.keys(hps_window)) {
            while (hps_window[uid].length > 0 && hps_window[uid][0] && hps_window[uid][0].time && now - hps_window[uid][0].time > 1000) {
                hps_window[uid].shift();
            }
            
            if (!realtime_hps[uid]) {
                realtime_hps[uid] = {
                    value: 0,
                    max: 0,
                };
            }
            
            realtime_hps[uid].value = 0;
            for (const h of hps_window[uid]) {
                realtime_hps[uid].value += h.healing;
            }
            
            if (realtime_hps[uid].value > realtime_hps[uid].max) {
                realtime_hps[uid].max = realtime_hps[uid].value;
            }
        }
        
        // 发送数据到渲染进程
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
                
                // 修复总DPS计算，确保时间差有效
                if (damage_time[uid] && damage_time[uid][1] && damage_time[uid][0] && damage_time[uid][1] > damage_time[uid][0]) {
                    userData[uid].total_dps = (total_damage[uid].total / (damage_time[uid][1] - damage_time[uid][0]) * 1000) || 0;
                } else {
                    userData[uid].total_dps = 0;
                }
                
                userData[uid].realtime_dps = realtime_dps[uid] ? realtime_dps[uid].value : 0;
                userData[uid].realtime_dps_max = realtime_dps[uid] ? realtime_dps[uid].max : 0;
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
                
                // 计算总HPS
                if (healing_time[uid] && healing_time[uid][1] && healing_time[uid][0] && healing_time[uid][1] > healing_time[uid][0]) {
                    userData[uid].total_hps = (total_healing[uid].total / (healing_time[uid][1] - healing_time[uid][0]) * 1000) || 0;
                } else {
                    userData[uid].total_hps = 0;
                }
                
                userData[uid].realtime_hps = realtime_hps[uid] ? realtime_hps[uid].value : 0;
                userData[uid].realtime_hps_max = realtime_hps[uid] ? realtime_hps[uid].max : 0;
            }
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
        for (const key of Object.keys(tcp_cache)) {
            if (tcp_cache[key] && tcp_cache[key].time && now - tcp_cache[key].time > maxAge) {
                delete tcp_cache[key];
                tcp_cache_size--;
            }
        }

        // 限制TCP缓存大小
        if (tcp_cache_size > 1000) {
            const keys = Object.keys(tcp_cache);
            const toDelete = keys.slice(0, tcp_cache_size - 800);
            for (const key of toDelete) {
                delete tcp_cache[key];
                tcp_cache_size--;
            }
        }

        // 清理日志缓存
        if (logQueue.length > 50) {
            logQueue = logQueue.slice(-50);
        }

        logger.debug(`Memory cleanup completed - DPS windows: ${Object.keys(dps_window).length}, HPS windows: ${Object.keys(hps_window).length}, TCP cache: ${tcp_cache_size}, Log cache: ${logQueue.length}`);
    }, 30000);
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
}

// IPC事件处理
ipcMain.handle('get-devices', () => {
    return getDeviceList();
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
        return true;
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
        overlayWindow.setAlwaysOnTop(alwaysOnTop);
    }
});

ipcMain.handle('overlay-resize', (event, { width, height }) => {
    if (overlayWindow) {
        overlayWindow.setSize(width, height);
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
            
            // 修复总DPS计算，确保时间差有效
            if (damage_time[uid] && damage_time[uid][1] && damage_time[uid][0] && damage_time[uid][1] > damage_time[uid][0]) {
                userData[uid].total_dps = (total_damage[uid].total / (damage_time[uid][1] - damage_time[uid][0]) * 1000) || 0;
            } else {
                userData[uid].total_dps = 0;
            }
            
            userData[uid].realtime_dps = realtime_dps[uid] ? realtime_dps[uid].value : 0;
            userData[uid].realtime_dps_max = realtime_dps[uid] ? realtime_dps[uid].max : 0;
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
            
            // 计算总HPS
            if (healing_time[uid] && healing_time[uid][1] && healing_time[uid][0] && healing_time[uid][1] > healing_time[uid][0]) {
                userData[uid].total_hps = (total_healing[uid].total / (healing_time[uid][1] - healing_time[uid][0]) * 1000) || 0;
            } else {
                userData[uid].total_hps = 0;
            }
            
            userData[uid].realtime_hps = realtime_hps[uid] ? realtime_hps[uid].value : 0;
            userData[uid].realtime_hps_max = realtime_hps[uid] ? realtime_hps[uid].max : 0;
        }
    }
    
    return userData;
});

ipcMain.handle('get-overlay-status', () => {
    return overlayEnabled;
});

ipcMain.handle('get-player-uid', () => {
    return user_uid ? user_uid.toString() : null;
});

ipcMain.handle('toggle-self-only-mode', (event, enabled) => {
    selfOnlyMode = enabled;
    // 通知悬浮窗切换模式
    if (overlayWindow && overlayWindow.webContents) {
        overlayWindow.webContents.send('self-only-mode-changed', enabled);
    }
    logger.info(`Self-only mode ${enabled ? 'enabled' : 'disabled'}`);
    return enabled;
});

// 应用事件
app.whenReady().then(() => {
    createWindow();
    // 自动创建悬浮窗，这样用户就能看到UID更新
    setTimeout(() => {
        try {
            createOverlayWindow();
            logger.info('Auto-created overlay window on startup');
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
    // 不在应用启动时自动启动定时器，而是在开始抓包时启动
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (isCapturing) {
            stopCapture();
        }
        stopDataUpdateTimers();
        app.quit();
    }
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