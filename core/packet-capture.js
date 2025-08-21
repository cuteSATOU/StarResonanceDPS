const cap = require('cap');
const zlib = require('zlib');
const PacketProcessor = require('../algo/packet');
const findDefaultNetworkDevice = require('../algo/netInterfaceUtil');
const { Lock } = require('./data-manager');
const Readable = require('stream').Readable;

const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;

class PacketCapture {
    constructor(logger, userDataManager) {
        this.logger = logger;
        this.userDataManager = userDataManager;
        this.isPaused = false;
        
        // TCP重组相关
        this.current_server = '';
        this._data = Buffer.alloc(0);
        this.tcp_next_seq = -1;
        this.tcp_cache = new Map();
        this.tcp_last_time = 0;
        this.tcp_lock = new Lock();
        
        // IP分片缓存
        this.fragmentIpCache = new Map();
        this.FRAGMENT_TIMEOUT = 30000;
        
        // 网络设备相关
        this.devices = cap.deviceList();
        this.c = null;
        this.eth_queue = [];
        
        // 定时器
        this.realtimeDpsTimer = null;
        this.fragmentCleanupTimer = null;
    }

    async selectDevice(deviceNumber) {
        if (deviceNumber === 'auto') {
            this.logger.info('Auto detecting default network interface...');
            const device_num = await findDefaultNetworkDevice(this.devices);
            if (device_num !== null) {
                deviceNumber = device_num;
                this.logger.info(`Using network interface: ${deviceNumber} - ${this.devices[deviceNumber].description}`);
            } else {
                throw new Error('Default network interface not found!');
            }
        }

        if (!this.devices[deviceNumber]) {
            throw new Error(`Cannot find device ${deviceNumber}!`);
        }

        return deviceNumber;
    }

    clearTcpCache() {
        this._data = Buffer.alloc(0);
        this.tcp_next_seq = -1;
        this.tcp_last_time = 0;
        this.tcp_cache.clear();
    }

