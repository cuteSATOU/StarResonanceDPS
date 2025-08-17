const os = require('os');
const { exec } = require('child_process');

async function findDefaultNetworkDevice(devices) {
    try {
        // 在Windows上使用route命令查找默认网关
        const stdout = await new Promise((resolve, reject) => {
            const command = os.platform() === 'win32' ? 'route print 0.0.0.0' : 'route -n get default';
            exec(command, (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            });
        });

        let defaultInterface = null;

        if (os.platform() === 'win32') {
            // Windows: 查找默认路由对应的接口IP
            const defaultRoute = stdout
                .split('\n')
                .find((line) => line.trim().startsWith('0.0.0.0'));
            
            if (defaultRoute) {
                const parts = defaultRoute.trim().split(/\s+/);
                defaultInterface = parts[3]; // 网关IP对应的接口IP
            }
        } else {
            // macOS/Linux: 解析route命令输出
            const interfaceLine = stdout
                .split('\n')
                .find((line) => line.includes('interface:'));
            
            if (interfaceLine) {
                defaultInterface = interfaceLine.split(':')[1]?.trim();
            }
        }

        if (!defaultInterface) {
            // 备用方案：使用Node.js的os.networkInterfaces()
            const networkInterfaces = os.networkInterfaces();
            
            // 找到第一个有效的非内网IP接口
            for (const [name, interfaces] of Object.entries(networkInterfaces)) {
                if (name.toLowerCase().includes('loopback')) continue;
                
                const validInterface = interfaces.find(iface => 
                    !iface.internal && 
                    iface.family === 'IPv4' &&
                    !iface.address.startsWith('169.254.') // 排除APIPA地址
                );
                
                if (validInterface) {
                    // 在设备列表中查找匹配的设备
                    const targetDevice = Object.entries(devices).find(([deviceName, device]) => {
                        return device.addresses && device.addresses.some(addr => 
                            addr.addr === validInterface.address
                        );
                    });
                    
                    if (targetDevice) {
                        return targetDevice[0];
                    }
                }
            }
            
            return undefined;
        }

        // 在设备列表中查找匹配默认接口IP的设备
        const targetInterface = Object.entries(devices).find(([deviceName, device]) => {
            return device.addresses && device.addresses.some(address => 
                address.addr === defaultInterface
            );
        })?.[0];

        return targetInterface;
    } catch (error) {
        console.warn('自动检测网络设备失败:', error.message);
        
        // 最后的备用方案：选择第一个有活动IP地址的设备
        try {
            const deviceWithIP = Object.entries(devices).find(([deviceName, device]) => {
                return device.addresses && device.addresses.length > 0 && 
                       device.addresses.some(addr => 
                           addr.addr && 
                           !addr.addr.startsWith('127.') && // 排除localhost
                           !addr.addr.startsWith('169.254.') // 排除APIPA
                       );
            });
            
            return deviceWithIP ? deviceWithIP[0] : undefined;
        } catch (fallbackError) {
            return undefined;
        }
    }
}

module.exports = findDefaultNetworkDevice;
