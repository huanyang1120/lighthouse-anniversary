const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'wishes.json');

// 中间件配置
app.use(express.json());
app.use(express.static(__dirname));

// 存储所有约定的数组
let wishes = [];

// 初始化数据文件
async function initializeData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        wishes = JSON.parse(data);
        console.log(`已加载 ${wishes.length} 个约定`);
    } catch (error) {
        console.log('未找到数据文件，创建新文件');
        wishes = [];
        await saveData();
    }
}

// 保存数据到文件
async function saveData() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(wishes, null, 2));
        console.log(`已保存 ${wishes.length} 个约定到文件`);
    } catch (error) {
        console.error('保存数据失败:', error);
    }
}

// WebSocket连接管理
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('新客户端连接，当前连接数:', clients.size);
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log('客户端断开连接，当前连接数:', clients.size);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
        clients.delete(ws);
    });
});

// 广播新约定给所有连接的客户端
function broadcastNewWish(wish) {
    const message = JSON.stringify({
        type: 'new_wish',
        wish: wish
    });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                console.error('发送消息失败:', error);
                clients.delete(client);
            }
        }
    });
}

// API路由

// 获取所有约定
app.get('/api/wishes', (req, res) => {
    res.json(wishes);
});

// 提交新约定
app.post('/api/submit-wish', async (req, res) => {
    try {
        const { name, wish } = req.body;
        
        // 验证输入
        if (!name || !wish) {
            return res.status(400).json({ error: '姓名和约定不能为空' });
        }
        
        if (name.length > 50) {
            return res.status(400).json({ error: '姓名不能超过50个字符' });
        }
        
        if (wish.length > 500) {
            return res.status(400).json({ error: '约定不能超过500个字符' });
        }
        
        // 创建新约定对象
        const newWish = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            name: name.trim(),
            wish: wish.trim(),
            timestamp: new Date().toISOString(),
            ip: req.ip || req.connection.remoteAddress
        };
        
        // 添加到约定列表
        wishes.push(newWish);
        
        // 保存到文件
        await saveData();
        
        // 广播给所有连接的客户端
        broadcastNewWish(newWish);
        
        console.log(`收到新约定: ${newWish.name} - ${newWish.wish.substring(0, 50)}...`);
        
        res.json({ 
            success: true, 
            message: '约定提交成功',
            id: newWish.id
        });
        
    } catch (error) {
        console.error('提交约定失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// 生成二维码
app.get('/api/qrcode', async (req, res) => {
    try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const qrCodeData = await QRCode.toDataURL(baseUrl);
        
        res.json({
            success: true,
            qrcode: qrCodeData,
            url: baseUrl
        });
    } catch (error) {
        console.error('生成二维码失败:', error);
        res.status(500).json({ error: '生成二维码失败' });
    }
});

// 获取统计信息
app.get('/api/stats', (req, res) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const todayWishes = wishes.filter(wish => 
        new Date(wish.timestamp) >= today
    );
    
    // 分析热门关键词
    const wordFrequency = {};
    const stopWords = new Set(['的', '在', '和', '是', '我', '了', '有', '就', '都', '会', '说', '他', '她', '它', '这', '那', '一个', '能够', '可以', '希望', '愿望', '祝福']);
    
    wishes.forEach(wish => {
        const words = wish.wish.match(/[\u4e00-\u9fa5]{2,}/g) || [];
        words.forEach(word => {
            if (!stopWords.has(word) && word.length >= 2) {
                wordFrequency[word] = (wordFrequency[word] || 0) + 1;
            }
        });
    });
    
    const topWords = Object.entries(wordFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));
    
    res.json({
        total: wishes.length,
        today: todayWishes.length,
        topWords: topWords,
        recentWishes: wishes.slice(-5).reverse()
    });
});

// 管理员页面 - 获取所有约定（带分页）
app.get('/api/admin/wishes', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const paginatedWishes = wishes
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(startIndex, endIndex);
    
    res.json({
        wishes: paginatedWishes,
        total: wishes.length,
        page: page,
        totalPages: Math.ceil(wishes.length / limit)
    });
});

// 删除约定（管理员功能）
app.delete('/api/admin/wishes/:id', async (req, res) => {
    try {
        const wishId = req.params.id;
        const initialLength = wishes.length;
        
        wishes = wishes.filter(wish => wish.id !== wishId);
        
        if (wishes.length < initialLength) {
            await saveData();
            res.json({ success: true, message: '约定已删除' });
        } else {
            res.status(404).json({ error: '未找到指定的约定' });
        }
    } catch (error) {
        console.error('删除约定失败:', error);
        res.status(500).json({ error: '删除失败' });
    }
});

// 路由处理
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'display.html'));
});

app.get('/qrcode', (req, res) => {
    res.sendFile(path.join(__dirname, 'qrcode.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// 404处理
app.use((req, res) => {
    res.status(404).json({ error: '页面未找到' });
});

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('服务器错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
async function startServer() {
    try {
        await initializeData();
        
        server.listen(PORT, () => {
            console.log(`🚀 Lighthouse周年庆系统启动成功!`);
            console.log(`📱 手机端访问: http://localhost:${PORT}`);
            console.log(`🖥️  大屏展示: http://localhost:${PORT}/display`);
            console.log(`⚙️  管理后台: http://localhost:${PORT}/admin`);
            console.log(`📊 当前已有 ${wishes.length} 个约定`);
        });
        
        // 优雅关闭
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);
        
    } catch (error) {
        console.error('启动服务器失败:', error);
        process.exit(1);
    }
}

function gracefulShutdown() {
    console.log('\n正在关闭服务器...');
    
    // 关闭所有WebSocket连接
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close();
        }
    });
    
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
}

startServer();

module.exports = app;
