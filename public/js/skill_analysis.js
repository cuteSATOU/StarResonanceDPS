let skillChart1 = null;
let skillChart2 = null;
let currentUserId = null;

// 初始化
function initialize() {
    console.log('技能分析窗口初始化...');

    // 监听来自主进程的初始化消息
    if (window.electronAPI && window.electronAPI.onInitSkillAnalysis) {
        window.electronAPI.onInitSkillAnalysis((uid) => {
            console.log('收到用户ID:', uid);
            currentUserId = uid;
            loadSkillData(uid);
        });
    } else {
        console.error('electronAPI 或 onInitSkillAnalysis 不可用');
    }

    // 窗口控制按钮
    initWindowControls();
}

// 加载技能数据
async function loadSkillData(userId) {
    try {
        console.log('正在加载用户', userId, '的技能数据...');
        const data = await window.electronAPI.getSkillData(userId);

        if (data.code === 0) {
            renderSkillData(data.data);
        } else {
            showError('获取技能数据失败: ' + data.msg);
        }
    } catch (error) {
        console.error('获取技能数据失败:', error);
        showError('获取技能数据失败: ' + error.message);
    }
}

// 渲染技能数据
function renderSkillData(skillData) {
    console.log('渲染技能数据:', skillData);

    // 更新标题
    const titleText = document.getElementById('titleText');
    const userName = skillData.name || `UID:${skillData.uid}`;
    titleText.textContent = `${userName} - 技能分析`;

    // 渲染用户信息
    renderUserInfo(skillData);

    // 渲染图表
    renderCharts(skillData);

    // 渲染表格
    renderTable(skillData);

    // 显示图表和表格
    document.getElementById('chartsGrid').style.display = 'grid';
    document.getElementById('tableCard').style.display = 'block';
}

// 渲染用户信息
function renderUserInfo(skillData) {
    const userInfoCard = document.getElementById('userInfoCard');
    userInfoCard.innerHTML = `
                <div class="user-info-item">
                    <div class="user-info-label">用户ID</div>
                    <div class="user-info-value">${skillData.uid}</div>
                </div>
                <div class="user-info-item">
                    <div class="user-info-label">角色昵称</div>
                    <div class="user-info-value">${skillData.name || '未知'}</div>
                </div>
                <div class="user-info-item">
                    <div class="user-info-label">职业</div>
                    <div class="user-info-value">${skillData.profession || '未知'}</div>
                </div>
                <div class="user-info-item">
                    <div class="user-info-label">生体元等级</div>
                    <div class="user-info-value">${skillData.attr?.level || '未知'}</div>
                </div>
                <div class="user-info-item">
                    <div class="user-info-label">臂章等级</div>
                    <div class="user-info-value">${skillData.attr?.rank_level || '未知'}</div>
                </div>
                <div class="user-info-item">
                    <div class="user-info-label">技能数量</div>
                    <div class="user-info-value">${Object.keys(skillData.skills).length}</div>
                </div>
            `;
}

// 渲染图表
function renderCharts(skillData) {
    const skills = Object.entries(skillData.skills);
    const sortedSkills = skills.slice().sort(([, a], [, b]) => b.totalDamage - a.totalDamage);

    const skillNames = [];
    const damages = [];
    const critRates = [];
    const luckyRates = [];

    sortedSkills.forEach(([skillId, skill]) => {
        const name = skill.displayName || skillId;
        skillNames.push(name);
        damages.push(skill.totalDamage);
        critRates.push(skill.critRate * 100);
        luckyRates.push(skill.luckyRate * 100);
    });

    renderSkillCharts(skillNames, damages, critRates, luckyRates);
}

