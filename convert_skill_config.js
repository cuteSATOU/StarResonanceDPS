const fs = require('fs');
const path = require('path');

// 读取原始JSON文件
const jsonPath = path.join(__dirname, 'skill_config.json');
const jsPath = path.join(__dirname, './src/skill_config.js');

try {
    // 读取JSON文件
    const jsonData = fs.readFileSync(jsonPath, 'utf8');
    const skillConfig = JSON.parse(jsonData);
    
    // 生成JS文件内容
    const jsContent = `// 技能配置数据
// 自动从 skill_config.json 转换生成

const skillConfig = ${JSON.stringify(skillConfig, null, 2)};

module.exports = skillConfig;
`;
    
    // 写入JS文件
    fs.writeFileSync(jsPath, jsContent, 'utf8');
    
    console.log('转换完成！');
    console.log(`技能总数: ${Object.keys(skillConfig.skills).length}`);
    console.log('已生成 skill_config.js 文件');
    
} catch (error) {
    console.error('转换失败:', error.message);
}