    getTCPPacket(frameBuffer, ethOffset) {
        const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
        const ipId = ipPacket.info.id;
        const isFragment = (ipPacket.info.flags & 0x1) !== 0;
        const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
        const now = Date.now();

        if (isFragment || ipPacket.info.fragoffset > 0) {
            if (!this.fragmentIpCache.has(_key)) {
                this.fragmentIpCache.set(_key, {
                    fragments: [],
                    timestamp: now,
                });
            }

            const cacheEntry = this.fragmentIpCache.get(_key);
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
                this.logger.error(`Can't find fragments for ${_key}`);
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
                    payload: payload,
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

            this.fragmentIpCache.delete(_key);
            return fullPayload;
        }

        return Buffer.from(frameBuffer.subarray(ipPacket.offset, ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen)));
    }

    async processEthPacket(frameBuffer) {
        var ethPacket = decoders.Ethernet(frameBuffer);

        if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ipPacket = decoders.IPV4(frameBuffer, ethPacket.offset);
        const srcaddr = ipPacket.info.srcaddr;
        const dstaddr = ipPacket.info.dstaddr;

        const tcpBuffer = this.getTCPPacket(frameBuffer, ethPacket.offset);
        if (tcpBuffer === null) return;
        const tcpPacket = decoders.TCP(tcpBuffer);

        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));

        const srcport = tcpPacket.info.srcport;
        const dstport = tcpPacket.info.dstport;
        const src_server = srcaddr + ':' + srcport + ' -> ' + dstaddr + ':' + dstport;

        await this.tcp_lock.acquire();
        if (this.current_server !== src_server) {
            try {
                //尝试通过小包识别服务器
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
                                if (this.current_server !== src_server) {
                                    this.current_server = src_server;
                                    this.clearTcpCache();
                                    this.tcp_next_seq = tcpPacket.info.seqno + buf.length;
                                    this.logger.info('Got Scene Server Address: ' + src_server);
                                }
                            } catch (e) {}
                        } while (data1 && data1.length);
                    }
                }
                //尝试通过登录返回包识别服务器(仍需测试)
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
                    if (
                        Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0
                    ) {
                        if (this.current_server !== src_server) {
                            this.current_server = src_server;
                            this.clearTcpCache();
                            this.tcp_next_seq = tcpPacket.info.seqno + buf.length;
                            this.logger.info('Got Scene Server Address by Login Return Packet: ' + src_server);
                        }
                    }
                }
            } catch (e) {}
            this.tcp_lock.release();
            return;
        }

        //这里已经是识别到的服务器的包了
        if (this.tcp_next_seq === -1) {
            this.logger.error('Unexpected TCP capture error! tcp_next_seq is -1');
            if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                this.tcp_next_seq = tcpPacket.info.seqno;
            }
        }

        if ((this.tcp_next_seq - tcpPacket.info.seqno) << 0 <= 0 || this.tcp_next_seq === -1) {
            this.tcp_cache.set(tcpPacket.info.seqno, buf);
        }
        while (this.tcp_cache.has(this.tcp_next_seq)) {
            const seq = this.tcp_next_seq;
            const cachedTcpData = this.tcp_cache.get(seq);
            this._data = this._data.length === 0 ? cachedTcpData : Buffer.concat([this._data, cachedTcpData]);
            this.tcp_next_seq = (seq + cachedTcpData.length) >>> 0; //uint32
            this.tcp_cache.delete(seq);
            this.tcp_last_time = Date.now();
        }

        while (this._data.length > 4) {
            let packetSize = this._data.readUInt32BE();

            if (this._data.length < packetSize) break;

            if (this._data.length >= packetSize) {
                const packet = this._data.subarray(0, packetSize);
                this._data = this._data.subarray(packetSize);
                const processor = new PacketProcessor({ logger: this.logger, userDataManager: this.userDataManager });
                if (!this.isPaused) processor.processPacket(packet);
            } else if (packetSize > 0x0fffff) {
                this.logger.error(`Invalid Length!! ${this._data.length},${packetSize},${this._data.toString('hex')},${this.tcp_next_seq}`);
                process.exit(1);
                break;
            }
        }
        this.tcp_lock.release();
    }

    async startCapture(deviceNumber) {
        // 检查zstd支持
        if (!zlib.zstdDecompressSync) {
            throw new Error('zstdDecompressSync is not available! Please update your Node.js!');
        }

        const selectedDevice = await this.selectDevice(deviceNumber);
        
        this.c = new Cap();
        const device = this.devices[selectedDevice].name;
        const filter = 'ip and tcp';
        const bufSize = 10 * 1024 * 1024;
        const buffer = Buffer.alloc(65535);
        
        const linkType = this.c.open(device, filter, bufSize, buffer);
        if (linkType !== 'ETHERNET') {
            throw new Error('The device seems to be WRONG! Please check the device! Device type: ' + linkType);
        }
        
        this.c.setMinBytes && this.c.setMinBytes(0);
        this.c.on('packet', (nbytes, trunc) => {
            this.eth_queue.push(Buffer.from(buffer.subarray(0, nbytes)));
        });

        // 开始处理队列
        this.startPacketProcessing();
        
        // 启动定时器
        this.startTimers();
        
        this.logger.info('Welcome!');
        this.logger.info('Attempting to find the game server, please wait!');
    }

    startPacketProcessing() {
        (async () => {
            while (true) {
                if (this.eth_queue.length) {
                    const pkt = this.eth_queue.shift();
                    await this.processEthPacket(pkt);
                } else {
                    await new Promise((r) => setTimeout(r, 1));
                }
            }
        })();
    }

    startTimers() {
        // 瞬时DPS更新
        this.realtimeDpsTimer = setInterval(() => {
            if (!this.isPaused) {
                this.userDataManager.updateAllRealtimeDps();
            }
        }, 100);

        // 定时清理过期的IP分片缓存
        this.fragmentCleanupTimer = setInterval(() => {
            const now = Date.now();
            let clearedFragments = 0;
            for (const [key, cacheEntry] of this.fragmentIpCache) {
                if (now - cacheEntry.timestamp > this.FRAGMENT_TIMEOUT) {
                    this.fragmentIpCache.delete(key);
                    clearedFragments++;
                }
            }
            if (clearedFragments > 0) {
                this.logger.debug(`Cleared ${clearedFragments} expired IP fragment caches`);
            }

            if (this.tcp_last_time && Date.now() - this.tcp_last_time > this.FRAGMENT_TIMEOUT) {
                this.logger.warn('Cannot capture the next packet! Is the game closed or disconnected? seq: ' + this.tcp_next_seq);
                this.current_server = '';
                this.clearTcpCache();
            }
        }, 10000);
    }

    pause() {
        this.isPaused = true;
    }

    resume() {
        this.isPaused = false;
    }

    getPausedState() {
        return this.isPaused;
    }

    destroy() {
        if (this.realtimeDpsTimer) {
            clearInterval(this.realtimeDpsTimer);
        }
        if (this.fragmentCleanupTimer) {
            clearInterval(this.fragmentCleanupTimer);
        }
        if (this.c) {
            this.c.close && this.c.close();
        }
    }

    getDevices() {
        return this.devices;
    }
}

module.exports = PacketCapture;