// 渲染表格
function renderTable(skillData) {
    const skills = Object.entries(skillData.skills);
    const sortedSkills = skills.slice().sort(([, a], [, b]) => b.totalDamage - a.totalDamage);

    const tableBody = document.getElementById('skillTableBody');
    tableBody.innerHTML = '';

    sortedSkills.forEach(([skillId, skill]) => {
        const name = skill.displayName || skillId;
        const row = document.createElement('tr');
        row.innerHTML = `
                    <td>${name}</td>
                    <td>${skill.type}</td>
                    <td>${skill.elementype}</td>
                    <td>${skill.totalDamage.toLocaleString()}</td>
                    <td>${skill.totalCount}</td>
                    <td class="skill-crit">${(skill.critRate * 100).toFixed(2)}%</td>
                    <td class="skill-lucky">${(skill.luckyRate * 100).toFixed(2)}%</td>
                    <td>${(skill.damageBreakdown.critical + skill.damageBreakdown.crit_lucky).toLocaleString()}</td>
                    <td>${(skill.damageBreakdown.normal + skill.damageBreakdown.lucky).toLocaleString()}</td>
                `;
        tableBody.appendChild(row);
    });
}

// 渲染技能图表
function renderSkillCharts(skillIds, damages, critRates, luckyRates) {
    const topNames = skillIds.slice(0, 5);
    const topDamages = damages.slice(0, 5);
    const topAllDamages = topDamages.reduce((a, b) => a + b, 0);
    const allDamages = damages.reduce((a, b) => a + b, 0);
    const otherDamages = allDamages - topAllDamages;

    const pieData = topNames.map((name, idx) => ({
        value: topDamages[idx],
        name: name,
        label: {
            show: true,
            position: 'outside',
            formatter: '{b}\n{d}%',
        },
        labelLine: {
            show: true,
        },
    }));

    if (otherDamages > 0) {
        pieData.push({
            value: otherDamages,
            name: '其他',
            label: {
                show: true,
                position: 'outside',
                formatter: '{b}\n{d}%',
            },
            labelLine: {
                show: true,
            },
        });
    }

    // 销毁现有图表
    if (skillChart1) skillChart1.dispose();
    if (skillChart2) skillChart2.dispose();

    // 创建新的图表实例
    skillChart1 = echarts.init(document.getElementById('skillDamageChart'));
    skillChart2 = echarts.init(document.getElementById('skillCritChart'));

    // 技能数值分布图
    const damageOption = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: '{b}: {c} ({d}%)',
            backgroundColor: 'rgba(50, 50, 50, 0.9)',
            borderColor: '#777',
            borderWidth: 1,
            textStyle: {
                color: '#fff',
                fontSize: 12,
            },
        },
        legend: {
            orient: 'vertical',
            right: '5%',
            top: 'center',
            textStyle: {
                color: 'var(--text-primary)',
                fontSize: 12,
            },
            itemWidth: 14,
            itemHeight: 14,
        },
        grid: {
            left: '10%',
            right: '35%',
            top: '10%',
            bottom: '10%',
            containLabel: true,
        },
        series: [
            {
                name: '技能数值',
                type: 'pie',
                radius: ['45%', '75%'],
                center: ['40%', '50%'],
                avoidLabelOverlap: true,
                itemStyle: {
                    borderRadius: 8,
                    borderColor: '#fff',
                    borderWidth: 2,
                },
                label: {
                    show: true,
                    position: 'outside',
                    formatter: '{b}\n{d}%',
                    fontSize: 11,
                    color: 'var(--text-primary)',
                },
                labelLine: {
                    show: true,
                    length: 15,
                    length2: 10,
                    smooth: true,
                },
                emphasis: {
                    itemStyle: {
                        shadowBlur: 10,
                        shadowOffsetX: 0,
                        shadowColor: 'rgba(0, 0, 0, 0.5)',
                    },
                },
                data: pieData,
            },
        ],
    };

    // 暴击率/幸运触发率对比图
    const critOption = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            axisPointer: {
                type: 'shadow',
                shadowStyle: {
                    color: 'rgba(150, 150, 150, 0.1)',
                },
            },
            backgroundColor: 'rgba(50, 50, 50, 0.9)',
            borderColor: '#777',
            borderWidth: 1,
            textStyle: {
                color: '#fff',
                fontSize: 12,
            },
            formatter: function (params) {
                let result = `<div style="font-weight: bold; margin-bottom: 4px;">${params[0].name}</div>`;
                params.forEach((param) => {
                    result += `<div style="margin: 2px 0;">
                                <span style="display: inline-block; width: 10px; height: 10px; background: ${param.color}; border-radius: 2px; margin-right: 6px;"></span>
                                ${param.seriesName}: <span style="font-weight: bold;">${param.value.toFixed(2)}%</span>
                            </div>`;
                });
                return result;
            },
        },
        legend: {
            data: ['暴击率', '幸运触发率'],
            top: '8%',
            left: 'center',
            textStyle: {
                color: 'var(--text-primary)',
                fontSize: 12,
            },
            itemWidth: 14,
            itemHeight: 14,
        },
        grid: {
            left: '8%',
            right: '8%',
            bottom: '20%',
            top: '20%',
            containLabel: true,
        },
        xAxis: {
            type: 'category',
            data: skillIds,
            axisLine: {
                lineStyle: {
                    color: 'var(--divider-color)',
                },
            },
            axisTick: {
                lineStyle: {
                    color: 'var(--divider-color)',
                },
            },
            axisLabel: {
                color: 'var(--text-secondary)',
                fontSize: 11,
                interval: 0,
                rotate: 45,
                margin: 15,
            },
            splitLine: {
                show: false,
            },
        },
        yAxis: {
            type: 'value',
            name: '百分比 (%)',
            nameTextStyle: {
                color: 'var(--text-secondary)',
                fontSize: 12,
            },
            min: 0,
            max: 100,
            axisLine: {
                lineStyle: {
                    color: 'var(--divider-color)',
                },
            },
            axisTick: {
                lineStyle: {
                    color: 'var(--divider-color)',
                },
            },
            axisLabel: {
                color: 'var(--text-secondary)',
                fontSize: 11,
                formatter: '{value}%',
            },
            splitLine: {
                lineStyle: {
                    color: 'var(--border-color)',
                    type: 'dashed',
                },
            },
        },
        series: [
            {
                name: '暴击率',
                type: 'bar',
                data: critRates,
                itemStyle: {
                    color: '#ff9966',
                    borderRadius: [2, 2, 0, 0],
                },
                emphasis: {
                    itemStyle: {
                        color: '#ff8844',
                        shadowBlur: 10,
                        shadowColor: 'rgba(255, 153, 102, 0.5)',
                    },
                },
                barWidth: '35%',
            },
            {
                name: '幸运触发率',
                type: 'bar',
                data: luckyRates,
                itemStyle: {
                    color: '#93f9b9',
                    borderRadius: [2, 2, 0, 0],
                },
                emphasis: {
                    itemStyle: {
                        color: '#7bf59c',
                        shadowBlur: 10,
                        shadowColor: 'rgba(147, 249, 185, 0.5)',
                    },
                },
                barWidth: '35%',
            },
        ],
    };

    // 设置图表选项
    skillChart1.setOption(damageOption, true);
    skillChart2.setOption(critOption, true);

    // 确保图表正确渲染
    setTimeout(() => {
        if (skillChart1) skillChart1.resize();
        if (skillChart2) skillChart2.resize();
    }, 100);

    // 响应窗口大小变化
    const resizeHandler = function () {
        if (skillChart1) {
            skillChart1.resize();
        }
        if (skillChart2) {
            skillChart2.resize();
        }
    };

    // 移除之前的监听器以避免重复
    window.removeEventListener('resize', resizeHandler);
    window.addEventListener('resize', resizeHandler);
}

// 显示错误信息
function showError(message) {
    const userInfoCard = document.getElementById('userInfoCard');
    userInfoCard.innerHTML = `
                <div style="text-align: center; color: var(--danger-color); padding: var(--spacing-xl);">
                    <h3>❌ 错误</h3>
                    <p>${message}</p>
                </div>
            `;
}

// 窗口控制按钮功能
function initWindowControls() {
    const closeBtn = document.getElementById('closeBtn');

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.close();
        });
    }
}

// 等待DOM加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}